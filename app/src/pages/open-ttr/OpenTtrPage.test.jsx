import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import OpenTtrPage from "./OpenTtrPage.jsx";
import { findOtherActiveDraft, openTransaction } from "../../lib/wizardApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";

vi.mock("../../lib/wizardApi.js", () => ({
    findOtherActiveDraft: vi.fn(),
    openTransaction: vi.fn(),
}));

vi.mock("../../context/AuthContext.jsx", () => ({
    useAuth: vi.fn(),
}));

function renderPage() {
    return render(
        <MemoryRouter initialEntries={["/open-ttr/tx-1"]}>
            <Routes>
                <Route path="/open-ttr/:id" element={<OpenTtrPage />} />
                <Route path="/transaction-details" element={<h1>Transaction Details</h1>} />
                <Route path="/start" element={<h1>Start TTR Transaction</h1>} />
            </Routes>
        </MemoryRouter>
    );
}

describe("OpenTtrPage (spec 3.2)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useAuth.mockReturnValue(makeAuthValue());
        findOtherActiveDraft.mockResolvedValue(null);
        openTransaction.mockResolvedValue({ path: "/transaction-details" });
    });

    afterEach(() => {
        cleanup();
    });

    it("opens the report by id and goes to the first step that needs input", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Transaction Details" })).toBeInTheDocument();
        expect(findOtherActiveDraft).toHaveBeenCalledWith("tx-1");
        expect(openTransaction).toHaveBeenCalledWith("tx-1");
    });

    it("warns first when another report is in progress, and opens nothing until staff agree", async () => {
        const user = userEvent.setup();
        findOtherActiveDraft.mockResolvedValue({ id: "tx-old", transactionRef: "INV-777" });
        renderPage();

        expect(
            await screen.findByText(
                "You have another AUSTRAC report in progress (INV-777). It stays saved; reopen it from the TTR start page."
            )
        ).toBeInTheDocument();
        expect(openTransaction).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Open this report" }));
        expect(await screen.findByRole("heading", { name: "Transaction Details" })).toBeInTheDocument();
        expect(openTransaction).toHaveBeenCalledWith("tx-1");
    });

    it("Cancel on the warning leaves the other report alone and goes to the TTR start page", async () => {
        const user = userEvent.setup();
        findOtherActiveDraft.mockResolvedValue({ id: "tx-old", transactionRef: "INV-777" });
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(await screen.findByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        expect(openTransaction).not.toHaveBeenCalled();
    });

    it("shows why a report could not be opened", async () => {
        openTransaction.mockRejectedValue(new Error("That AUSTRAC report is already complete."));
        renderPage();

        await waitFor(() => expect(screen.getByText("That AUSTRAC report is already complete.")).toBeInTheDocument());
    });
});
