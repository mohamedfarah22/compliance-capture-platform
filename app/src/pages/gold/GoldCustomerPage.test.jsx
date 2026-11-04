import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import * as goldApi from "../../lib/goldApi.js";
import { GoldApiError } from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldCustomerPage from "./GoldCustomerPage.jsx";
import { GoldDraftProvider } from "./shared/index.js";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    getCustomer: vi.fn(),
    getCustomerIdImages: vi.fn(),
    updateCustomerPhone: vi.fn(),
    getTtrReadiness: vi.fn(),
    listTransactions: vi.fn(),
    getCustomerNames: vi.fn(),
}));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));

// Seeded relative to now, so the ID states hold on any day the test runs.
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();
const dateFromNow = (n) => daysFromNow(n).slice(0, 10);

const idOf = (overrides = {}) => ({
    document_type: "Driver licence",
    document_number: "012345678",
    issuer: "VIC",
    id_country_code: "AU",
    has_expiry: true,
    expiry_date: dateFromNow(900),
    captured_at: daysFromNow(-30),
    captured_by_name: "Sam Counter",
    front_image_id: "img-f",
    back_image_id: "img-b",
    ...overrides,
});
const customerOf = (overrides = {}) => ({
    id: "c1",
    full_name: "Jane Q Citizen",
    first_name: "Jane",
    last_name: "Citizen",
    date_of_birth: "1985-11-15",
    phone: "0412 345 678",
    res_street: "1 Test St",
    res_suburb: "Coburg",
    res_state: "VIC",
    res_postcode: "3058",
    created_at: "2025-11-02T02:10:00Z",
    aliases: [],
    current_id: idOf(),
    ...overrides,
});

const UpdateIdLanding = () => <h1>Update ID screen</h1>;
const SearchLanding = () => <h1>Find customer</h1>;
const EditLanding = () => <h1>Edit screen</h1>;
const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const open = ({ entry = "/gold/customers/c1" } = {}) =>
    render(
        <MemoryRouter initialEntries={[entry]}>
            <GoldDraftProvider>
                <Routes>
                    <Route path="/gold" element={<SearchLanding />} />
                    <Route
                        path="/gold/customers/:customerId"
                        element={
                            <>
                                <GoldCustomerPage />
                                <Where />
                            </>
                        }
                    />
                    <Route path="/gold/customers/:customerId/update-id" element={<UpdateIdLanding />} />
                    <Route path="/gold/customers/:customerId/edit" element={<EditLanding />} />
                </Routes>
            </GoldDraftProvider>
        </MemoryRouter>
    );

const asRole = (role) =>
    useAuth.mockReturnValue(makeAuthValue({ staffMember: { ...makeAuthValue().staffMember, role } }));

beforeEach(() => {
    vi.resetAllMocks();
    useAuth.mockReturnValue(makeAuthValue());
    goldApi.getCustomer.mockResolvedValue(customerOf());
    goldApi.getCustomerIdImages.mockResolvedValue({
        front: "https://signed/front.jpg",
        back: "https://signed/back.jpg",
    });
    goldApi.getTtrReadiness.mockResolvedValue([]);
    goldApi.listTransactions.mockResolvedValue([]);
    goldApi.getCustomerNames.mockResolvedValue({});
});
afterEach(cleanup);

describe("GoldCustomerPage: details", () => {
    it("shows the customer, their current ID, and when it was last updated", async () => {
        open();

        expect(await screen.findByRole("heading", { name: "Jane Q Citizen" })).toBeInTheDocument();
        const details = screen.getByText("Date of birth").closest("dl");
        for (const [term, value] of [
            ["Phone", /0412 345 678/],
            ["Date of birth", /15 Nov 1985/],
            ["Address", "1 Test St, Coburg VIC 3058"],
            ["ID type", "Driver licence"],
            ["ID number", "012345678"],
            ["Issuer", "VIC"],
            ["Customer since", "02 Nov 2025"],
            ["ID captured by", "Sam Counter"],
        ]) {
            const description = Array.from(details.querySelectorAll("dt")).find(
                (dt) => dt.textContent === term
            ).nextSibling;
            expect(description).toHaveTextContent(value);
        }
        // "ID last updated" is the current capture's date, not the customer's.
        const lastUpdated = Array.from(details.querySelectorAll("dt")).find(
            (dt) => dt.textContent === "ID last updated"
        );
        expect(lastUpdated.nextSibling.textContent).not.toBe("02 Nov 2025");
        expect(lastUpdated.nextSibling.textContent).toMatch(/^\d{2} \w+ \d{4}$/);
    });

    it("shows aliases", async () => {
        goldApi.getCustomer.mockResolvedValue(customerOf({ aliases: ["Janey C", "J Citizen"] }));
        open();

        expect(await screen.findByText("Also known as Janey C, J Citizen")).toBeInTheDocument();
    });

    it("says so when the customer is not found, and links back", async () => {
        goldApi.getCustomer.mockRejectedValue(new GoldApiError({ status: 404, code: "customer_not_found" }));
        open();

        expect(await screen.findByText(/Customer not found/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to Find customer" })).toHaveAttribute("href", "/gold");
    });

    it("has the purchase form and the history beside the details, and Back to search", async () => {
        open();

        await screen.findByRole("heading", { name: "Jane Q Citizen" });
        expect(screen.getByRole("heading", { name: "Record purchase" })).toBeInTheDocument();
        expect(await screen.findByText("No purchases recorded for this customer yet.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to search" })).toHaveAttribute("href", "/gold");
    });

    it("shows a notice handed on by the screen before, once", async () => {
        render(
            <MemoryRouter initialEntries={[{ pathname: "/gold/customers/c1", state: { notice: "Customer created" } }]}>
                <GoldDraftProvider>
                    <Routes>
                        <Route path="/gold/customers/:customerId" element={<GoldCustomerPage />} />
                    </Routes>
                </GoldDraftProvider>
            </MemoryRouter>
        );

        expect(await screen.findByRole("status")).toHaveTextContent("Customer created");
    });
});

describe("GoldCustomerPage: ID state", () => {
    it("valid: no banner, an Update ID button", async () => {
        open();

        await screen.findByRole("heading", { name: "Jane Q Citizen" });
        expect(screen.getByText(/^ID valid to/)).toBeInTheDocument();
        expect(screen.queryByText(/Update ID now/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Update ID" })).toBeInTheDocument();
    });

    it("expired: a red banner with Update ID now, which opens Update ID", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: idOf({ expiry_date: dateFromNow(-1) }) }));
        open();

        expect(await screen.findByText(/^ID expired on/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Update ID now" }));

        expect(await screen.findByRole("heading", { name: "Update ID screen" })).toBeInTheDocument();
    });

    it("older than the business's window: an amber re-verify notice naming the window", async () => {
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: idOf({ captured_at: daysFromNow(-800) }) }));
        open();

        expect(await screen.findByText("ID needs re-verifying")).toBeInTheDocument();
        expect(screen.getByText(/more than 730 days ago/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Update ID now" })).toBeInTheDocument();
        expect(screen.getByText("Re-verify ID")).toBeInTheDocument();
    });

    it("expiring soon: an amber hint", async () => {
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: idOf({ expiry_date: dateFromNow(12) }) }));
        open();

        expect(await screen.findByText(/ID expires soon/)).toBeInTheDocument();
    });

    it("no ID on file: Add ID", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: null }));
        open();

        expect(await screen.findByText("No ID on file", { selector: "p" })).toBeInTheDocument();
        expect(screen.queryByText("ID last updated")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add ID" }));
        expect(await screen.findByRole("heading", { name: "Update ID screen" })).toBeInTheDocument();
    });
});

describe("GoldCustomerPage: ID photos", () => {
    it("opens a photo larger, Escape closes it, and the focus goes back to the thumbnail", async () => {
        const user = userEvent.setup();
        open();
        const thumbnail = await screen.findByRole("button", { name: /ID front/ });
        await waitFor(() => expect(screen.getByRole("img", { name: "ID front" })).toBeInTheDocument());

        await user.click(thumbnail);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(thumbnail).toHaveFocus();
    });

    it("says Not on file for a side with no photo, and Photo unavailable when it could not be signed", async () => {
        goldApi.getCustomer.mockResolvedValue(customerOf({ current_id: idOf({ back_image_id: null }) }));
        goldApi.getCustomerIdImages.mockResolvedValue({ front: null, back: null });
        open();

        await screen.findByRole("heading", { name: "Jane Q Citizen" });
        await waitFor(() => expect(goldApi.getCustomerIdImages).toHaveBeenCalled());
        expect(screen.getByText("Photo unavailable")).toBeInTheDocument();
        expect(screen.getByText("Not on file")).toBeInTheDocument();
    });
});

describe("GoldCustomerPage: phone", () => {
    it("changes the phone in place and says so", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerPhone.mockResolvedValue(true);
        open();
        await user.click(await screen.findByRole("button", { name: "Change" }));

        const input = screen.getByLabelText("Phone");
        expect(input).toHaveValue("0412 345 678");
        await user.clear(input);
        await user.type(input, "0499 888 777{Enter}");

        expect(goldApi.updateCustomerPhone).toHaveBeenCalledWith("c1", "0499 888 777");
        expect(await screen.findByText("0499 888 777", { exact: false })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("Phone number updated");
        await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toHaveFocus());
    });

    it("refuses fewer than 8 digits without calling the server, and keeps the old number on Escape", async () => {
        const user = userEvent.setup();
        open();
        await user.click(await screen.findByRole("button", { name: "Change" }));
        const input = screen.getByLabelText("Phone");

        await user.clear(input);
        await user.type(input, "1234567");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Phone number looks too short.");
        expect(goldApi.updateCustomerPhone).not.toHaveBeenCalled();

        await user.keyboard("{Escape}");
        expect(screen.queryByLabelText("Phone")).not.toBeInTheDocument();
        expect(screen.getByText(/0412 345 678/)).toBeInTheDocument();
    });

    it("shows what the server says when it refuses", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerPhone.mockRejectedValue(new GoldApiError({ code: "forbidden" }));
        open();
        await user.click(await screen.findByRole("button", { name: "Change" }));
        await user.clear(screen.getByLabelText("Phone"));
        await user.type(screen.getByLabelText("Phone"), "0499 888 777");

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to do that.");
        expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    });
});

describe("GoldCustomerPage: Edit details", () => {
    it.each(["manager", "admin"])("is offered to a %s and opens Edit", async (role) => {
        const user = userEvent.setup();
        asRole(role);
        open();

        await user.click(await screen.findByRole("button", { name: "Edit details" }));

        expect(await screen.findByRole("heading", { name: "Edit screen" })).toBeInTheDocument();
    });

    it("is not offered to staff", async () => {
        asRole("staff");
        open();

        await screen.findByRole("heading", { name: "Jane Q Citizen" });
        expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    });
});
