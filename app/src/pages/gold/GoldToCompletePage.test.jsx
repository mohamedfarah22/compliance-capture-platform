import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import { GoldApiError } from "../../lib/goldApi.js";
import GoldToCompletePage from "./GoldToCompletePage.jsx";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    listIncompleteTransactions: vi.fn(),
    getPurchaseStaffNames: vi.fn(),
    goToAustracForm: vi.fn(),
}));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const purchaseOf = (overrides = {}) => ({
    id: "p1",
    customer_id: "c1",
    joint_customer_id: null,
    customer_first_name: "Jane",
    customer_last_name: "Citizen",
    joint_customer_first_name: null,
    joint_customer_last_name: null,
    purchase_type: "scrap",
    cash_10k_or_more: false,
    erp_invoice_no: null,
    ttr_transaction_id: null,
    ttr_status: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    created_by_staff_id: "s1",
    photo_count: 2,
    ...overrides,
});

const open = (state) =>
    render(
        <MemoryRouter initialEntries={[{ pathname: "/gold/to-complete", state }]}>
            <Routes>
                <Route path="/gold/to-complete" element={<GoldToCompletePage />} />
                <Route path="/gold/purchases/:purchaseId/complete" element={<Where />} />
                <Route path="/open-ttr/:id" element={<Where />} />
            </Routes>
        </MemoryRouter>
    );

beforeEach(() => {
    vi.resetAllMocks();
    goldApi.getPurchaseStaffNames.mockResolvedValue({ s1: "Sam Counter" });
});
afterEach(cleanup);

describe("GoldToCompletePage", () => {
    it("splits AUSTRAC pending from the others, with who recorded each and the deadline for the reportable ones", async () => {
        goldApi.listIncompleteTransactions.mockResolvedValue([
            purchaseOf({ id: "p1", cash_10k_or_more: true }),
            purchaseOf({
                id: "p2",
                customer_first_name: "Pat",
                customer_last_name: "Newman",
                joint_customer_id: "c9",
                joint_customer_first_name: "Joan",
                joint_customer_last_name: "Smith",
                photo_count: 1,
            }),
        ]);
        open();

        expect(await screen.findByRole("heading", { name: "AUSTRAC pending (1)" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Other purchases (1)" })).toBeInTheDocument();
        const pending = screen.getByRole("heading", { name: "AUSTRAC pending (1)" }).closest("section");
        expect(within(pending).getByRole("link", { name: "Jane Citizen" })).toHaveAttribute(
            "href",
            "/gold/customers/c1"
        );
        expect(pending).toHaveTextContent("by Sam Counter");
        expect(pending).toHaveTextContent("2 photos");
        expect(pending).toHaveTextContent(/AUSTRAC report due .* business days? left/);
        const other = screen.getByRole("heading", { name: "Other purchases (1)" }).closest("section");
        expect(other).toHaveTextContent("Pat Newman and Joan Smith");
        expect(other).toHaveTextContent("1 photo");
        expect(other).not.toHaveTextContent("AUSTRAC report due");
    });

    it("Complete opens Complete purchase for a purchase with no invoice number", async () => {
        const user = userEvent.setup();
        goldApi.listIncompleteTransactions.mockResolvedValue([purchaseOf()]);
        open();

        await user.click(await screen.findByRole("button", { name: "Complete" }));

        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/purchases/p1/complete");
    });

    it("Resume TTR opens the draft report, and Start TTR starts a new one when the draft was deleted", async () => {
        const user = userEvent.setup();
        goldApi.listIncompleteTransactions.mockResolvedValue([
            purchaseOf({
                id: "p1",
                cash_10k_or_more: true,
                erp_invoice_no: "INV-1",
                ttr_transaction_id: "t1",
                ttr_status: "draft",
            }),
            purchaseOf({ id: "p2", cash_10k_or_more: true, erp_invoice_no: "INV-2" }),
        ]);
        goldApi.goToAustracForm.mockResolvedValue({ ttrs: [{ id: "t1" }], path: "/open-ttr/t1" });
        open();

        const rows = await screen.findAllByRole("listitem");
        expect(within(rows[0]).queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
        expect(within(rows[1]).getByRole("button", { name: "Start TTR" })).toBeInTheDocument();
        await user.click(within(rows[0]).getByRole("button", { name: "Resume TTR" }));

        expect(goldApi.goToAustracForm).toHaveBeenCalledWith("p1");
        expect(await screen.findByTestId("where")).toHaveTextContent("/open-ttr/t1");
    });

    it("shows what went wrong when the report could not be started, and stays on the list", async () => {
        const user = userEvent.setup();
        goldApi.listIncompleteTransactions.mockResolvedValue([
            purchaseOf({ cash_10k_or_more: true, erp_invoice_no: "INV-2" }),
        ]);
        goldApi.goToAustracForm.mockRejectedValue(new GoldApiError({ status: 409, code: "ttr_reference_in_use" }));
        open();

        await user.click(await screen.findByRole("button", { name: "Start TTR" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Another AUSTRAC report already uses this invoice number"
        );
        expect(screen.getByRole("button", { name: "Start TTR" })).toBeEnabled();
    });

    it("says so when there is nothing to complete", async () => {
        goldApi.listIncompleteTransactions.mockResolvedValue([]);
        open();

        expect(
            await screen.findByText("Nothing to complete. Every purchase has an invoice number.")
        ).toBeInTheDocument();
    });

    it("shows a notice handed on by Complete purchase, once", async () => {
        goldApi.listIncompleteTransactions.mockResolvedValue([]);
        open({ notice: "Purchase completed" });

        expect(await screen.findByRole("status")).toHaveTextContent("Purchase completed");
        await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    });

    it("says so when the list could not be loaded", async () => {
        goldApi.listIncompleteTransactions.mockRejectedValue(new GoldApiError({ message: "x" }));
        open();

        expect(await screen.findByText("Could not load the purchases. Try again.")).toBeInTheDocument();
    });
});
