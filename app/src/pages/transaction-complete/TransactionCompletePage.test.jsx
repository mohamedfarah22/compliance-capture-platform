import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TransactionCompletePage from "./TransactionCompletePage.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";

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
            </Routes>
        </MemoryRouter>
    );
}

describe("TransactionCompletePage", () => {
    afterEach(() => {
        cleanup();
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
