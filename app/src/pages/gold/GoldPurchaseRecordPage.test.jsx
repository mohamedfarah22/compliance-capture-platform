import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import { GoldApiError } from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import GoldPurchaseRecordPage from "./GoldPurchaseRecordPage.jsx";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    getTransaction: vi.fn(),
    getCustomerNames: vi.fn(),
    getPurchaseStaffNames: vi.fn(),
    getPurchaseIdUsed: vi.fn(),
    getGoldPhotoUrls: vi.fn(),
    getCustomerIdImages: vi.fn(),
    recordDownload: vi.fn(),
}));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const purchaseOf = (overrides = {}) => ({
    id: "p1",
    customer_id: "c1",
    joint_customer_id: null,
    purchase_type: "scrap",
    cash_band: "10k_plus",
    cash_amount: 12000,
    cash_10k_or_more: true,
    erp_invoice_no: "INV-1",
    phone: "0412 345 678",
    id_sighted: true,
    id_expired_at_time: false,
    id_outside_window_at_time: false,
    created_at: "2026-11-05T01:00:00Z",
    created_by_staff_id: "s1",
    completed_at: null,
    completed_by_staff_id: null,
    goods_photos: [{ id: "g1", sort_order: 0 }],
    ttr: null,
    ...overrides,
});
const usedOf = (overrides = {}) => ({
    role: "main",
    document_type: "Driver licence",
    document_number: "012345678",
    issuer: "VIC",
    expiry_date: "2031-01-01",
    captured_at: "2026-10-01T01:00:00Z",
    captured_by_name: "Sam Counter",
    photos_replaced: false,
    current_copy_captured_at: null,
    front_image_id: "f1",
    back_image_id: "b1",
    ...overrides,
});

const open = (id = "p1") =>
    render(
        <MemoryRouter initialEntries={[`/gold/purchases/${id}`]}>
            <Routes>
                <Route path="/gold/purchases/:purchaseId" element={<GoldPurchaseRecordPage />} />
                <Route path="/gold/purchases/:purchaseId/complete" element={<Where />} />
            </Routes>
        </MemoryRouter>
    );

beforeEach(() => {
    vi.resetAllMocks();
    goldApi.getTransaction.mockResolvedValue(purchaseOf());
    goldApi.getCustomerNames.mockResolvedValue({ c1: "Jane Citizen", c2: "Joan Smith" });
    goldApi.getPurchaseStaffNames.mockResolvedValue({ s1: "Sam Counter" });
    goldApi.getPurchaseIdUsed.mockResolvedValue([usedOf()]);
    goldApi.getGoldPhotoUrls.mockResolvedValue([{ id: "g1", sortOrder: 0, url: "https://signed/g1.jpg" }]);
    goldApi.getCustomerIdImages.mockResolvedValue({ front: "https://signed/f.jpg", back: "https://signed/b.jpg" });
    useAuth.mockReturnValue({ staffMember: { role: "staff" } });
});
afterEach(cleanup);

describe("GoldPurchaseRecordPage", () => {
    it("shows the purchase, the ID details used with who captured them, and the photos", async () => {
        open();

        expect(await screen.findByRole("heading", { name: "Scrap jewellery purchase" })).toBeInTheDocument();
        expect(screen.getByText("ERP invoice INV-1")).toBeInTheDocument();
        const terms = (label) => screen.getByText(label, { selector: "dt" }).nextSibling;
        expect(terms("Recorded by")).toHaveTextContent("Sam Counter");
        expect(terms("Cash paid")).toHaveTextContent("$10,000 or more");
        expect(terms("Cash amount")).toHaveTextContent("$12,000.00");
        expect(terms("Sighted in person")).toHaveTextContent("Yes");
        expect(terms("ID number")).toHaveTextContent("012345678");
        expect(terms("ID captured")).toHaveTextContent("Captured by Sam Counter on 01 Oct 2026");
        expect(screen.getByRole("link", { name: "Jane Citizen" })).toHaveAttribute("href", "/gold/customers/c1");
        expect(screen.getByAltText("Jane Citizen — ID front")).toHaveAttribute("src", "https://signed/f.jpg");
        expect(screen.getByAltText("Goods photo 1")).toHaveAttribute("src", "https://signed/g1.jpg");
        expect(screen.queryByText(/Newer copy of this ID/)).not.toBeInTheDocument();
    });

    it("labels the photos as a newer copy when the ID's photos were replaced (C1)", async () => {
        goldApi.getPurchaseIdUsed.mockResolvedValue([
            usedOf({ photos_replaced: true, current_copy_captured_at: "2026-11-03T01:00:00Z" }),
        ]);
        open();

        expect(await screen.findByText("Newer copy of this ID, taken 03 Nov 2026")).toBeInTheDocument();
    });

    it("shows both sellers of a joint sale", async () => {
        goldApi.getTransaction.mockResolvedValue(purchaseOf({ joint_customer_id: "c2" }));
        goldApi.getPurchaseIdUsed.mockResolvedValue([usedOf(), usedOf({ role: "joint", document_number: "99887766" })]);
        open();

        expect(await screen.findByText("Joint seller")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Joan Smith" })).toHaveAttribute("href", "/gold/customers/c2");
        expect(screen.getByText("99887766")).toBeInTheDocument();
    });

    it("shows the AUSTRAC report: a link while it is a draft, plain text when complete, none when not reportable", async () => {
        goldApi.getTransaction.mockResolvedValue(purchaseOf({ ttr: { id: "t1", status: "draft" } }));
        const { unmount } = open();
        expect(await screen.findByText(/AUSTRAC report: draft in progress/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open AUSTRAC report" })).toHaveAttribute("href", "/open-ttr/t1");
        expect(screen.getByText("AUSTRAC pending")).toBeInTheDocument();
        unmount();

        goldApi.getTransaction.mockResolvedValue(purchaseOf({ ttr: { id: "t1", status: "complete" } }));
        const second = open();
        expect(await screen.findByText("AUSTRAC report: complete")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open AUSTRAC report" })).not.toBeInTheDocument();
        second.unmount();

        goldApi.getTransaction.mockResolvedValue(purchaseOf({ cash_10k_or_more: false }));
        open();
        await screen.findByRole("heading", { name: "Scrap jewellery purchase" });
        expect(screen.queryByText(/AUSTRAC report:/)).not.toBeInTheDocument();
    });

    it("shows the AUSTRAC report for an unflagged part that is linked to a TTR (earlier part of a mixed invoice)", async () => {
        goldApi.getTransaction.mockResolvedValue(
            purchaseOf({ cash_10k_or_more: false, ttr: { id: "t1", status: "draft" } })
        );
        open();
        expect(await screen.findByText(/AUSTRAC report: draft in progress/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open AUSTRAC report" })).toHaveAttribute("href", "/open-ttr/t1");
    });

    it("offers Complete only while the purchase has no invoice, and a staff member never sees Download record", async () => {
        const user = userEvent.setup();
        goldApi.getTransaction.mockResolvedValue(purchaseOf({ erp_invoice_no: null }));
        open();

        await user.click(await screen.findByRole("button", { name: "Complete" }));

        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/purchases/p1/complete");
        cleanup();
        goldApi.getTransaction.mockResolvedValue(purchaseOf());
        open();
        await screen.findByRole("heading", { name: "Scrap jewellery purchase" });
        expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    });

    describe("Download record, for managers and admins", () => {
        const idPhotosOf = () => screen.getByAltText("Jane Citizen — ID front").closest("article");

        beforeEach(() => {
            useAuth.mockReturnValue({ staffMember: { role: "manager" } });
            goldApi.recordDownload.mockResolvedValue({ ok: true });
            vi.spyOn(window, "print").mockImplementation(() => {});
        });
        afterEach(() => vi.restoreAllMocks());

        it("is shown to managers and admins", async () => {
            open();
            expect(await screen.findByRole("button", { name: "Download record" })).toBeInTheDocument();
            cleanup();
            useAuth.mockReturnValue({ staffMember: { role: "admin" } });
            open();
            expect(await screen.findByRole("button", { name: "Download record" })).toBeInTheDocument();
        });

        it("audits through gold-export first, then opens the print with the ID photos switched on", async () => {
            const user = userEvent.setup();
            const order = [];
            goldApi.recordDownload.mockImplementation(async () => order.push("audit"));
            let classesAtPrint = "";
            window.print.mockImplementation(() => {
                order.push("print");
                classesAtPrint = idPhotosOf().className;
            });
            open();
            await user.click(await screen.findByRole("button", { name: "Download record" }));

            await waitFor(() => expect(window.print).toHaveBeenCalled());
            expect(goldApi.recordDownload).toHaveBeenCalledWith({ kind: "record", filters: null, purchaseIds: ["p1"] });
            expect(order).toEqual(["audit", "print"]);
            expect(classesAtPrint).toMatch(/printIdPhotos/);
        });

        it("switches the ID photos off again when the print dialog closes (afterprint)", async () => {
            const user = userEvent.setup();
            open();
            await user.click(await screen.findByRole("button", { name: "Download record" }));
            await waitFor(() => expect(idPhotosOf().className).toMatch(/printIdPhotos/));

            act(() => {
                window.dispatchEvent(new Event("afterprint"));
            });

            expect(idPhotosOf().className).not.toMatch(/printIdPhotos/);
        });

        it("does not print, or switch the photos on, when gold-export refuses", async () => {
            const user = userEvent.setup();
            goldApi.recordDownload.mockRejectedValue(new Error("You do not have permission to do that."));
            open();
            await user.click(await screen.findByRole("button", { name: "Download record" }));

            expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to do that.");
            expect(window.print).not.toHaveBeenCalled();
            expect(idPhotosOf().className).not.toMatch(/printIdPhotos/);
        });

        it("has the ID photos off by default, so a plain print hides them", async () => {
            open();
            await screen.findByRole("button", { name: "Download record" });
            expect(idPhotosOf().className).not.toMatch(/printIdPhotos/);
        });
    });

    it("says Purchase not found for a purchase that is not there", async () => {
        goldApi.getTransaction.mockRejectedValue(new GoldApiError({ status: 404, code: "purchase_not_found" }));
        open("nope");

        expect(await screen.findByText("Purchase not found.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to Purchases" })).toHaveAttribute("href", "/gold/purchases");
    });
});
