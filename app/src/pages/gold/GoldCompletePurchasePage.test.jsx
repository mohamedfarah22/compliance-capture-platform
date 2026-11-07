import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import { GoldApiError } from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldCompletePurchasePage from "./GoldCompletePurchasePage.jsx";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    getTransaction: vi.fn(),
    getCustomer: vi.fn(),
    getGoldPhotoUrls: vi.fn(),
    getPurchaseStaffNames: vi.fn(),
    getTtrReadiness: vi.fn(),
    findSameDayInvoicePurchases: vi.fn(),
    findInvoicePurchases: vi.fn(),
    updateTransaction: vi.fn(),
    goToAustracForm: vi.fn(),
}));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));

const Where = () => {
    const location = useLocation();
    return (
        <p data-testid="where">
            {location.pathname} {location.state?.notice ?? ""}
        </p>
    );
};

const purchaseOf = (overrides = {}) => ({
    id: "p1",
    customer_id: "c1",
    joint_customer_id: null,
    purchase_type: "scrap",
    cash_band: "under_10k",
    cash_amount: null,
    cash_10k_or_more: false,
    erp_invoice_no: null,
    sale_date: "2026-11-05",
    id_expired_at_time: false,
    id_outside_window_at_time: false,
    ttr_self_conducted: null,
    ttr_details_confirmed: null,
    ttr_transaction_id: null,
    ttr: null,
    created_at: "2026-11-05T01:00:00Z",
    created_by_staff_id: "s1",
    completed_at: null,
    completed_by_staff_id: null,
    goods_photos: [{ id: "g1", sort_order: 0 }],
    ...overrides,
});
const janeOf = () => ({
    id: "c1",
    full_name: "Jane Citizen",
    current_id: {
        document_type: "Driver licence",
        document_number: "012345678",
        expiry_date: "2031-01-01",
        captured_at: new Date().toISOString(),
    },
});

const open = (id = "p1") =>
    render(
        <MemoryRouter initialEntries={[`/gold/purchases/${id}/complete`]}>
            <Routes>
                <Route path="/gold/purchases/:purchaseId/complete" element={<GoldCompletePurchasePage />} />
                <Route path="/gold/to-complete" element={<Where />} />
                <Route path="/open-ttr/:id" element={<Where />} />
            </Routes>
        </MemoryRouter>
    );

beforeEach(() => {
    vi.resetAllMocks();
    useAuth.mockReturnValue(makeAuthValue());
    goldApi.getTransaction.mockResolvedValue(purchaseOf());
    goldApi.getCustomer.mockResolvedValue(janeOf());
    goldApi.getGoldPhotoUrls.mockResolvedValue([{ id: "g1", sortOrder: 0, url: "https://signed/g1.jpg" }]);
    goldApi.getPurchaseStaffNames.mockResolvedValue({ s1: "Sam Counter" });
    goldApi.getTtrReadiness.mockResolvedValue([]);
    goldApi.findSameDayInvoicePurchases.mockResolvedValue([]);
    goldApi.findInvoicePurchases.mockResolvedValue([]);
    goldApi.updateTransaction.mockResolvedValue({ purchaseId: "p1", ttr: null, warnings: {} });
});
afterEach(cleanup);

describe("GoldCompletePurchasePage", () => {
    it("shows the purchase read only: who sold, when and by whom it was recorded, the photos, and what is asked", async () => {
        open();

        expect(await screen.findByRole("heading", { name: "Complete purchase" })).toBeInTheDocument();
        expect(
            screen.getByText(/Scrap jewellery, recorded .* by Sam Counter. Add the ERP invoice number to complete it./)
        ).toBeInTheDocument();
        expect(screen.getByText("Main seller")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Jane Citizen" })).toHaveAttribute("href", "/gold/customers/c1");
        expect(screen.getByAltText("Goods photo 1")).toHaveAttribute("src", "https://signed/g1.jpg");
        expect(screen.getByText("Required to complete the purchase.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save and complete" })).toBeInTheDocument();
    });

    it("needs an invoice number", async () => {
        const user = userEvent.setup();
        open();

        await user.click(await screen.findByRole("button", { name: "Save and complete" }));

        expect(await screen.findByText("Enter the ERP invoice number for this purchase.")).toBeInTheDocument();
        expect(goldApi.updateTransaction).not.toHaveBeenCalled();
    });

    it("completes a purchase that is not reportable and goes back to To complete with a notice", async () => {
        const user = userEvent.setup();
        open();

        await user.type(await screen.findByLabelText("ERP invoice number"), " INV-C1 ");
        await user.click(screen.getByRole("button", { name: "Save and complete" }));

        await waitFor(() =>
            expect(goldApi.updateTransaction).toHaveBeenCalledWith("p1", {
                erpInvoiceNo: "INV-C1",
                partAmount: undefined,
                linkedAmounts: {},
            })
        );
        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/to-complete Purchase completed");
        expect(goldApi.goToAustracForm).not.toHaveBeenCalled();
    });

    it("case A: adding the invoice to a reportable purchase starts the TTR and opens it", async () => {
        const user = userEvent.setup();
        goldApi.getTransaction.mockResolvedValue(
            purchaseOf({
                cash_band: "10k_plus",
                cash_10k_or_more: true,
                ttr_self_conducted: true,
                ttr_details_confirmed: true,
            })
        );
        goldApi.updateTransaction.mockResolvedValue({ purchaseId: "p1", ttr: "A", warnings: {} });
        goldApi.goToAustracForm.mockResolvedValue({ ttrs: [{ id: "t1" }], path: "/open-ttr/t1" });
        open();

        expect(await screen.findByText(/AUSTRAC report due/)).toBeInTheDocument();
        await user.type(screen.getByLabelText("ERP invoice number"), "INV-C2");
        expect(
            screen.getByText(/After you save, the AUSTRAC form will open with this customer loaded/)
        ).toBeInTheDocument();
        expect(screen.queryByText(/wasn’t asked to confirm their details/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save and continue to AUSTRAC" }));

        await waitFor(() => expect(goldApi.goToAustracForm).toHaveBeenCalledWith("p1"));
        expect(await screen.findByTestId("where")).toHaveTextContent("/open-ttr/t1");
    });

    it("shows the amber notice when the purchase became reportable here without the counter answers", async () => {
        const user = userEvent.setup();
        goldApi.getTransaction.mockResolvedValue(
            purchaseOf({ cash_band: "5k_to_10k", purchase_type: "bullion", cash_amount: null })
        );
        goldApi.findSameDayInvoicePurchases.mockResolvedValue([
            {
                id: "p0",
                purchase_type: "scrap",
                cash_amount: 6000,
                ttr_transaction_id: null,
                created_at: "2026-11-05T00:00:00Z",
            },
        ]);
        open();

        await user.type(await screen.findByLabelText("ERP invoice number"), "INV-L1");
        expect(
            await screen.findByText("Same invoice as an earlier purchase today for this customer")
        ).toBeInTheDocument();
        await user.type(screen.getByLabelText("Cash paid for this part (AUD)"), "6000");

        expect(
            screen.getByText(
                "The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR."
            )
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save and continue to AUSTRAC" })).toBeInTheDocument();
        expect(goldApi.findSameDayInvoicePurchases).toHaveBeenCalledWith({
            customerId: "c1",
            invoice: "INV-L1",
            date: "2026-11-05",
            excludeId: "p1",
        });
    });

    it("blocks a reportable invoice that is already used by another purchase", async () => {
        const user = userEvent.setup();
        goldApi.getTransaction.mockResolvedValue(purchaseOf({ cash_band: "10k_plus", cash_10k_or_more: true }));
        goldApi.findInvoicePurchases.mockResolvedValue([{ id: "other" }]);
        open();

        await user.type(await screen.findByLabelText("ERP invoice number"), "INV-5");
        await waitFor(() => expect(goldApi.findInvoicePurchases).toHaveBeenCalledWith("INV-5", "p1"));
        await user.click(screen.getByRole("button", { name: "Save and continue to AUSTRAC" }));

        expect(await screen.findByText(/is already used by another purchase/)).toBeInTheDocument();
        expect(goldApi.updateTransaction).not.toHaveBeenCalled();
    });

    it("blocks a reportable purchase whose ID had expired when it was recorded", async () => {
        goldApi.getTransaction.mockResolvedValue(
            purchaseOf({ cash_band: "10k_plus", cash_10k_or_more: true, id_expired_at_time: true })
        );
        open();

        expect(
            await screen.findByText("An ID on file had expired when this purchase was recorded.")
        ).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("This purchase can’t go into an AUSTRAC report.");
        expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    });

    it("shows the server's refusal and keeps what was entered", async () => {
        const user = userEvent.setup();
        goldApi.updateTransaction.mockRejectedValue(
            new GoldApiError({
                status: 422,
                code: "validation_failed",
                body: {
                    errors: {
                        erp_invoice_no:
                            "The AUSTRAC report for INV-9 is already finished. Use a new ERP invoice number for this purchase.",
                    },
                },
            })
        );
        open();

        await user.type(await screen.findByLabelText("ERP invoice number"), "INV-9");
        await user.click(screen.getByRole("button", { name: "Save and complete" }));

        expect(await screen.findByText(/is already finished. Use a new ERP invoice number/)).toBeInTheDocument();
        expect(screen.getByLabelText("ERP invoice number")).toHaveValue("INV-9");
    });

    it("says a purchase that already has an invoice is already completed", async () => {
        goldApi.getTransaction.mockResolvedValue(
            purchaseOf({ erp_invoice_no: "INV-1", completed_at: "2026-11-05T03:00:00Z", completed_by_staff_id: "s1" })
        );
        open();

        expect(await screen.findByRole("heading", { name: "Purchase already completed" })).toBeInTheDocument();
        expect(screen.getByText(/Invoice INV-1, completed .* by Sam Counter\./)).toBeInTheDocument();
    });

    it("says Purchase not found for a purchase that is not there", async () => {
        goldApi.getTransaction.mockRejectedValue(new GoldApiError({ status: 404, code: "purchase_not_found" }));
        open("nope");

        expect(await screen.findByText("Purchase not found.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to To complete" })).toHaveAttribute("href", "/gold/to-complete");
    });
});
