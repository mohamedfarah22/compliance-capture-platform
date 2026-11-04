import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import { GoldApiError } from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldCustomerPage from "./GoldCustomerPage.jsx";
import * as format from "./shared/format.js";
import { GoldDraftProvider } from "./shared/index.js";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    getCustomer: vi.fn(),
    getCustomerIdImages: vi.fn(),
    getTtrReadiness: vi.fn(),
    listTransactions: vi.fn(),
    getCustomerNames: vi.fn(),
    createTransaction: vi.fn(),
    goToAustracForm: vi.fn(),
    findSameDayInvoicePurchases: vi.fn(),
    findInvoicePurchases: vi.fn(),
    updateCustomerPhone: vi.fn(),
    searchCustomers: vi.fn(),
}));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));
// jsdom draws on no canvas: a photo "converts" to a JPEG blob.
vi.mock("./shared/format.js", async (importOriginal) => ({
    ...(await importOriginal()),
    compressImage: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
}));

const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();
const idOf = (overrides = {}) => ({
    document_type: "Driver licence",
    document_number: "012345678",
    issuer: "VIC",
    has_expiry: true,
    expiry_date: daysFromNow(900).slice(0, 10),
    captured_at: daysFromNow(-30),
    front_image_id: "img-f",
    back_image_id: "img-b",
    ...overrides,
});
const customerOf = (overrides = {}) => ({
    id: "c1",
    full_name: "Jane Citizen",
    first_name: "Jane",
    last_name: "Citizen",
    phone: "0412 345 678",
    date_of_birth: "1985-11-15",
    res_street: "1 Test St",
    res_suburb: "Coburg",
    res_state: "VIC",
    res_postcode: "3058",
    occupation: "Jeweller",
    citizenship_country_code: "AU",
    tax_residency_country_code: "AU",
    created_at: "2025-11-02T02:10:00Z",
    aliases: [],
    current_id: idOf(),
    ...overrides,
});

const Where = () => {
    const location = useLocation();
    return <p data-testid="where">{location.pathname + (location.state?.returnTo ? " returnTo" : "")}</p>;
};

const open = (entry = "/gold/customers/c1") =>
    render(
        <MemoryRouter initialEntries={[entry]}>
            <GoldDraftProvider>
                <Routes>
                    <Route path="/gold/customers/:customerId" element={<GoldCustomerPage />} />
                    <Route path="/gold/customers/:customerId/update-id" element={<Where />} />
                    <Route path="/gold/customers/new" element={<Where />} />
                    <Route path="/open-ttr/:id" element={<Where />} />
                </Routes>
            </GoldDraftProvider>
        </MemoryRouter>
    );

const addPhoto = async (user) => {
    await user.upload(
        screen.getByLabelText("Photos of items purchased (required) file"),
        new File(["x"], "goods.png", { type: "image/png" })
    );
    await screen.findByAltText("Goods photo 1");
};
const tickSighted = (user) => user.click(screen.getByRole("checkbox", { name: /sighted in person today/ }));
const record = (user, name = "Record purchase") => user.click(screen.getByRole("button", { name }));
const answerYes = (user, question) =>
    user.click(within(screen.getByRole("radiogroup", { name: question })).getByRole("radio", { name: "Yes" }));
const cashYes = (user) => answerYes(user, "Paid in cash of $10,000 or more?");

beforeEach(() => {
    vi.resetAllMocks();
    useAuth.mockReturnValue(makeAuthValue());
    goldApi.getCustomer.mockResolvedValue(customerOf());
    goldApi.getCustomerIdImages.mockResolvedValue({ front: "https://signed/f.jpg", back: "https://signed/b.jpg" });
    goldApi.getTtrReadiness.mockResolvedValue([]);
    goldApi.listTransactions.mockResolvedValue([]);
    goldApi.getCustomerNames.mockResolvedValue({});
    goldApi.findSameDayInvoicePurchases.mockResolvedValue([]);
    goldApi.findInvoicePurchases.mockResolvedValue([]);
    goldApi.createTransaction.mockResolvedValue({ purchaseId: "p1", ttr: null, warnings: {} });
    goldApi.searchCustomers.mockResolvedValue([]);
    format.compressImage.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
});
afterEach(cleanup);

describe("purchase form: the required boxes", () => {
    it("starts with the sighted box unticked and the hint under it (C3)", async () => {
        open();

        const box = await screen.findByRole("checkbox", { name: /Customer and ID sighted in person today/ });
        expect(box).not.toBeChecked();
        expect(screen.getByText("Doesn't match the record? Update ID first.")).toBeInTheDocument();
    });

    it("refuses to save without the sighted box and a photo, and says why", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await record(user);

        expect(await screen.findByText("Add at least one photo of the items purchased.")).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();

        await addPhoto(user);
        await record(user);
        expect(
            await screen.findByText(
                "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first."
            )
        ).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });

    it("refuses a phone number that is too short", async () => {
        const user = userEvent.setup();
        open();
        const phone = await screen.findByLabelText("Phone for this purchase");

        await user.clear(phone);
        await user.type(phone, "1234567");
        await record(user);

        expect(await screen.findByText("Phone number looks too short.")).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });
});

describe("purchase form: saving a purchase that is not reportable", () => {
    it("saves with just a photo and the sighted box, tells staff to add the invoice later, and empties the form", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await addPhoto(user);
        await tickSighted(user);
        await record(user);

        await waitFor(() => expect(goldApi.createTransaction).toHaveBeenCalledTimes(1));
        expect(goldApi.createTransaction.mock.calls[0][0]).toMatchObject({
            customerId: "c1",
            jointCustomerId: null,
            purchaseType: "scrap",
            cash10k: false,
            idSighted: true,
            erpInvoiceNo: "",
            ttrSelfConducted: null,
            ttrDetailsConfirmed: null,
        });
        expect(goldApi.createTransaction.mock.calls[0][0].photos).toHaveLength(1);
        expect(
            await screen.findByText("Purchase recorded. Add the invoice number later from To complete.")
        ).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /sighted in person today/ })).not.toBeChecked();
        expect(goldApi.goToAustracForm).not.toHaveBeenCalled();
        // The history is loaded again.
        await waitFor(() => expect(goldApi.listTransactions).toHaveBeenCalledTimes(2));
    });

    it("also saves the customer's phone when it was changed on the form", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerPhone.mockResolvedValue(true);
        open();
        const phone = await screen.findByLabelText("Phone for this purchase");

        await user.clear(phone);
        await user.type(phone, "0499 111 222");
        expect(screen.getByText(/Saving the purchase also updates the customer’s phone number/)).toBeInTheDocument();
        await addPhoto(user);
        await tickSighted(user);
        await record(user);

        await waitFor(() => expect(goldApi.updateCustomerPhone).toHaveBeenCalledWith("c1", "0499 111 222"));
    });

    it("shows the server's field errors when it refuses, and keeps what was entered", async () => {
        const user = userEvent.setup();
        goldApi.createTransaction.mockRejectedValue(
            new GoldApiError({
                status: 422,
                code: "validation_failed",
                body: { errors: { phone: "Enter the customer's phone number (8 or more digits)." } },
            })
        );
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await addPhoto(user);
        await tickSighted(user);
        await record(user);

        expect(await screen.findByText("Enter the customer's phone number (8 or more digits).")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Check the highlighted fields.");
        expect(screen.getByAltText("Goods photo 1")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /sighted in person today/ })).toBeChecked();
    });
});

describe("purchase form: reportable purchases (spec 3.3, 3.3a)", () => {
    it("asks the two counter questions, showing the details on file, only when the sale is reportable", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        expect(screen.queryByText("Are these details still correct?")).not.toBeInTheDocument();

        await cashYes(user);

        expect(
            screen.getByRole("radiogroup", { name: "Is Jane Citizen acting on their own behalf?" })
        ).toBeInTheDocument();
        const confirm = screen.getByText("Are these details still correct?").closest("div");
        expect(confirm).toHaveTextContent("1 Test St, Coburg VIC 3058");
        expect(confirm).toHaveTextContent("Jeweller");
        expect(confirm).toHaveTextContent("AU");
        expect(
            await screen.findByText(/No invoice number yet, so this purchase will be saved as AUSTRAC pending/)
        ).toBeInTheDocument();
    });

    it("does not save until both questions are answered", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await addPhoto(user);
        await tickSighted(user);
        await answerYes(user, "Is Jane Citizen acting on their own behalf?");

        await record(user);

        expect(await screen.findByText("Answer both questions.")).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });

    it("case A: both Yes saves without an invoice, sends the answers, and starts no report", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await addPhoto(user);
        await tickSighted(user);
        await answerYes(user, "Is Jane Citizen acting on their own behalf?");
        await answerYes(user, "Are these details still correct?");

        await record(user);

        await waitFor(() => expect(goldApi.createTransaction).toHaveBeenCalledTimes(1));
        expect(goldApi.createTransaction.mock.calls[0][0]).toMatchObject({
            cash10k: true,
            ttrSelfConducted: true,
            ttrDetailsConfirmed: true,
        });
        expect(
            await screen.findByText("Purchase recorded as AUSTRAC pending. Add the invoice number from To complete.")
        ).toBeInTheDocument();
        expect(goldApi.goToAustracForm).not.toHaveBeenCalled();
    });

    it("case B: a customer who is not ready has no questions and must give the invoice number now", async () => {
        const user = userEvent.setup();
        goldApi.getTtrReadiness.mockResolvedValue(["occupation", "gender"]);
        goldApi.getCustomer.mockResolvedValue(customerOf({ full_name: "Gold-only Gina" }));
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await addPhoto(user);
        await tickSighted(user);

        expect(screen.queryByText("Are these details still correct?")).not.toBeInTheDocument();
        await record(user);

        expect(
            await screen.findByText(
                "Enter the ERP invoice number. Gold-only Gina's AUSTRAC details are incomplete, so the report must be started now."
            )
        ).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });

    it("case B with an invoice: saves, starts the TTR and opens it", async () => {
        const user = userEvent.setup();
        goldApi.getTtrReadiness.mockResolvedValue(["occupation"]);
        goldApi.createTransaction.mockResolvedValue({ purchaseId: "p1", ttr: "B", warnings: {} });
        goldApi.goToAustracForm.mockResolvedValue({ ttrs: [{ id: "t1" }], path: "/open-ttr/t1" });
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await user.type(screen.getByLabelText("ERP invoice number"), "INV-B1");
        await addPhoto(user);
        await tickSighted(user);

        expect(
            await screen.findByRole("button", { name: "Record purchase and continue to AUSTRAC" })
        ).toBeInTheDocument();
        expect(screen.getByText(/the AUSTRAC form will open with this customer loaded/)).toBeInTheDocument();
        await record(user, "Record purchase and continue to AUSTRAC");

        await waitFor(() => expect(goldApi.goToAustracForm).toHaveBeenCalledWith("p1"));
        expect(await screen.findByTestId("where")).toHaveTextContent("/open-ttr/t1");
        expect(goldApi.createTransaction.mock.calls[0][0].erpInvoiceNo).toBe("INV-B1");
    });

    it("keeps the purchase and says so when the report could not be started", async () => {
        const user = userEvent.setup();
        goldApi.getTtrReadiness.mockResolvedValue(["occupation"]);
        goldApi.goToAustracForm.mockRejectedValue(new GoldApiError({ status: 409, code: "ttr_reference_in_use" }));
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await user.type(screen.getByLabelText("ERP invoice number"), "INV-B1");
        await addPhoto(user);
        await tickSighted(user);

        await record(user, "Record purchase and continue to AUSTRAC");

        expect(
            await screen.findByText(/Purchase recorded, but the AUSTRAC report could not be started/)
        ).toBeInTheDocument();
        expect(screen.queryByTestId("where")).not.toBeInTheDocument();
    });

    it("blocks a reportable purchase whose invoice is already used by another purchase", async () => {
        const user = userEvent.setup();
        goldApi.getTtrReadiness.mockResolvedValue(["occupation"]);
        goldApi.findInvoicePurchases.mockResolvedValue([{ id: "other" }]);
        open();
        await screen.findByRole("heading", { name: "Record purchase" });
        await cashYes(user);
        await user.type(screen.getByLabelText("ERP invoice number"), "INV-5");
        await addPhoto(user);
        await tickSighted(user);
        await waitFor(() => expect(goldApi.findInvoicePurchases).toHaveBeenCalledWith("INV-5"));

        await record(user, "Record purchase and continue to AUSTRAC");

        expect(
            await screen.findByText(
                "The ERP invoice number INV-5 is already used by another purchase. A reportable purchase needs its own invoice number."
            )
        ).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });

    it("only warns about a duplicate invoice when the purchase is not reportable", async () => {
        const user = userEvent.setup();
        goldApi.findInvoicePurchases.mockResolvedValue([{ id: "other" }]);
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await user.type(screen.getByLabelText("ERP invoice number"), "INV-6");

        expect(
            await screen.findByText("This invoice number is already recorded. Check it’s not a duplicate.")
        ).toBeInTheDocument();
        await addPhoto(user);
        await tickSighted(user);
        await record(user);
        await waitFor(() => expect(goldApi.createTransaction).toHaveBeenCalledTimes(1));
    });

    it("swaps the cash question for the linked-invoice panel when the invoice matches an earlier part today", async () => {
        const user = userEvent.setup();
        goldApi.findSameDayInvoicePurchases.mockResolvedValue([
            {
                id: "p0",
                purchase_type: "scrap",
                cash_amount: null,
                created_at: daysFromNow(0),
                ttr_transaction_id: null,
            },
        ]);
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await user.type(screen.getByLabelText("ERP invoice number"), "INV-7");

        expect(
            await screen.findByText("Same invoice as an earlier purchase today for this customer")
        ).toBeInTheDocument();
        expect(screen.queryByText("Paid in cash of $10,000 or more?")).not.toBeInTheDocument();
        await user.type(screen.getByLabelText("Cash paid on that part (AUD)"), "6000");
        await user.type(screen.getByLabelText("Cash paid for this part (AUD)"), "6000");
        expect(screen.getByText(/Cash on INV-7 today: \$12,000.00/)).toBeInTheDocument();
    });
});

describe("purchase form: the ID rules (C2)", () => {
    it("blocks a reportable purchase when the ID has expired, and Update ID now opens Update ID with a way back", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue(
            customerOf({ current_id: idOf({ expiry_date: daysFromNow(-3).slice(0, 10) }) })
        );
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await cashYes(user);

        const panel = screen.getByRole("alert");
        expect(panel).toHaveTextContent(
            "Update the ID before recording this cash purchase. An expired ID cannot go into an AUSTRAC report."
        );
        expect(screen.getByRole("button", { name: "Record purchase" })).toBeDisabled();
        await user.click(within(panel).getByRole("button", { name: "Update ID now" }));
        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/customers/c1/update-id returnTo");
    });

    it("lets a purchase that is not reportable go ahead with an expired ID, saying it is flagged", async () => {
        goldApi.getCustomer.mockResolvedValue(
            customerOf({ current_id: idOf({ expiry_date: daysFromNow(-3).slice(0, 10) }) })
        );
        open();

        expect(
            await screen.findByText(
                /ID on file has expired for Jane Citizen. This purchase will be saved with an expired-ID flag./
            )
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Record purchase" })).toBeEnabled();
    });

    it("blocks bullion with $5,000 or more in cash when the ID is outside the re-verification window", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: idOf({ captured_at: daysFromNow(-800) }) }));
        open();
        await screen.findByRole("heading", { name: "Record purchase" });

        await user.click(screen.getByRole("radio", { name: "Bullion" }));
        await user.click(screen.getByRole("radio", { name: "$5,000 to $9,999" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Bullion bought with $5,000 or more in cash needs a current ID"
        );
        expect(screen.getByRole("button", { name: "Record purchase" })).toBeDisabled();
    });

    it("explains that a customer with no ID on file needs one before a purchase", async () => {
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: null }));
        open();

        expect(await screen.findByText("Add the customer’s ID before recording a purchase.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Record purchase" })).not.toBeInTheDocument();
    });
});

describe("purchase form: the joint seller", () => {
    const joan = customerOf({ id: "c2", full_name: "Joan Smith", current_id: idOf({ document_number: "99887766" }) });

    const pickJoan = async (user) => {
        goldApi.searchCustomers.mockResolvedValue([
            { id: "c1", full_name: "Jane Citizen", current_id: null },
            { id: "c2", full_name: "Joan Smith", current_id: null },
        ]);
        goldApi.getCustomer.mockImplementation(async (id) => (id === "c2" ? joan : customerOf()));
        await user.click(await screen.findByRole("button", { name: "Add second person (joint sale)" }));
        await user.type(screen.getByLabelText("Search"), "jo");
        await user.click(await screen.findByRole("button", { name: /Joan Smith/ }));
    };

    it("adds the second person, changes the sighted wording, and Remove puts the button back", async () => {
        const user = userEvent.setup();
        open();

        await pickJoan(user);

        expect(await screen.findByText("Joint seller")).toBeInTheDocument();
        expect(screen.getByText("Joan Smith")).toBeInTheDocument();
        expect(screen.getByText("Driver licence 99887766")).toBeInTheDocument();
        expect(
            screen.getByRole("checkbox", { name: /Both people and their IDs sighted in person today/ })
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove" }));
        const add = await screen.findByRole("button", { name: "Add second person (joint sale)" });
        await waitFor(() => expect(add).toHaveFocus());
    });

    it("Escape closes the panel and the focus goes back to the Add button", async () => {
        const user = userEvent.setup();
        open();
        const add = await screen.findByRole("button", { name: "Add second person (joint sale)" });

        await user.click(add);
        expect(screen.getByRole("dialog", { name: "Add second person" })).toBeInTheDocument();
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(add).toHaveFocus();
    });

    it("a joint reportable sale is case B: no counter questions, and the invoice is needed now", async () => {
        const user = userEvent.setup();
        open();
        await pickJoan(user);
        await screen.findByText("Joint seller");
        await cashYes(user);
        await addPhoto(user);
        await tickSighted(user);

        expect(screen.queryByText("Are these details still correct?")).not.toBeInTheDocument();
        await record(user);

        expect(
            await screen.findByText(
                "Enter the ERP invoice number. The AUSTRAC report for Jane Citizen must be started now."
            )
        ).toBeInTheDocument();
        expect(goldApi.createTransaction).not.toHaveBeenCalled();
    });

    it("New customer opens the create form, remembering which purchase it is for", async () => {
        const user = userEvent.setup();
        open();

        await user.click(await screen.findByRole("button", { name: "Add second person (joint sale)" }));
        await user.click(screen.getByRole("button", { name: "New customer" }));

        expect(await screen.findByTestId("where")).toHaveTextContent("/gold/customers/new");
    });

    it("takes a joint seller handed back by the create form", async () => {
        goldApi.getCustomer.mockImplementation(async (id) => (id === "c2" ? joan : customerOf()));
        open({ pathname: "/gold/customers/c1", state: { notice: "Customer created", jointId: "c2" } });

        expect(await screen.findByText("Joint seller")).toBeInTheDocument();
        expect(screen.getByText("Joan Smith")).toBeInTheDocument();
    });
});

describe("purchase form: the unsaved form survives leaving the page", () => {
    it("keeps the invoice and the sighted box while staff look at another screen and come back", async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={["/gold/customers/c1"]}>
                <GoldDraftProvider>
                    <Routes>
                        <Route path="/gold/customers/:customerId" element={<GoldCustomerPage />} />
                        <Route path="/gold/purchases" element={<Link to="/gold/customers/c1">Back to Jane</Link>} />
                    </Routes>
                    <Link to="/gold/purchases">Purchases</Link>
                </GoldDraftProvider>
            </MemoryRouter>
        );
        await user.type(await screen.findByLabelText("ERP invoice number"), "INV-9");
        await tickSighted(user);

        await user.click(screen.getByRole("link", { name: "Purchases" }));
        await user.click(await screen.findByRole("link", { name: "Back to Jane" }));

        expect(await screen.findByLabelText("ERP invoice number")).toHaveValue("INV-9");
        expect(screen.getByRole("checkbox", { name: /sighted in person today/ })).toBeChecked();
    });
});

describe("purchase history", () => {
    it("lists purchases newest first with invoice, tags, time, photos and the other seller of a joint sale", async () => {
        goldApi.listTransactions.mockResolvedValue([
            {
                id: "p2",
                customer_id: "c1",
                joint_customer_id: "c2",
                erp_invoice_no: null,
                purchase_type: "scrap",
                cash_10k_or_more: true,
                ttr_status: null,
                created_at: "2026-11-05T01:00:00Z",
                photo_count: 1,
            },
            {
                id: "p1",
                customer_id: "c1",
                joint_customer_id: null,
                erp_invoice_no: "INV-1",
                purchase_type: "bullion",
                cash_10k_or_more: true,
                ttr_status: "complete",
                created_at: "2026-11-04T01:00:00Z",
                photo_count: 2,
            },
        ]);
        goldApi.getCustomerNames.mockResolvedValue({ c2: "Joan Smith" });
        open();

        const first = await screen.findByRole("link", { name: "View purchase with no invoice number" });
        expect(first).toHaveAttribute("href", "/gold/purchases/p2");
        expect(first).toHaveTextContent("No invoice number yet");
        const rows = screen.getAllByRole("listitem").filter((item) => item.textContent.includes("photo"));
        expect(rows[0]).toHaveTextContent("Incomplete");
        expect(rows[0]).toHaveTextContent("AUSTRAC pending");
        expect(rows[0]).toHaveTextContent("1 photo");
        expect(within(rows[0]).getByRole("link", { name: "Joan Smith" })).toHaveAttribute("href", "/gold/customers/c2");
        expect(rows[1]).toHaveTextContent("INV-1");
        expect(rows[1]).toHaveTextContent("2 photos");
        expect(rows[1]).toHaveTextContent(/AUSTRAC/);
        expect(rows[1]).not.toHaveTextContent("AUSTRAC pending");
        expect(rows[1]).not.toHaveTextContent("Incomplete");
    });
});
