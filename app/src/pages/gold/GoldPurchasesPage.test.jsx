import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import GoldPurchasesPage from "./GoldPurchasesPage.jsx";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    searchTransactions: vi.fn(),
    listRecordedBy: vi.fn(),
    getPurchaseStaffNames: vi.fn(),
}));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));

const Where = () => {
    const location = useLocation();
    return <p data-testid="where">{location.pathname + location.search}</p>;
};

const rowOf = (overrides = {}) => ({
    id: "p1",
    customer_id: "c1",
    joint_customer_id: null,
    customer_first_name: "Jane",
    customer_last_name: "Citizen",
    joint_customer_first_name: null,
    joint_customer_last_name: null,
    purchase_type: "scrap",
    cash_10k_or_more: false,
    erp_invoice_no: "INV-1",
    ttr_status: null,
    created_at: "2026-11-05T01:00:00Z",
    created_by_staff_id: "s1",
    completed_at: null,
    completed_by_staff_id: null,
    ...overrides,
});

const open = (entry = "/gold/purchases") =>
    render(
        <MemoryRouter initialEntries={[entry]}>
            <Routes>
                <Route
                    path="/gold/purchases"
                    element={
                        <>
                            <GoldPurchasesPage />
                            <Where />
                        </>
                    }
                />
                <Route path="/gold/purchases/:purchaseId" element={<Where />} />
            </Routes>
        </MemoryRouter>
    );

const lastSearch = () => goldApi.searchTransactions.mock.calls.at(-1);

beforeEach(() => {
    vi.resetAllMocks();
    goldApi.searchTransactions.mockResolvedValue({ rows: [rowOf()], total: 1 });
    goldApi.listRecordedBy.mockResolvedValue([{ id: "s1", name: "Sam Counter" }]);
    goldApi.getPurchaseStaffNames.mockResolvedValue({ s1: "Sam Counter", s2: "Mel Manager" });
});
afterEach(cleanup);

describe("GoldPurchasesPage", () => {
    it("lists purchases with who, the invoice, when and by whom, and opens a record", async () => {
        const user = userEvent.setup();
        goldApi.searchTransactions.mockResolvedValue({
            rows: [
                rowOf({
                    completed_at: "2026-11-05T03:00:00Z",
                    completed_by_staff_id: "s2",
                    joint_customer_id: "c2",
                    joint_customer_first_name: "Joan",
                    joint_customer_last_name: "Smith",
                }),
                rowOf({ id: "p2", erp_invoice_no: null, cash_10k_or_more: true }),
            ],
            total: 2,
        });
        open();

        expect(await screen.findByText("2 purchases")).toBeInTheDocument();
        const first = screen.getByRole("link", { name: /Jane Citizen and Joan Smith/ });
        expect(first).toHaveTextContent("INV-1");
        expect(first).toHaveTextContent("by Sam Counter");
        expect(first).toHaveTextContent("Completed");
        expect(first).toHaveTextContent("by Mel Manager");
        expect(screen.getByRole("link", { name: /No invoice number yet/ })).toHaveTextContent("AUSTRAC pending");
        await user.click(first);
        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/purchases/p1");
    });

    it("has no Download or print button (that is Phase 9b)", async () => {
        open();

        await screen.findByText("1 purchase");
        expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
    });

    it("reads the filters and the page from the URL and asks the server for just that page", async () => {
        open("/gold/purchases?type=bullion&status=austrac_pending&cash=yes&from=2026-11-01&to=2026-11-05&by=s1&page=2");

        await screen.findByText("1 purchase");
        expect(lastSearch()).toEqual([
            {
                q: "",
                type: "bullion",
                status: "austrac_pending",
                cash: "yes",
                from: "2026-11-01",
                to: "2026-11-05",
                recordedBy: "s1",
            },
            { page: 2, pageSize: 25 },
        ]);
        expect(screen.getByLabelText("Type")).toHaveValue("bullion");
        expect(screen.getByLabelText("Status")).toHaveValue("austrac_pending");
        expect(screen.getByLabelText("Cash")).toHaveValue("yes");
        expect(screen.getByLabelText("From")).toHaveValue("2026-11-01");
        expect(screen.getByLabelText("To")).toHaveValue("2026-11-05");
        expect(screen.getByLabelText("Recorded by")).toHaveValue("s1");
    });

    it("puts a chosen filter in the URL and goes back to page 1, but keeps the search text out of it", async () => {
        const user = userEvent.setup();
        open("/gold/purchases?page=3");
        await screen.findByText("1 purchase");

        await user.selectOptions(screen.getByLabelText("Status"), "austrac");
        await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/gold/purchases?status=austrac"));
        expect(screen.getByTestId("where")).not.toHaveTextContent("page");

        await user.type(screen.getByLabelText("Search"), "Jane");
        await waitFor(() => expect(lastSearch()[0].q).toBe("Jane"));
        expect(screen.getByTestId("where")).not.toHaveTextContent("Jane");
    });

    it("offers the five statuses", async () => {
        open();
        await screen.findByText("1 purchase");

        const labels = Array.from(screen.getByLabelText("Status").querySelectorAll("option")).map((o) => o.textContent);

        expect(labels).toEqual(["All", "Incomplete", "Completed", "AUSTRAC pending", "AUSTRAC"]);
    });

    it("pages with Previous and Next from the server's total", async () => {
        const user = userEvent.setup();
        goldApi.searchTransactions.mockResolvedValue({ rows: [rowOf()], total: 26 });
        open();

        await screen.findByText("26 purchases");
        expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Next" }));

        await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("page=2"));
        await screen.findByText("Page 2 of 2");
        expect(lastSearch()[1]).toEqual({ page: 2, pageSize: 25 });
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    });

    it("Clear filters empties the URL and the search", async () => {
        const user = userEvent.setup();
        open("/gold/purchases?type=scrap&page=2");
        await screen.findByText("1 purchase");

        await user.click(screen.getByRole("button", { name: "Clear filters" }));

        await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/gold\/purchases$/));
        expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    });

    it("says so when nothing matches, and when the search fails", async () => {
        goldApi.searchTransactions.mockResolvedValue({ rows: [], total: 0 });
        const { unmount } = open();
        expect(await screen.findByText("No purchases match these filters.")).toBeInTheDocument();
        unmount();

        goldApi.searchTransactions.mockRejectedValue(new Error("x"));
        open();
        expect(await screen.findByText("Could not load the purchases. Try again.")).toBeInTheDocument();
    });
});
