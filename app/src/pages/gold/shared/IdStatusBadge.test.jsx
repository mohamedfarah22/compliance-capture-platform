import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAuth } from "../../../context/AuthContext.jsx";
import { makeAuthValue } from "../../../test/testUtils.jsx";
import IdStatusBadge from "./IdStatusBadge.jsx";

vi.mock("../../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

// 2 Nov 2026, 12:00 in Melbourne.
const NOW = new Date("2026-11-02T01:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useAuth.mockReturnValue(makeAuthValue()); // idv_max_reliance_days = 730
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("IdStatusBadge", () => {
    it.each([
        ["valid", { expiry_date: inDays(90), captured_at: daysAgo(10) }, /^ID valid to /],
        ["expiring", { expiry_date: inDays(12), captured_at: daysAgo(10) }, "ID expires in 12 days"],
        ["expiring tomorrow", { expiry_date: inDays(1), captured_at: daysAgo(10) }, "ID expires in 1 day"],
        ["expired", { expiry_date: inDays(-1), captured_at: daysAgo(10) }, /^ID expired /],
        ["re-verify", { expiry_date: inDays(500), captured_at: daysAgo(800) }, "Re-verify ID"],
        ["no ID on file", null, "No ID on file"],
        ["an ID with no expiry", { expiry_date: null, captured_at: daysAgo(10) }, "ID valid"],
    ])("%s", (_name, currentId, text) => {
        render(<IdStatusBadge currentId={currentId} />);

        expect(screen.getByText(text)).toBeInTheDocument();
    });

    it("re-verifies after the business's window, not before", () => {
        useAuth.mockReturnValue(makeAuthValue({ reportingEntity: { idv_max_reliance_days: 365 } }));
        render(<IdStatusBadge currentId={{ expiry_date: inDays(500), captured_at: daysAgo(365) }} />);
        expect(screen.getByText(/^ID valid to /)).toBeInTheDocument();
        cleanup();

        render(<IdStatusBadge currentId={{ expiry_date: inDays(500), captured_at: daysAgo(366) }} />);
        expect(screen.getByText("Re-verify ID")).toBeInTheDocument();
    });

    it("shows expired rather than re-verify when both apply", () => {
        render(<IdStatusBadge currentId={{ expiry_date: inDays(-5), captured_at: daysAgo(900) }} />);

        expect(screen.getByText(/^ID expired /)).toBeInTheDocument();
    });
});
