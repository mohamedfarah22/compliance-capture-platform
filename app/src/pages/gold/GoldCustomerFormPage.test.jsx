import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { GoldApiError } from "../../lib/goldApi.js";
import * as goldApi from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldCustomerFormPage from "./GoldCustomerFormPage.jsx";

vi.mock("../../lib/goldApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    createCustomer: vi.fn(),
    findIdOwner: vi.fn(),
    findPossibleDuplicates: vi.fn(),
    getCustomer: vi.fn(),
    updateCustomerDetails: vi.fn(),
    updateCustomerId: vi.fn(),
}));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));
vi.mock("../../lib/supabase.js", () => ({ supabase: {} }));
const formatMocks = vi.hoisted(() => ({ compressImage: vi.fn(), blobToDataURL: vi.fn() }));
vi.mock("./shared/format.js", async (importOriginal) => ({ ...(await importOriginal()), ...formatMocks }));

const jane = {
    id: "c1",
    first_name: "Jane",
    middle_name: null,
    last_name: "Citizen",
    full_name: "Jane Citizen",
    date_of_birth: "1985-06-15",
    gender: "F",
    phone: "0412 345 678",
    email: null,
    occupation: null,
    res_street: "1 Test St",
    res_suburb: "Coburg",
    res_state: "VIC",
    res_postcode: "3058",
    citizenship_country_code: null,
    tax_residency_country_code: null,
    aliases: [],
    current_id: {
        document_type: "Driver licence",
        document_number: "012345678",
        issuer: "VIC",
        id_country_code: "AU",
        has_expiry: true,
        expiry_date: "2099-01-01",
        captured_at: new Date().toISOString(),
    },
};

const CustomerLanding = () => {
    const { customerId } = useParams();
    const { state } = useLocation();
    return (
        <>
            <p>
                Customer page {customerId}: {state?.notice}
            </p>
            <p data-testid="joint">{state?.jointId}</p>
        </>
    );
};

const renderPage = ({ path, mode }) => {
    const route = {
        create: "/gold/customers/new",
        update: "/gold/customers/:customerId/update-id",
        edit: "/gold/customers/:customerId/edit",
    }[mode];
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/gold" element={<h1>Find customer</h1>} />
                <Route path={route} element={<GoldCustomerFormPage mode={mode} />} />
                <Route path="/gold/customers/:customerId" element={<CustomerLanding />} />
            </Routes>
        </MemoryRouter>
    );
};

const photo = (name) => new File(["x"], name, { type: "image/png" });
const uploadFront = (user) => user.upload(screen.getByLabelText("ID front file"), photo("front.png"));
const uploadBack = (user) => user.upload(screen.getByLabelText(/ID back.* file/), photo("back.png"));

const fillPerson = async (user) => {
    await user.type(screen.getByLabelText("First name"), "Jane");
    await user.type(screen.getByLabelText("Last name"), "Citizen");
    await user.type(screen.getByLabelText("Date of birth"), "15/06/1985");
    await user.type(screen.getByLabelText("Phone"), "0412 345 678");
    await user.type(screen.getByLabelText("Street address"), "1 Test St");
    await user.type(screen.getByLabelText("Suburb"), "Coburg");
    await user.selectOptions(screen.getByLabelText("State"), "VIC");
    await user.type(screen.getByLabelText("Postcode"), "3058");
};

const fillId = async (user) => {
    await user.type(screen.getByLabelText("ID number"), "012345678");
    await user.type(screen.getByLabelText("Issuer"), "VIC");
    await user.click(screen.getByRole("radio", { name: "Yes" }));
    await user.type(screen.getByLabelText("ID expiry date"), "01/01/2099");
    await uploadFront(user);
    await uploadBack(user);
    await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));
};

beforeEach(() => {
    vi.resetAllMocks();
    useAuth.mockReturnValue(makeAuthValue());
    goldApi.findPossibleDuplicates.mockResolvedValue([]);
    goldApi.findIdOwner.mockResolvedValue(null);
    // resetAllMocks cleared the photo mocks' implementations too.
    formatMocks.compressImage.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    formatMocks.blobToDataURL.mockResolvedValue("data:image/jpeg;base64,AA==");
});
afterEach(cleanup);

describe("GoldCustomerFormPage: create", () => {
    const open = () => renderPage({ path: "/gold/customers/new", mode: "create" });

    it("shows the New customer form with every required field", () => {
        open();

        expect(screen.getByRole("heading", { name: "New customer" })).toBeInTheDocument();
        for (const label of [
            "First name",
            "Middle name (optional)",
            "Last name",
            "Date of birth",
            "Phone",
            "Street address",
            "Suburb",
            "State",
            "Postcode",
            "ID type",
            "ID number",
            "Issuer",
            "Country of issue",
        ]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
        expect(screen.getByRole("radiogroup", { name: "Does the ID have an expiry date?" })).toBeInTheDocument();
        expect(screen.getByRole("group", { name: "ID front" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /sighted the original ID/ })).not.toBeChecked();
    });

    it("refuses an empty form, says what to do for each field, and sends nothing", async () => {
        const user = userEvent.setup();
        open();

        await user.click(screen.getByRole("button", { name: "Create customer" }));

        expect(screen.getByText("Check the highlighted fields.")).toBeInTheDocument();
        expect(screen.getByText("Enter the first name.")).toBeInTheDocument();
        expect(screen.getByText("Enter the date of birth as DD/MM/YYYY.")).toBeInTheDocument();
        expect(screen.getByText("Enter the ID number.")).toBeInTheDocument();
        expect(screen.getByText("Say whether the ID has an expiry date.")).toBeInTheDocument();
        expect(screen.getByText("Take or upload a photo of the front of the ID.")).toBeInTheDocument();
        expect(screen.getByText("Take or upload a photo of the back of the ID.")).toBeInTheDocument();
        expect(screen.getByText("Confirm you have checked the original ID in person.")).toBeInTheDocument();
        expect(goldApi.createCustomer).not.toHaveBeenCalled();
    });

    it("needs the back photo for a driver licence and not for a passport", async () => {
        const user = userEvent.setup();
        open();
        expect(screen.getByRole("group", { name: "ID back" })).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("ID type"), "Passport");

        expect(screen.getByRole("group", { name: "ID back (optional)" })).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("ID type"), "Other");
        await user.click(screen.getByRole("button", { name: "Create customer" }));
        expect(screen.getByText("Describe the document.")).toBeInTheDocument();
    });

    it("hides the expiry date when the ID has none", async () => {
        const user = userEvent.setup();
        open();

        await user.click(screen.getByRole("radio", { name: "Yes" }));
        expect(screen.getByLabelText("ID expiry date")).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: "No" }));
        expect(screen.queryByLabelText("ID expiry date")).not.toBeInTheDocument();
    });

    it("creates the customer and opens their page with a notice", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer.mockResolvedValue({ customerId: "new-1" });
        open();
        await fillPerson(user);
        await fillId(user);

        await user.click(screen.getByRole("button", { name: "Create customer" }));

        await screen.findByText("Customer page new-1: Customer created");
        expect(goldApi.createCustomer).toHaveBeenCalledWith({
            firstName: "Jane",
            middleName: "",
            lastName: "Citizen",
            dateOfBirth: "1985-06-15",
            phone: "0412 345 678",
            residentialAddress: { street: "1 Test St", suburb: "Coburg", state: "VIC", postcode: "3058" },
            id: {
                documentType: "Driver licence",
                documentNumber: "012345678",
                issuer: "VIC",
                idCountryCode: "AU",
                hasExpiry: true,
                expiryDate: "2099-01-01",
            },
            confirmNew: false,
            differentPerson: false,
            front: expect.any(Blob),
            back: expect.any(Blob),
        });
        expect(goldApi.createCustomer.mock.calls[0][0].front.type).toBe("image/jpeg");
    });

    it("saves once when Create is clicked twice", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer.mockReturnValue(new Promise(() => {}));
        open();
        await fillPerson(user);
        await fillId(user);

        await user.click(screen.getByRole("button", { name: "Create customer" }));
        await user.click(screen.getByRole("button", { name: "Saving…" }));

        expect(goldApi.createCustomer).toHaveBeenCalledTimes(1);
    });

    it("warns about a possible duplicate from the server, and creates only after 'different person'", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer
            .mockRejectedValueOnce(
                new GoldApiError({
                    status: 409,
                    code: "possible_duplicates",
                    body: {
                        duplicates: [
                            {
                                customerId: "c9",
                                firstName: "Jane",
                                lastName: "Citizen",
                                dateOfBirth: "1985-06-15",
                                phone: "0412 345 678",
                                matchReason: "name_dob",
                            },
                        ],
                    },
                })
            )
            .mockResolvedValueOnce({ customerId: "new-2" });
        open();
        await fillPerson(user);
        await fillId(user);
        await user.click(screen.getByRole("button", { name: "Create customer" }));

        const prompt = await screen.findByText("This may be an existing customer");
        expect(within(prompt.parentElement).getByText(/same name and date of birth/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Create customer" })).toBeEnabled();

        await user.click(screen.getByRole("button", { name: "It’s a different person, continue" }));
        expect(screen.queryByText("This may be an existing customer")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Create customer" }));

        await screen.findByText(/Customer page new-2/);
        expect(goldApi.createCustomer).toHaveBeenLastCalledWith(expect.objectContaining({ confirmNew: true }));
    });

    it("opens the existing customer from the duplicate prompt", async () => {
        const user = userEvent.setup();
        goldApi.findPossibleDuplicates.mockResolvedValue([
            {
                customerId: "c9",
                firstName: "Jane",
                lastName: "Citizen",
                dateOfBirth: "1985-06-15",
                phone: "0412 345 678",
                matchReason: "phone",
            },
        ]);
        open();
        await fillPerson(user);
        await user.tab(); // leaves the postcode; the phone and name blur lookups ran before

        await user.click(await screen.findByRole("button", { name: "Open this customer" }));

        await screen.findByText(/Customer page c9/);
    });

    it("looks for duplicates when name, date of birth and phone are left, and stops asking once edited", async () => {
        const user = userEvent.setup();
        goldApi.findPossibleDuplicates.mockResolvedValue([
            {
                customerId: "c9",
                firstName: "Jane",
                lastName: "Citizen",
                dateOfBirth: "1985-06-15",
                phone: "0412 345 678",
                matchReason: "phone",
            },
        ]);
        open();
        await fillPerson(user);

        expect(goldApi.findPossibleDuplicates).toHaveBeenLastCalledWith(
            expect.objectContaining({
                firstName: "Jane",
                lastName: "Citizen",
                dateOfBirth: "1985-06-15",
                phone: "0412 345 678",
            })
        );
        expect(await screen.findByText(/same phone/)).toBeInTheDocument();

        await user.type(screen.getByLabelText("Phone"), "9");
        expect(screen.queryByText(/same phone/)).not.toBeInTheDocument();
    });

    it("offers 'Open that customer' or 'different person' when the ID number is already on file", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer
            .mockRejectedValueOnce(
                new GoldApiError({
                    status: 409,
                    code: "id_on_file",
                    body: { owner: { customerId: "c9", name: "Mark Nguyen", dateOfBirth: "1990-01-02" } },
                })
            )
            .mockResolvedValueOnce({ customerId: "new-3" });
        open();
        await fillPerson(user);
        await fillId(user);
        await user.click(screen.getByRole("button", { name: "Create customer" }));

        expect(await screen.findByText(/belongs to Mark Nguyen \(born 02 Jan 1990\)/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open that customer" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "It’s a different person, continue" }));
        await user.click(screen.getByRole("button", { name: "Create customer" }));

        await screen.findByText(/Customer page new-3/);
        expect(goldApi.createCustomer).toHaveBeenLastCalledWith(expect.objectContaining({ differentPerson: true }));
    });

    it("checks the ID number as soon as it is left", async () => {
        const user = userEvent.setup();
        goldApi.findIdOwner.mockResolvedValue({ customerId: "c9", name: "Mark Nguyen", dateOfBirth: null });
        open();

        await user.type(screen.getByLabelText("ID number"), "PA123");
        await user.tab();

        expect(goldApi.findIdOwner).toHaveBeenCalledWith({ documentType: "Driver licence", documentNumber: "PA123" });
        expect(await screen.findByText(/belongs to Mark Nguyen/)).toBeInTheDocument();
    });

    it("shows the server's field messages on the fields, and keeps what was typed", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer.mockRejectedValue(
            new GoldApiError({
                status: 400,
                code: "validation_failed",
                body: {
                    fields: {
                        "residentialAddress.street": "Enter the street address, please.",
                        frontImage: "Photo is empty. Take it again.",
                    },
                },
            })
        );
        open();
        await fillPerson(user);
        await fillId(user);

        await user.click(screen.getByRole("button", { name: "Create customer" }));

        expect(await screen.findByText("Enter the street address, please.")).toBeInTheDocument();
        expect(screen.getByText("Photo is empty. Take it again.")).toBeInTheDocument();
        expect(screen.getByLabelText("First name")).toHaveValue("Jane");
        expect(screen.getByRole("button", { name: "Create customer" })).toBeEnabled();
    });

    it("shows a generic failure and stays on the form", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer.mockRejectedValue(new GoldApiError({ status: 500, code: "create_failed" }));
        open();
        await fillPerson(user);
        await fillId(user);

        await user.click(screen.getByRole("button", { name: "Create customer" }));

        expect(await screen.findByText("Could not save. Try again.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "New customer" })).toBeInTheDocument();
    });

    it("Cancel returns to Find customer", async () => {
        const user = userEvent.setup();
        open();

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.getByRole("heading", { name: "Find customer" })).toBeInTheDocument();
        expect(goldApi.createCustomer).not.toHaveBeenCalled();
    });

    it("says when a photo cannot be read and keeps the form", async () => {
        const user = userEvent.setup();
        formatMocks.compressImage.mockRejectedValueOnce(
            new Error("That photo could not be read. Take it again, or choose a JPEG.")
        );
        open();

        await user.upload(screen.getByLabelText("ID front file"), new File(["x"], "x.heic", { type: "image/heic" }));

        expect(await screen.findByText(/That photo could not be read/)).toBeInTheDocument();
        expect(screen.getByRole("group", { name: "ID front" })).toHaveTextContent("No photo yet");
    });
});

describe("GoldCustomerFormPage: sent here by a purchase form", () => {
    it("creating the joint seller goes back to the main seller's page, handing the new customer on", async () => {
        const user = userEvent.setup();
        goldApi.createCustomer.mockResolvedValue({ customerId: "new-1" });
        renderPage({ path: { pathname: "/gold/customers/new", state: { jointFor: "main-1" } }, mode: "create" });
        await fillPerson(user);
        await fillId(user);

        await user.click(screen.getByRole("button", { name: "Create customer" }));

        await screen.findByText("Customer page main-1: Customer created");
        expect(screen.getByTestId("joint")).toHaveTextContent("new-1");
    });

    it("Cancel on the joint seller's create form goes back to the main seller", async () => {
        const user = userEvent.setup();
        renderPage({ path: { pathname: "/gold/customers/new", state: { jointFor: "main-1" } }, mode: "create" });

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await screen.findByText(/Customer page main-1/);
    });

    it("updating a seller's ID goes back to the purchase's customer, not to the seller", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue(jane);
        goldApi.updateCustomerId.mockResolvedValue({ superseded: 0 });
        renderPage({
            path: { pathname: "/gold/customers/c1/update-id", state: { returnTo: "main-1" } },
            mode: "update",
        });
        await user.click(await screen.findByRole("radio", { name: /Renewed/ }));
        await user.click(screen.getByRole("radio", { name: "Yes" }));
        await user.type(screen.getByLabelText("ID expiry date"), "01/01/2099");
        await uploadFront(user);
        await uploadBack(user);
        await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));

        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        await screen.findByText("Customer page main-1: ID updated");
    });
});

describe("GoldCustomerFormPage: update ID", () => {
    const open = () => renderPage({ path: "/gold/customers/c1/update-id", mode: "update" });

    beforeEach(() => {
        goldApi.getCustomer.mockResolvedValue(jane);
    });

    it("shows the ID on file and a required reason before the form", async () => {
        const user = userEvent.setup();
        open();

        expect(await screen.findByRole("heading", { name: "Update ID" })).toBeInTheDocument();
        expect(screen.getByText(/Jane Citizen \| On file: Driver licence 012345678/)).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /Renewed/ })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /different document/ })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /photo is unclear/ })).toBeInTheDocument();
        expect(screen.queryByLabelText("ID number")).not.toBeInTheDocument();

        await user.click(screen.getByRole("radio", { name: /Renewed/ }));
        expect(screen.getByLabelText("ID number")).toHaveValue("012345678");
        expect(screen.getByText(/old photos of this document are replaced/)).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: /different document/ }));
        expect(screen.queryByText(/old photos of this document are replaced/)).not.toBeInTheDocument();
    });

    it("records a renewal: same number, new expiry, new photos", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerId.mockResolvedValue({ superseded: 2 });
        open();
        await user.click(await screen.findByRole("radio", { name: /Renewed/ }));
        await user.click(screen.getByRole("radio", { name: "Yes" }));
        await user.type(screen.getByLabelText("ID expiry date"), "01/01/2099");
        await uploadFront(user);
        await uploadBack(user);
        await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));

        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        await screen.findByText("Customer page c1: ID updated");
        expect(goldApi.updateCustomerId).toHaveBeenCalledWith("c1", {
            reason: "renewed",
            documentType: "Driver licence",
            documentNumber: "012345678",
            issuer: "VIC",
            idCountryCode: "AU",
            hasExpiry: true,
            expiryDate: "2099-01-01",
            front: expect.any(Blob),
            back: expect.any(Blob),
        });
    });

    it("refuses to save without a reason", async () => {
        const user = userEvent.setup();
        open();
        await screen.findByRole("heading", { name: "Update ID" });

        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        expect(screen.getByText("Choose why you are updating the ID.")).toBeInTheDocument();
        expect(goldApi.updateCustomerId).not.toHaveBeenCalled();
    });

    it("starts a different document blank", async () => {
        const user = userEvent.setup();
        open();
        await user.click(await screen.findByRole("radio", { name: /different document/ }));

        expect(screen.getByLabelText("ID number")).toHaveValue("");
        expect(screen.getByLabelText("Issuer")).toHaveValue("");
    });

    it("shows the server's answer when the document is not on file", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerId.mockRejectedValue(new GoldApiError({ status: 409, code: "document_not_on_file" }));
        open();
        await user.click(await screen.findByRole("radio", { name: /photo is unclear/ }));
        await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));
        await uploadFront(user);
        await uploadBack(user);

        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        expect(await screen.findByText(/not on file for this customer/)).toBeInTheDocument();
    });

    it("shows the owner when the number is already on file for someone else", async () => {
        const user = userEvent.setup();
        goldApi.updateCustomerId.mockRejectedValue(
            new GoldApiError({ status: 409, code: "id_on_file", body: { owner: { name: "Mark Nguyen" } } })
        );
        open();
        await user.click(await screen.findByRole("radio", { name: /different document/ }));
        await user.type(screen.getByLabelText("ID number"), "PA1");
        await user.type(screen.getByLabelText("Issuer"), "AU");
        await user.click(screen.getByRole("radio", { name: "No" }));
        await uploadFront(user);
        await uploadBack(user);
        await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));

        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        expect(await screen.findByText(/already on file for Mark Nguyen/)).toBeInTheDocument();
    });

    it("with no ID on file there is no reason to pick: the new ID is a different document", async () => {
        const user = userEvent.setup();
        goldApi.getCustomer.mockResolvedValue({ ...jane, current_id: null });
        goldApi.updateCustomerId.mockResolvedValue({});
        open();

        await screen.findByRole("heading", { name: "Update ID" });
        expect(screen.getByText(/No ID is on file/)).toBeInTheDocument();
        expect(screen.queryByRole("radio", { name: /Renewed/ })).not.toBeInTheDocument();

        await user.type(screen.getByLabelText("ID number"), "PA1");
        await user.type(screen.getByLabelText("Issuer"), "AU");
        await user.click(screen.getByRole("radio", { name: "No" }));
        await uploadFront(user);
        await uploadBack(user);
        await user.click(screen.getByRole("checkbox", { name: /sighted the original ID/ }));
        await user.click(screen.getByRole("button", { name: "Save new ID" }));

        await waitFor(() =>
            expect(goldApi.updateCustomerId).toHaveBeenCalledWith(
                "c1",
                expect.objectContaining({ reason: "different_document" })
            )
        );
    });

    it("says so when the customer is not found", async () => {
        goldApi.getCustomer.mockRejectedValue(new GoldApiError({ status: 404, code: "customer_not_found" }));
        open();

        expect(await screen.findByText(/Customer not found/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to Find customer" })).toHaveAttribute("href", "/gold");
    });
});

describe("GoldCustomerFormPage: edit details", () => {
    const open = () => renderPage({ path: "/gold/customers/c1/edit", mode: "edit" });
    const asRole = (role) =>
        useAuth.mockReturnValue(makeAuthValue({ staffMember: { ...makeAuthValue().staffMember, role } }));

    beforeEach(() => {
        goldApi.getCustomer.mockResolvedValue(jane);
    });

    it("is closed to staff and loads nothing", () => {
        asRole("staff");
        open();

        expect(screen.getByText("You are not authorised to view this page.")).toBeInTheDocument();
        expect(goldApi.getCustomer).not.toHaveBeenCalled();
    });

    it.each(["manager", "admin"])("opens for a %s, prefilled, with no ID fields", async (role) => {
        asRole(role);
        open();

        expect(await screen.findByRole("heading", { name: "Edit details" })).toBeInTheDocument();
        expect(screen.getByLabelText("First name")).toHaveValue("Jane");
        expect(screen.getByLabelText("Date of birth")).toHaveValue("15/06/1985");
        expect(screen.getByLabelText("Gender")).toHaveValue("F");
        expect(screen.getByLabelText("State")).toHaveValue("VIC");
        expect(screen.queryByLabelText("ID number")).not.toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: /sighted/ })).not.toBeInTheDocument();
    });

    it("refuses a save with nothing changed", async () => {
        const user = userEvent.setup();
        asRole("manager");
        open();
        await screen.findByRole("heading", { name: "Edit details" });

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(screen.getByText("Change at least one field.")).toBeInTheDocument();
        expect(goldApi.updateCustomerDetails).not.toHaveBeenCalled();
    });

    it("sends only what changed", async () => {
        const user = userEvent.setup();
        asRole("manager");
        goldApi.updateCustomerDetails.mockResolvedValue({ changed: ["last_name"] });
        open();
        await screen.findByRole("heading", { name: "Edit details" });

        await user.clear(screen.getByLabelText("Last name"));
        await user.type(screen.getByLabelText("Last name"), "Smith");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await screen.findByText("Customer page c1: Details updated");
        expect(goldApi.updateCustomerDetails).toHaveBeenCalledWith("c1", { lastName: "Smith" });
    });

    it("does not let a first name be blanked or a phone be too short", async () => {
        const user = userEvent.setup();
        asRole("manager");
        open();
        await screen.findByRole("heading", { name: "Edit details" });

        await user.clear(screen.getByLabelText("First name"));
        await user.clear(screen.getByLabelText("Phone"));
        await user.type(screen.getByLabelText("Phone"), "1234567");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(screen.getByText("Enter the first name.")).toBeInTheDocument();
        expect(screen.getByText("Phone number looks too short.")).toBeInTheDocument();
        expect(goldApi.updateCustomerDetails).not.toHaveBeenCalled();
    });

    it("shows the server's refusal", async () => {
        const user = userEvent.setup();
        asRole("manager");
        goldApi.updateCustomerDetails.mockRejectedValue(new GoldApiError({ status: 403, code: "forbidden" }));
        open();
        await screen.findByRole("heading", { name: "Edit details" });
        await user.type(screen.getByLabelText("Occupation (optional)"), "Jeweller");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("You do not have permission to do that.")).toBeInTheDocument();
    });
});
