import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TransactionCompletePage from "./TransactionCompletePage.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import { findWaitingReport } from "../../lib/wizardApi.js";

vi.mock("../../lib/wizardApi.js", () => ({
    findWaitingReport: vi.fn(),
}));

vi.mock("../../context/AuthContext.jsx", () => ({
    useAuth: vi.fn(),
}));

function renderPage(entry) {
    useAuth.mockReturnValue(makeAuthValue());
    return render(
        <MemoryRouter initialEntries={[entry]}>
            <Routes>
                <Route path="/transaction-complete" element={<TransactionCompletePage />} />
                <Route path="/start" element={<h1>Start TTR Transaction</h1>} />
                <Route path="/" element={<h1>Journey picker</h1>} />
                <Route path="/open-ttr/:id" element={<h1>Opening the other report</h1>} />
            </Routes>
        </MemoryRouter>
    );
}

describe("TransactionCompletePage", () => {
    beforeEach(() => {
        findWaitingReport.mockResolvedValue(null);
    });

    afterEach(() => {
        cleanup();
    });

    // Spec 3.4: a mixed invoice has two reports on one reference.
    it("says another report for the reference is waiting, and opens it by id", async () => {
        const user = userEvent.setup();
        findWaitingReport.mockResolvedValue({ id: "tx-2" });
        renderPage({ pathname: "/transaction-complete", state: { transactionRef: "INV-900" } });

        expect(await screen.findByText(/Another AUSTRAC report for INV-900 is waiting/)).toBeInTheDocument();
        expect(findWaitingReport).toHaveBeenCalledWith("INV-900");

        await user.click(screen.getByRole("button", { name: "Open it" }));
        expect(screen.getByRole("heading", { name: "Opening the other report" })).toBeInTheDocument();
    });

    it("says nothing when no other report is waiting", async () => {
        renderPage({ pathname: "/transaction-complete", state: { transactionRef: "INV-1" } });

        await waitFor(() => expect(findWaitingReport).toHaveBeenCalled());
        expect(screen.queryByText(/is waiting/)).not.toBeInTheDocument();
    });

    it("starts the next transaction at /start, not the journey picker", async () => {
        const user = userEvent.setup();
        renderPage({ pathname: "/transaction-complete", state: { transactionRef: "INV-1" } });

        await user.click(screen.getByRole("button", { name: "Start New Transaction" }));

        expect(screen.getByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
    });

    it("sends a visit with no completed transaction to /start", () => {
        renderPage("/transaction-complete");

        expect(screen.getByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
    });
});
