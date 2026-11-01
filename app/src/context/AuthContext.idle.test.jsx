import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthProvider, IDLE_TIMEOUT_MS, useAuth } from "./AuthContext.jsx";
import { supabase } from "../lib/supabase.js";
import { wizardStorageKeys } from "../components/wizardStorage.js";

vi.mock("../lib/supabase.js", () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
            onAuthStateChange: vi.fn(),
            signOut: vi.fn(),
            mfa: {
                getAuthenticatorAssuranceLevel: vi.fn(),
            },
        },
        from: vi.fn(),
    },
}));

const ACTIVITY_KEY = "ccp.lastActivity";
const MINUTE = 60 * 1000;

function makeBuilder(response) {
    const builder = {};
    ["select", "eq"].forEach((m) => {
        builder[m] = vi.fn(() => builder);
    });
    builder.single = vi.fn(() => Promise.resolve(response));
    return builder;
}

function IdleProbe() {
    const { signedOutForIdle } = useAuth();
    return <div>idle: {String(signedOutForIdle)}</div>;
}

async function renderProvider() {
    const view = render(
        <AuthProvider>
            <IdleProbe />
        </AuthProvider>
    );
    // Let getSession() and the staff lookup resolve so the idle timer starts.
    await act(async () => {});
    return view;
}

const advance = (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe("AuthContext idle sign-out", () => {
    beforeEach(() => {
        // Only the clock and interval are faked; Testing Library's own timeouts stay real.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        localStorage.clear();
        sessionStorage.clear();
        supabase.from.mockReturnValue(makeBuilder({ data: null }));
        supabase.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
        supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
        supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
            data: { currentLevel: "aal2", nextLevel: "aal2" },
        });
        supabase.auth.signOut.mockReset();
        supabase.auth.signOut.mockResolvedValue({ error: null });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("keeps the session at 9:59 of inactivity and ends it at 10:00", async () => {
        await renderProvider();

        await advance(9 * MINUTE + 59 * 1000);
        expect(supabase.auth.signOut).not.toHaveBeenCalled();

        await advance(1000);
        expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
        expect(screen.getByText("idle: true")).toBeInTheDocument();
    });

    it("clears an unfinished transaction from the browser when it signs the user out", async () => {
        sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify([{ firstName: "Jane" }]));
        sessionStorage.setItem("ttr.transactionId", "tx-1");
        await renderProvider();

        await advance(IDLE_TIMEOUT_MS);

        expect(sessionStorage.getItem(wizardStorageKeys.customers)).toBeNull();
        expect(sessionStorage.getItem("ttr.transactionId")).toBeNull();
    });

    it("starts the 10 minutes again after a click, key press or touch", async () => {
        await renderProvider();

        await advance(9 * MINUTE);
        fireEvent.pointerDown(document.body);
        await advance(9 * MINUTE);
        fireEvent.keyDown(document.body, { key: "a" });
        await advance(9 * MINUTE);
        fireEvent.touchStart(document.body);
        await advance(9 * MINUTE);
        expect(supabase.auth.signOut).not.toHaveBeenCalled();

        await advance(MINUTE);
        expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    it("counts activity in another tab, which arrives as a storage event", async () => {
        await renderProvider();

        await advance(9 * MINUTE);
        localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
        window.dispatchEvent(new StorageEvent("storage", { key: ACTIVITY_KEY }));
        await advance(9 * MINUTE);
        expect(supabase.auth.signOut).not.toHaveBeenCalled();

        await advance(MINUTE);
        expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    it("signs out at once when a hidden tab comes back after 11 minutes", async () => {
        await renderProvider();

        // A background tab's timers are throttled or frozen, so only the clock moves.
        vi.setSystemTime(Date.now() + 11 * MINUTE);
        expect(supabase.auth.signOut).not.toHaveBeenCalled();
        document.dispatchEvent(new Event("visibilitychange"));

        expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    it("signs out a session restored after the browser was closed for longer than 10 minutes", async () => {
        localStorage.setItem(ACTIVITY_KEY, String(Date.now() - 30 * MINUTE));
        await renderProvider();

        expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    it("does not run while nobody is signed in", async () => {
        supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
        await renderProvider();

        await advance(11 * MINUTE);
        expect(supabase.auth.signOut).not.toHaveBeenCalled();
    });

    it("stops checking when the provider unmounts", async () => {
        const { unmount } = await renderProvider();
        unmount();

        await advance(11 * MINUTE);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(supabase.auth.signOut).not.toHaveBeenCalled();
    });
});
