import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { makeAuthValue } from "../test/testUtils.jsx";

const flags = vi.hoisted(() => ({ goldEnabled: false }));

vi.mock("../context/AuthContext.jsx", () => ({
    AuthProvider: ({ children }) => children,
    useAuth: vi.fn(),
}));

// A getter, so each test can flip the flag without reloading the module.
vi.mock("../config/featureFlags.js", () => ({
    ITEM_AND_DELIVERY_CAPTURE_ENABLED: false,
    get GOLD_JOURNEY_ENABLED() {
        return flags.goldEnabled;
    },
}));

vi.mock("../lib/supabase.js", () => ({ supabase: {} }));

const PICKER_HEADING = "What would you like to do?";

function renderAt(path) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
        </MemoryRouter>
    );
}

describe("journey routing", () => {
    beforeEach(() => {
        flags.goldEnabled = false;
        useAuth.mockReturnValue(makeAuthValue());
    });

    afterEach(() => {
        cleanup();
    });

    it("shows the journey picker at /", () => {
        renderAt("/");

        expect(screen.getByRole("heading", { name: PICKER_HEADING })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /threshold transaction report/i })).toHaveAttribute("href", "/start");
    });

    it("shows the transaction start screen at /start", () => {
        renderAt("/start");

        expect(screen.getByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: PICKER_HEADING })).not.toBeInTheDocument();
    });

    it("opens the transaction start screen from the TTR card", async () => {
        const user = userEvent.setup();
        renderAt("/");

        await user.click(screen.getByRole("link", { name: /threshold transaction report/i }));

        expect(screen.getByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
    });

    it("sends an unknown route to the picker", () => {
        renderAt("/no-such-page");

        expect(screen.getByRole("heading", { name: PICKER_HEADING })).toBeInTheDocument();
    });

    describe("Gold card and /gold", () => {
        it("hides the Gold card and sends /gold back to the picker while the flag is off", () => {
            renderAt("/");
            expect(screen.queryByRole("link", { name: /gold due diligence/i })).not.toBeInTheDocument();
            cleanup();

            renderAt("/gold");
            expect(screen.getByRole("heading", { name: PICKER_HEADING })).toBeInTheDocument();
            cleanup();

            renderAt("/gold/customers/new");
            expect(screen.getByRole("heading", { name: PICKER_HEADING })).toBeInTheDocument();
        });

        it("shows the Gold card and a coming-soon page at /gold while the flag is on", () => {
            flags.goldEnabled = true;
            renderAt("/");
            expect(screen.getByRole("link", { name: /gold due diligence/i })).toHaveAttribute("href", "/gold");
            cleanup();

            renderAt("/gold");
            expect(screen.getByText("Gold due diligence is coming soon.")).toBeInTheDocument();
        });
    });

    describe("Reports card", () => {
        it("is hidden from staff", () => {
            renderAt("/");

            expect(screen.queryByRole("link", { name: /reports/i })).not.toBeInTheDocument();
            expect(screen.queryByText("Review and approve the daily AUSTRAC report batches.")).not.toBeInTheDocument();
        });

        it("is shown to admins", () => {
            useAuth.mockReturnValue(
                makeAuthValue({
                    canApproveReports: true,
                    staffMember: { ...makeAuthValue().staffMember, role: "admin" },
                })
            );
            renderAt("/");

            // The card, not the header link that every signed-in admin page carries.
            expect(screen.getByRole("link", { name: /review and approve/i })).toHaveAttribute("href", "/reports");
        });
    });
});
