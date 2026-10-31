import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import { wizardStorageKeys } from "../components/wizardStorage.js";
import { useAuth } from "../context/AuthContext.jsx";
import * as wizardApi from "../lib/wizardApi.js";

vi.mock("../context/AuthContext.jsx", () => ({
    AuthProvider: ({ children }) => children,
    useAuth: vi.fn(),
}));

// ITEM_AND_DELIVERY_CAPTURE_ENABLED is currently off pending an unrelated client-driven
// change that removes Recipient Delivery/Bullion Details entirely. This suite still
// exercises those steps, so it forces the flag on here without touching the real config.
vi.mock("../config/featureFlags.js", () => ({
    ITEM_AND_DELIVERY_CAPTURE_ENABLED: true,
}));

vi.mock("../lib/wizardApi.js", () => ({
    clearTransactionId: vi.fn(),
    completeTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    describeSaveError: vi.fn((err) => err?.message || "Failed to save. Please try again."),
    fetchPriorVerifications: vi.fn(),
    fetchVerificationForDocument: vi.fn(),
    findTransactionByRef: vi.fn(),
    getIdImageSignedUrls: vi.fn(),
    getTransactionId: vi.fn(),
    initTransaction: vi.fn(),
    loadBullionItems: vi.fn(),
    loadConductingPerson: vi.fn(),
    loadCustomers: vi.fn(),
    loadIdVerifications: vi.fn(),
    loadPreciousMetalItems: vi.fn(),
    loadRecipientDelivery: vi.fn(),
    loadTransaction: vi.fn(),
    migrateNewParties: vi.fn(),
    saveBullionItems: vi.fn(),
    saveConductingPerson: vi.fn(),
    saveConductorInfo: vi.fn(),
    saveCustomers: vi.fn(),
    saveIdVerifications: vi.fn(),
    savePreciousMetalItems: vi.fn(),
    saveRecipientDelivery: vi.fn(),
    saveTransaction: vi.fn(),
    searchCompanyCustomers: vi.fn(),
    searchIndividualCustomers: vi.fn(),
    uploadIdImage: vi.fn(),
}));

// A tiny in-memory stand-in for the DB, so mocked wizardApi calls behave consistently
// as the test clicks through the real page components in sequence.
function makeFakeDb() {
    return {
        transactionId: null,
        parties: [],
        conductingPerson: { hasConductingPerson: "no" },
        idVerifications: {},
        recipientDelivery: null,
        bullionItems: [],
    };
}

function wireWizardApiToFakeDb(db) {
    wizardApi.deleteTransaction.mockImplementation(async () => {
        db.transactionId = null;
        Object.values(wizardStorageKeys).forEach((k) => window.sessionStorage.removeItem(k));
    });
    wizardApi.findTransactionByRef.mockResolvedValue(null);
    wizardApi.getTransactionId.mockImplementation(() => db.transactionId);
    wizardApi.clearTransactionId.mockImplementation(() => {
        db.transactionId = null;
    });
    wizardApi.initTransaction.mockImplementation(async ({ parties }) => {
        db.transactionId = "tx-1";
        // Mirrors the real initTransaction, which internally calls migrateNewParties and so
        // flags parties migrated and persists them back to sessionStorage as a side effect.
        db.parties = parties.map((p, i) => ({ ...p, id: `db-party-${i}`, _migrated: true }));
        window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(db.parties));
        return db.transactionId;
    });
    wizardApi.saveTransaction.mockResolvedValue(undefined);
    wizardApi.migrateNewParties.mockImplementation(async (parties) => {
        const unmigrated = parties.filter((p) => !p._migrated);
        if (unmigrated.length === 0) return parties;
        // Mirrors the real insert semantics (adds rows, doesn't replace the table) — a party
        // missing _migrated gets appended as a brand new row even if one "like it" already exists.
        let nextIndex = db.parties.length;
        const inserted = [];
        const updated = parties.map((p) => {
            if (p._migrated) return p;
            const row = { ...p, id: `db-party-${nextIndex}`, _migrated: true };
            nextIndex += 1;
            inserted.push(row);
            return row;
        });
        db.parties = [...db.parties, ...inserted];
        return updated;
    });
    wizardApi.loadTransaction.mockImplementation(async () =>
        db.transactionId
            ? {
                  scenario: "sell",
                  serviceType: "bullion",
                  transactionRef: "INV-1",
                  cashAmount: "15000",
                  cashCurrency: "AUD",
              }
            : null
    );
    wizardApi.loadCustomers.mockImplementation(async () => db.parties);
    wizardApi.saveCustomers.mockImplementation(async (updated) => {
        updated.forEach((p) => {
            const idx = db.parties.findIndex((x) => x.id === p.id);
            if (idx > -1) db.parties[idx] = p;
        });
    });
    wizardApi.loadConductingPerson.mockImplementation(async () => db.conductingPerson);
    wizardApi.saveConductingPerson.mockImplementation(async (data) => {
        db.conductingPerson = data;
    });
    wizardApi.saveConductorInfo.mockResolvedValue(undefined);
    wizardApi.fetchPriorVerifications.mockResolvedValue([]);
    wizardApi.fetchVerificationForDocument.mockResolvedValue(null);
    wizardApi.getIdImageSignedUrls.mockResolvedValue({});
    wizardApi.loadIdVerifications.mockImplementation(async () => db.idVerifications);
    wizardApi.saveIdVerifications.mockImplementation(async (v) => {
        db.idVerifications = { ...db.idVerifications, ...v };
    });
    wizardApi.uploadIdImage.mockResolvedValue({ imageId: "img-1" });
    wizardApi.loadRecipientDelivery.mockImplementation(async () => db.recipientDelivery);
    wizardApi.saveRecipientDelivery.mockImplementation(async (data) => {
        db.recipientDelivery = data;
    });
    wizardApi.loadBullionItems.mockImplementation(async () => db.bullionItems);
    wizardApi.saveBullionItems.mockImplementation(async (items) => {
        db.bullionItems = items;
    });
    wizardApi.loadPreciousMetalItems.mockResolvedValue([]);
    wizardApi.savePreciousMetalItems.mockResolvedValue(undefined);
    wizardApi.completeTransaction.mockImplementation(async () => {
        Object.values(wizardStorageKeys).forEach((k) => window.sessionStorage.removeItem(k));
        return { ok: true, completedAt: "2026-07-04T00:00:00Z" };
    });
}

describe("wizard integration flow", () => {
    let db;

    beforeEach(() => {
        window.sessionStorage.clear();
        window.history.pushState({}, "", "/start");
        db = makeFakeDb();
        wireWizardApiToFakeDb(db);
        useAuth.mockReturnValue({
            session: { user: { id: "user-1" } },
            staffMember: { id: "staff-1", full_name: "Jane Staff", reporting_entity_id: "re-1", role: "staff" },
            reportingEntity: { legal_name: "Test Bullion", abn: "12345678901", austrac_account_number: "123456789" },
            aal: { currentLevel: "aal2", nextLevel: "aal2" },
            refreshAal: vi.fn(),
            canApproveReports: false,
            loading: false,
            signOut: vi.fn(),
        });

        const mockStream = { getTracks: () => [{ stop: vi.fn() }] };
        Object.defineProperty(navigator, "mediaDevices", {
            writable: true,
            configurable: true,
            value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
        });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() });
        vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
            `data:image/jpeg;base64,${btoa("mock-image-data")}`
        );
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it("full happy path: can navigate from /start through all steps to /review with valid data at each step", async () => {
        const user = userEvent.setup();
        render(<App />);

        // /start -> /customers
        expect(await screen.findByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-1");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        // /customers -> /customers/create -> back to /customers with the new party selected
        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /create new customer/i }));
        expect(await screen.findByRole("heading", { name: "Create New Customer / Party" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("First name"), "Jane");
        await user.type(screen.getByLabelText("Last name"), "Doe");
        await user.type(screen.getByLabelText("Date of birth"), "15/06/1985");
        await user.click(screen.getByRole("button", { name: "Save customer" }));

        // /customers -> /transaction-details
        // A single individual party makes this eligible for the self-conducted fast path —
        // select "No" to keep exercising today's full linear path.
        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: "No" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /transaction-details -> /party-details
        expect(await screen.findByRole("heading", { name: "Transaction & Cash Details" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Cash amount"), "15000");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /party-details -> /conducting-person
        // fullName and dateOfBirth are already pre-filled from the party created in the
        // previous step (loadPartyData falls back fullName to displayName) — no need to retype.
        expect(await screen.findByRole("heading", { name: "Party Details" })).toBeInTheDocument();
        expect(screen.getByLabelText("Full legal name")).toHaveValue("Jane Doe");
        await user.type(screen.getByLabelText("Street address"), "1 Main St");
        await user.type(screen.getByLabelText("Suburb"), "Coburg");
        await user.selectOptions(screen.getByLabelText("State"), "VIC");
        await user.type(screen.getByLabelText("Postcode"), "3058");
        await user.type(screen.getByLabelText("Phone number"), "0400000000");
        await user.type(screen.getByLabelText("Occupation or principal activity"), "Jeweller");
        await user.selectOptions(screen.getByLabelText("Gender"), "F");
        await user.selectOptions(screen.getByLabelText("Is this person a sole trader?"), "No");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /conducting-person -> /id-verification (skip: same as party)
        expect(
            await screen.findByText("Is a different person conducting the transaction on behalf of a party?")
        ).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: "No" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /id-verification -> /recipient-delivery
        expect(await screen.findByLabelText("Verification method")).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Verification method"), "Sighted original document");
        await user.selectOptions(screen.getByLabelText("Document or data-source type"), "Passport");
        await user.type(screen.getByLabelText("Document or reference number"), "P123456");
        await user.click(screen.getByRole("button", { name: /start camera for front/i }));
        await user.click(screen.getByRole("button", { name: "Capture front" }));
        await user.click(screen.getByRole("button", { name: "Accept front image" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /recipient-delivery -> /bullion-details
        await screen.findByRole("radio", { name: "Yes" });
        await user.click(screen.getByRole("radio", { name: "Yes" }));
        // The "Select recipient" section only appears once the Yes click's re-render lands —
        // wait for it rather than querying synchronously (see 95a24cf for the same class of
        // CI-only render-timing race in BullionDetailsPage's tests).
        await screen.findByRole("heading", { name: "Select recipient" });
        // "Recipient" also matches the section <h2> — filter to the FormField <label>.
        const recipientLabel = screen.getAllByText("Recipient").find((el) => el.tagName === "LABEL");
        await user.selectOptions(recipientLabel.nextElementSibling, "db-party-0");
        await user.selectOptions(screen.getByText("Purpose of the transfer").nextElementSibling, "Collecting bullion");
        await user.selectOptions(screen.getByText("Delivery method").nextElementSibling, "Collected");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // /bullion-details -> /review
        // BullionDetailsPage renders a default item synchronously, then replaces the whole
        // items array again once its load effect resolves — wait for that second render to
        // commit (transactionRef only appears post-load) before touching the form, otherwise
        // an interaction can land on the pre-load item right as it gets discarded.
        await screen.findByText("Metal type");
        await screen.findByText("INV-1");
        await user.selectOptions(screen.getByText("Metal type").nextElementSibling, "Gold");
        await user.selectOptions(screen.getByText("Product type").nextElementSibling, "Bar");
        await user.type(screen.getByText("Purity").nextElementSibling, "999.9");
        await user.type(screen.getByText("Quantity").nextElementSibling, "1");
        await user.type(screen.getByText("Weight").nextElementSibling.querySelector("input"), "10");
        await user.type(screen.getByText("Unit price (AUD per grams)").nextElementSibling, "100");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByRole("heading", { name: "Review / Validate / Submit" })).toBeInTheDocument();
    }, 30000);

    // Regression: resuming a draft used to write its already-persisted parties into sessionStorage
    // unflagged, so continuing through Transaction Details re-inserted every one of them as a
    // duplicate ttr.parties row — and the duplicate set doubled again each time the draft reopened.
    it("resuming a draft with an existing party does not duplicate it when continuing through Transaction Details", async () => {
        const user = userEvent.setup();
        db.parties = [
            { id: "party-1", type: "individual", displayName: "Jane Doe", firstName: "Jane", lastName: "Doe" },
        ];
        wizardApi.findTransactionByRef.mockImplementation(async () => {
            db.transactionId = "tx-1";
            return {
                scenario: "sell",
                serviceType: "bullion",
                transactionRef: "INV-1",
                dateTime: "2026-07-04T10:00",
                status: "draft",
            };
        });

        render(<App />);

        expect(await screen.findByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-1");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        // The single existing individual party makes this fast-path eligible — select "No" to
        // keep exercising the full linear path this test is actually about.
        await user.click(screen.getByRole("radio", { name: "No" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByRole("heading", { name: "Transaction & Cash Details" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Cash amount"), "15000");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        await screen.findByRole("heading", { name: "Party Details" });
        expect(db.parties).toHaveLength(1);
    });

    it("the self-conducted fast-path question only appears for exactly one individual party", async () => {
        const user = userEvent.setup();
        render(<App />);

        expect(await screen.findByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-1");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        // One individual party -> question appears.
        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /create new customer/i }));
        await user.type(screen.getByLabelText("First name"), "Jane");
        await user.type(screen.getByLabelText("Last name"), "Doe");
        await user.type(screen.getByLabelText("Date of birth"), "15/06/1985");
        await user.click(screen.getByRole("button", { name: "Save customer" }));
        expect(await screen.findByTestId("selfConducted-group")).toBeInTheDocument();

        // Adding a second individual party -> question disappears.
        await user.click(screen.getByRole("button", { name: /create new customer/i }));
        await user.type(screen.getByLabelText("First name"), "John");
        await user.type(screen.getByLabelText("Last name"), "Smith");
        await user.type(screen.getByLabelText("Date of birth"), "01/01/1980");
        await user.click(screen.getByRole("button", { name: "Save customer" }));
        await screen.findByRole("heading", { name: "Add Customers / Parties" });
        expect(screen.queryByTestId("selfConducted-group")).not.toBeInTheDocument();

        // Remove one party back down to a single individual, then switch it to a company ->
        // question stays absent.
        await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
        await screen.findByTestId("selfConducted-group");
        await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
        await screen.findByRole("button", { name: /create new customer/i });
        expect(screen.queryByTestId("selfConducted-group")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /create new customer/i }));
        await user.click(screen.getByRole("button", { name: "Company / Business" }));
        await user.type(screen.getByLabelText("Registered entity name"), "Acme Pty Ltd");
        await user.type(screen.getByLabelText("ABN / ACN"), "12345678901");
        await user.click(screen.getByRole("button", { name: "Save customer" }));
        await screen.findByRole("heading", { name: "Add Customers / Parties" });
        expect(screen.queryByTestId("selfConducted-group")).not.toBeInTheDocument();
    });

    it("fast path: answering Yes skips Party Details/Conducting Person until after ID Verification", async () => {
        const user = userEvent.setup();
        render(<App />);

        expect(await screen.findByRole("heading", { name: "Start TTR Transaction" })).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-1");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /create new customer/i }));
        await user.type(screen.getByLabelText("First name"), "Jane");
        await user.type(screen.getByLabelText("Last name"), "Doe");
        await user.type(screen.getByLabelText("Date of birth"), "15/06/1985");
        await user.click(screen.getByRole("button", { name: "Save customer" }));

        await screen.findByTestId("selfConducted-group");
        await user.click(screen.getByRole("radio", { name: "Yes" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // Straight to ID Verification — Transaction Details, Party Details and Conducting
        // Person are all skipped for now.
        expect(await screen.findByRole("heading", { name: "ID Verification Details & Capture" })).toBeInTheDocument();
        expect(wizardApi.initTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
                financialData: expect.objectContaining({ cashCurrency: "AUD", cashAmount: "1" }),
            })
        );

        await user.selectOptions(screen.getByLabelText("Verification method"), "Sighted original document");
        await user.selectOptions(screen.getByLabelText("Document or data-source type"), "Passport");
        await user.type(screen.getByLabelText("Document or reference number"), "P123456");
        await user.click(screen.getByRole("button", { name: /start camera for front/i }));
        await user.click(screen.getByRole("button", { name: "Capture front" }));
        await user.click(screen.getByRole("button", { name: "Accept front image" }));
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // ID Verification -> Transaction Details, with a blank (not placeholder) cash amount.
        expect(await screen.findByRole("heading", { name: "Transaction & Cash Details" })).toBeInTheDocument();
        expect(screen.getByLabelText("Cash amount")).toHaveValue(null);
        await user.type(screen.getByLabelText("Cash amount"), "15000");
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(wizardApi.saveTransaction).toHaveBeenCalled();
        expect(wizardApi.initTransaction).toHaveBeenCalledTimes(1);

        // Transaction Details -> Party Details (remaining fields only).
        expect(await screen.findByRole("heading", { name: "Party Details" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Street address"), "1 Main St");
        await user.type(screen.getByLabelText("Suburb"), "Coburg");
        await user.selectOptions(screen.getByLabelText("State"), "VIC");
        await user.type(screen.getByLabelText("Postcode"), "3058");
        await user.type(screen.getByLabelText("Phone number"), "0400000000");
        await user.type(screen.getByLabelText("Occupation or principal activity"), "Jeweller");
        await user.selectOptions(screen.getByLabelText("Gender"), "F");
        await user.selectOptions(screen.getByLabelText("Is this person a sole trader?"), "No");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        // Party Details -> Recipient Delivery directly — Conducting Person is never shown.
        await screen.findByRole("radio", { name: "Yes" });
        expect(
            screen.queryByText("Is a different person conducting the transaction on behalf of a party?")
        ).not.toBeInTheDocument();
    }, 30000);

    it("fast path back-navigation lands on the correct previous page at each new transition", async () => {
        const user = userEvent.setup();

        // ID Verification -> back -> Customer Search
        db.transactionId = "tx-1";
        db.parties = [
            {
                id: "db-party-0",
                type: "individual",
                displayName: "Jane Doe",
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: "1985-06-15",
                _migrated: true,
            },
        ];
        window.sessionStorage.setItem(wizardStorageKeys.selfConductedFastPath, JSON.stringify(true));
        window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(db.parties));
        window.history.pushState({}, "", "/id-verification");
        const { unmount: unmount1 } = render(<App />);
        await screen.findByRole("heading", { name: "ID Verification Details & Capture" });
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        unmount1();

        // Transaction Details -> back -> ID Verification
        window.sessionStorage.setItem(wizardStorageKeys.selfConductedFastPath, JSON.stringify(true));
        window.history.pushState({}, "", "/transaction-details");
        const { unmount: unmount2 } = render(<App />);
        await screen.findByRole("heading", { name: "Transaction & Cash Details" });
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "ID Verification Details & Capture" })).toBeInTheDocument();
        unmount2();

        // Recipient Delivery -> back -> Party Details
        window.sessionStorage.setItem(wizardStorageKeys.selfConductedFastPath, JSON.stringify(true));
        window.history.pushState({}, "", "/recipient-delivery");
        render(<App />);
        await screen.findByRole("radio", { name: "Yes" });
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "Party Details" })).toBeInTheDocument();
    });

    it("cancelling from any page mid-wizard clears all sessionStorage wizard keys", async () => {
        const user = userEvent.setup();
        window.sessionStorage.setItem(wizardStorageKeys.transaction, JSON.stringify({ transactionRef: "INV-1" }));
        render(<App />);

        await user.click(await screen.findByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-1");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        await screen.findByRole("heading", { name: "Add Customers / Parties" });
        await user.click(screen.getByRole("button", { name: "Exit" }));
        await user.click(screen.getByRole("dialog").querySelector("button:last-child"));

        await waitFor(() => {
            Object.values(wizardStorageKeys).forEach((key) => {
                expect(window.sessionStorage.getItem(key)).toBeNull();
            });
        });
    });

    it("completing a transaction via /review clears all sessionStorage wizard keys", async () => {
        const user = userEvent.setup();
        db.transactionId = "tx-1";
        db.parties = [{ id: "db-party-0", type: "individual", displayName: "Jane Doe" }];
        db.recipientDelivery = {
            recipientIsParty: "yes",
            selectedPartyId: "db-party-0",
            purposeOfTransfer: "Collecting bullion",
            deliveryMethod: "Collected",
            deliveryAddressDifferent: "no",
        };
        db.bullionItems = [
            {
                metalType: "Gold",
                productType: "Bar",
                purity: "999.9",
                quantity: "1",
                weight: "10",
                weightUnit: "grams",
                unitPrice: "100",
                lineTotal: 1000,
            },
        ];
        window.sessionStorage.setItem(wizardStorageKeys.transaction, JSON.stringify({ transactionRef: "INV-1" }));
        window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(db.parties));
        window.history.pushState({}, "", "/review");

        render(<App />);

        await screen.findByText("This transaction is ready to be completed.");
        await user.click(screen.getByRole("button", { name: /complete \/ reportable/i }));

        await waitFor(() => {
            Object.values(wizardStorageKeys).forEach((key) => {
                expect(window.sessionStorage.getItem(key)).toBeNull();
            });
        });
    });

    it("back navigation from /transaction-details preserves previously entered form values", async () => {
        const user = userEvent.setup();
        window.sessionStorage.setItem(
            wizardStorageKeys.customers,
            JSON.stringify([{ id: "party-1", type: "individual", displayName: "Jane Doe", detail: "" }])
        );
        window.history.pushState({}, "", "/transaction-details");
        render(<App />);

        await screen.findByRole("heading", { name: "Transaction & Cash Details" });
        await user.click(screen.getByRole("button", { name: "Back" }));

        expect(await screen.findByRole("heading", { name: "Add Customers / Parties" })).toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("back navigation from /party-details preserves party form data", async () => {
        const user = userEvent.setup();
        db.transactionId = "tx-1";
        db.parties = [
            {
                id: "party-1",
                type: "individual",
                displayName: "Jane Doe",
                fullName: "Jane Doe",
                isComplete: true,
                dateOfBirth: "1985-06-15",
                residentialAddress: {
                    street: "1 Main St",
                    suburb: "Coburg",
                    state: "VIC",
                    postcode: "3058",
                    country: "Australia",
                },
            },
        ];
        window.sessionStorage.setItem(
            wizardStorageKeys.transaction,
            JSON.stringify({
                scenario: "sell",
                serviceType: "bullion",
                transactionRef: "INV-1",
                dateTime: "2026-07-04T10:00",
            })
        );
        window.history.pushState({}, "", "/party-details");
        render(<App />);

        expect(await screen.findByLabelText("Full legal name")).toHaveValue("Jane Doe");
        await user.click(screen.getByRole("button", { name: "Back" }));

        await screen.findByRole("heading", { name: "Transaction & Cash Details" });
        await user.type(screen.getByLabelText("Cash amount"), "15000");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByLabelText("Full legal name")).toHaveValue("Jane Doe");
    });

    it("editing a value on a previous page and continuing forward updates sessionStorage correctly", async () => {
        const user = userEvent.setup();
        render(<App />);

        await user.click(await screen.findByRole("radio", { name: /sell bullion to customer/i }));
        await user.type(screen.getByLabelText(/transaction reference/i), "INV-OLD");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        await screen.findByRole("heading", { name: "Add Customers / Parties" });
        await user.click(screen.getByRole("button", { name: "Back" }));

        await screen.findByRole("heading", { name: "Start TTR Transaction" });
        await user.click(screen.getByRole("radio", { name: /sell bullion to customer/i }));
        const refInput = screen.getByLabelText(/transaction reference/i);
        await user.clear(refInput);
        await user.type(refInput, "INV-NEW");
        await user.click(screen.getByRole("button", { name: /start transaction/i }));

        await screen.findByRole("heading", { name: "Add Customers / Parties" });
        const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction));
        expect(stored.transactionRef).toBe("INV-NEW");
    });

    it("clicking an Edit link on the review page navigates to the correct page and back brings the user to /review", async () => {
        const user = userEvent.setup();
        db.transactionId = "tx-1";
        db.parties = [{ id: "party-1", type: "individual", displayName: "Jane Doe" }];
        db.recipientDelivery = {
            recipientIsParty: "yes",
            selectedPartyId: "party-1",
            purposeOfTransfer: "Collecting bullion",
            deliveryMethod: "Collected",
            deliveryAddressDifferent: "no",
        };
        db.bullionItems = [
            {
                metalType: "Gold",
                productType: "Bar",
                purity: "999.9",
                quantity: "1",
                weight: "10",
                weightUnit: "grams",
                unitPrice: "100",
                lineTotal: 1000,
            },
        ];
        window.sessionStorage.setItem(wizardStorageKeys.transaction, JSON.stringify({ transactionRef: "INV-1" }));
        window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(db.parties));
        window.history.pushState({}, "", "/review");

        render(<App />);

        await screen.findByText("This transaction is ready to be completed.");
        await user.click(screen.getAllByRole("button", { name: /edit/i })[0]);

        expect(await screen.findByRole("heading", { name: "Transaction & Cash Details" })).toBeInTheDocument();

        window.history.back();

        expect(await screen.findByRole("heading", { name: "Review / Validate / Submit" })).toBeInTheDocument();
    });

    it("reloading mid-wizard rehydrates all form fields from sessionStorage without data loss", async () => {
        window.sessionStorage.setItem(
            wizardStorageKeys.transaction,
            JSON.stringify({
                scenario: "buy",
                serviceType: "bullion",
                transactionRef: "INV-777",
                dateTime: "2026-07-04T10:00",
            })
        );
        window.sessionStorage.setItem(
            wizardStorageKeys.customers,
            JSON.stringify([{ id: "party-1", type: "individual", displayName: "Jane Doe", detail: "" }])
        );
        window.history.pushState({}, "", "/transaction-details");

        const { unmount } = render(<App />);
        expect(await screen.findByText("INV-777")).toBeInTheDocument();
        unmount();

        // Simulate a page reload: a fresh mount at the same route with sessionStorage intact.
        render(<App />);
        expect(await screen.findByText("INV-777")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Buy bullion from customer" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
    });
});
