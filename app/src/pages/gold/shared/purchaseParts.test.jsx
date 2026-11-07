import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as goldApi from "../../../lib/goldApi.js";
import CashQuestion from "./CashQuestion.jsx";
import DueLine from "./DueLine.jsx";
import GoodsPhotos from "./GoodsPhotos.jsx";
import JointSellerPanel from "./JointSellerPanel.jsx";
import LinkedInvoice from "./LinkedInvoice.jsx";
import PurchaseTags from "./PurchaseTags.jsx";
import Segmented from "./Segmented.jsx";

vi.mock("../../../lib/goldApi.js", () => ({ searchCustomers: vi.fn() }));
vi.mock("../../../context/AuthContext.jsx", () => ({
    useAuth: () => ({ reportingEntity: { idv_max_reliance_days: 730 } }),
}));

afterEach(cleanup);

describe("PurchaseTags", () => {
    const tags = (overrides) => {
        const { container } = render(
            <PurchaseTags
                purchase={{
                    purchase_type: "scrap",
                    erp_invoice_no: "INV-1",
                    cash_10k_or_more: false,
                    ttr_status: null,
                    ...overrides,
                }}
            />
        );
        return Array.from(container.querySelectorAll("span")).map((span) => span.textContent);
    };

    it("shows the type, and nothing else for a complete, non-reportable purchase", () => {
        expect(tags()).toEqual(["Scrap"]);
    });

    it("adds Incomplete until there is an invoice number", () => {
        expect(tags({ purchase_type: "bullion", erp_invoice_no: null })).toEqual(["Bullion", "Incomplete"]);
    });

    it("says AUSTRAC pending until the TTR is complete, then AUSTRAC (spec 3.2)", () => {
        cleanup();
        expect(tags({ cash_10k_or_more: true, ttr_status: null })).toEqual(["Scrap", "AUSTRAC pending"]);
        cleanup();
        expect(tags({ cash_10k_or_more: true, ttr_status: "draft" })).toEqual(["Scrap", "AUSTRAC pending"]);
        cleanup();
        expect(tags({ cash_10k_or_more: true, ttr_status: "complete" })).toEqual(["Scrap", "AUSTRAC"]);
    });

    it("treats an unflagged part linked to a TTR as reportable (earlier part of a mixed invoice)", () => {
        cleanup();
        expect(tags({ cash_10k_or_more: false, ttr_status: "draft" })).toEqual(["Scrap", "AUSTRAC pending"]);
        cleanup();
        expect(tags({ cash_10k_or_more: false, ttr_status: "complete" })).toEqual(["Scrap", "AUSTRAC"]);
    });
});

describe("DueLine", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-06T01:00:00Z")); // Friday 6 Nov in Melbourne
    });
    afterEach(() => vi.useRealTimers());

    it("counts 10 business days from the sale, amber while there is time", () => {
        // Sold Mon 2 Nov: due Mon 16 Nov, 6 business days from Fri 6 Nov.
        render(<DueLine purchase={{ created_at: "2026-11-02T01:00:00Z" }} />);

        expect(screen.getByText("AUSTRAC report due 16 Nov 2026 · 6 business days left")).toBeInTheDocument();
    });

    it("says overdue once it has passed", () => {
        render(<DueLine purchase={{ created_at: "2026-10-16T01:00:00Z" }} />);

        expect(screen.getByText(/Overdue by 5 business days/)).toBeInTheDocument();
    });
});

describe("Segmented", () => {
    it("is a radio group; arrow keys move the choice", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <Segmented
                options={[
                    ["scrap", "Scrap jewellery"],
                    ["bullion", "Bullion"],
                ]}
                value="scrap"
                onChange={onChange}
            />
        );

        screen.getByRole("radio", { name: "Scrap jewellery" }).focus();
        await user.keyboard("{ArrowRight}");

        expect(onChange).toHaveBeenCalledWith("bullion");
        expect(screen.getByRole("radio", { name: "Scrap jewellery" })).toBeChecked();
    });
});

describe("CashQuestion", () => {
    it("asks scrap whether cash was $10,000 or more, and shows the optional amount on Yes", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(
            <CashQuestion idPrefix="p" type="scrap" cash10k={false} cashAmount="" onChange={onChange} />
        );

        expect(screen.getByRole("radiogroup", { name: "Paid in cash of $10,000 or more?" })).toBeInTheDocument();
        expect(screen.queryByLabelText(/Cash amount/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: "Yes" }));
        expect(onChange).toHaveBeenCalledWith({ cash10k: true });

        rerender(<CashQuestion idPrefix="p" type="scrap" cash10k cashAmount="8,000" onChange={onChange} />);
        expect(screen.getByLabelText(/Cash amount/)).toHaveValue("8,000");
    });

    it("asks bullion for the cash band, with the hint for $5,000 to $9,999", () => {
        render(<CashQuestion idPrefix="p" type="bullion" bullionBand="5k_to_10k" cashAmount="" onChange={vi.fn()} />);

        expect(screen.getByRole("radiogroup", { name: "Cash paid" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "$5,000 to $9,999" })).toBeChecked();
        expect(screen.getByText("Needs this customer’s current ID. No AUSTRAC report.")).toBeInTheDocument();
        expect(screen.queryByLabelText(/Cash amount/)).not.toBeInTheDocument();
    });
});

describe("LinkedInvoice", () => {
    const linked = [
        {
            id: "p1",
            purchase_type: "scrap",
            cash_amount: null,
            created_at: "2026-11-05T01:00:00Z",
            ttr_transaction_id: null,
        },
    ];

    it("asks for the earlier part's cash and this part's, and shows the total", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <LinkedInvoice
                idPrefix="p"
                invoice="INV-1"
                linked={linked}
                partAmount=""
                cash={{ total: 12000, reportable: true, alreadyReported: false }}
                onChange={onChange}
            />
        );

        expect(screen.getByText("Same invoice as an earlier purchase today for this customer")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Cash paid for this part (AUD)"), "6");
        expect(onChange).toHaveBeenLastCalledWith({ partAmount: "6" });
        await user.type(screen.getByLabelText("Cash paid on that part (AUD)"), "5");
        expect(onChange).toHaveBeenLastCalledWith({ linkedAmounts: { p1: "5" } });
        expect(screen.getByRole("status")).toHaveTextContent(
            "Cash on INV-1 today: $12,000.00. That’s $10,000.00 or more, so the invoice will be reported to AUSTRAC once."
        );
    });

    it("shows what the rules found wrong, and a fixed part amount read only", () => {
        render(
            <LinkedInvoice
                idPrefix="p"
                invoice="INV-1"
                linked={[{ ...linked[0], cash_amount: 4000 }]}
                partAmount="1000"
                cash={{ total: null }}
                errors={{ partAmount: "Enter the cash paid for this part. Enter 0 if none was cash." }}
                isPartFixed
                onChange={vi.fn()}
            />
        );

        expect(screen.getByText("Enter the cash paid for this part. Enter 0 if none was cash.")).toBeInTheDocument();
        expect(screen.getByLabelText("Cash paid for this part (AUD)")).toBeDisabled();
        expect(screen.queryByLabelText("Cash paid on that part (AUD)")).not.toBeInTheDocument();
        expect(screen.getByText("$4,000.00")).toBeInTheDocument();
    });
});

describe("JointSellerPanel", () => {
    beforeEach(() => {
        goldApi.searchCustomers.mockResolvedValue([]);
    });

    it("is a dialog that names the main seller, and Escape or Close closes it", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <JointSellerPanel
                mainCustomer={{ id: "c1", full_name: "Jane Citizen" }}
                onPick={vi.fn()}
                onNew={vi.fn()}
                onClose={onClose}
            />
        );

        expect(screen.getByRole("dialog", { name: "Add second person" })).toBeInTheDocument();
        expect(screen.getByText(/The purchase details you entered for Jane Citizen are kept/)).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("offers New customer, and finds the second person through the picker", async () => {
        const user = userEvent.setup();
        const onNew = vi.fn();
        goldApi.searchCustomers.mockResolvedValue([
            { id: "c1", full_name: "Jane Citizen", current_id: null },
            { id: "c2", full_name: "Joan Smith", current_id: null },
        ]);
        render(
            <JointSellerPanel
                mainCustomer={{ id: "c1", full_name: "Jane Citizen" }}
                onPick={vi.fn()}
                onNew={onNew}
                onClose={vi.fn()}
            />
        );

        await user.click(screen.getByRole("button", { name: "New customer" }));
        expect(onNew).toHaveBeenCalled();
        await user.type(screen.getByLabelText("Search"), "jo");
        expect(await screen.findByText("Already the main seller")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText("Joan Smith")).toBeInTheDocument());
    });
});

describe("GoodsPhotos", () => {
    it("lists the photos with Remove, and stops adding at 10", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const photos = Array.from({ length: 2 }, (_, index) => ({ blob: new Blob(["j"]), preview: `data:${index}` }));
        const { rerender } = render(<GoodsPhotos label="Add a photo" value={photos} onChange={onChange} />);

        expect(screen.getAllByRole("img")).toHaveLength(2);
        await user.click(screen.getByRole("button", { name: "Remove goods photo 1" }));
        expect(onChange).toHaveBeenCalledWith([photos[1]]);

        const ten = Array.from({ length: 10 }, (_, index) => ({ blob: new Blob(["j"]), preview: `data:${index}` }));
        rerender(<GoodsPhotos label="Add a photo" value={ten} onChange={onChange} />);
        expect(screen.getByText("You can add up to 10 photos.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    });
});
