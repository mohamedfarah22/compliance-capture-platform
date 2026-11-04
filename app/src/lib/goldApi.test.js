import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    select: vi.fn(),
    getSession: vi.fn(),
    getIdImageSignedUrls: vi.fn(),
}));

vi.mock("./supabase.js", () => ({
    supabase: {
        rpc: mocks.rpc,
        from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.select }) }) }) }),
        auth: { getSession: mocks.getSession },
    },
}));
vi.mock("./wizardApi.js", () => ({ getIdImageSignedUrls: mocks.getIdImageSignedUrls }));

const {
    GoldApiError,
    createCustomer,
    findIdOwner,
    findPossibleDuplicates,
    getCustomer,
    getCustomerIdImages,
    goToAustracForm,
    searchCustomers,
    updateCustomerDetails,
    updateCustomerId,
    updateCustomerPhone,
} = await import("./goldApi.js");

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const front = new Blob(["front"], { type: "image/jpeg" });
const back = new Blob(["back"], { type: "image/jpeg" });

beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "jwt-1" } } });
    globalThis.fetch = vi.fn();
});

describe("searchCustomers", () => {
    it("maps rows to customers with their current ID, and null when none is on file", async () => {
        mocks.rpc.mockResolvedValue({
            error: null,
            data: [
                {
                    customer_id: "c1",
                    first_name: "Jane",
                    middle_name: "Q",
                    last_name: "Citizen",
                    date_of_birth: "1985-06-15",
                    phone: "0412 345 678",
                    current_id_verification_id: "v1",
                    current_id_document_type: "Driver licence",
                    current_id_document_number: "012345678",
                    current_id_expiry_date: "2029-04-30",
                    current_id_has_expiry: true,
                    current_id_captured_at: "2026-01-01T00:00:00Z",
                },
                {
                    customer_id: "c2",
                    first_name: "Mark",
                    middle_name: null,
                    last_name: "Nguyen",
                    current_id_verification_id: null,
                },
            ],
        });

        const found = await searchCustomers("jane");

        expect(mocks.rpc).toHaveBeenCalledWith("search_customers", { p_q: "jane" });
        expect(found[0]).toMatchObject({ id: "c1", full_name: "Jane Q Citizen", phone: "0412 345 678" });
        expect(found[0].current_id).toEqual({
            verification_id: "v1",
            document_type: "Driver licence",
            document_number: "012345678",
            has_expiry: true,
            expiry_date: "2029-04-30",
            captured_at: "2026-01-01T00:00:00Z",
        });
        expect(found[1]).toMatchObject({ id: "c2", full_name: "Mark Nguyen", current_id: null });
    });

    it("throws a message safe to show when the search fails", async () => {
        mocks.rpc.mockResolvedValue({ error: { message: "boom" }, data: null });

        await expect(searchCustomers("jane")).rejects.toThrow("Search failed. Try again.");
    });
});

describe("getCustomer", () => {
    it("returns the customer with sorted aliases and the current ID", async () => {
        mocks.select.mockResolvedValue({
            error: null,
            data: {
                id: "c1",
                first_name: "Jane",
                middle_name: null,
                last_name: "Citizen",
                customer_aliases: [
                    { alias: "Second", sort_order: 2 },
                    { alias: "First", sort_order: 1 },
                ],
            },
        });
        mocks.rpc.mockResolvedValue({ error: null, data: [{ verification_id: "v1", document_type: "Passport" }] });

        const customer = await getCustomer("c1");

        expect(mocks.rpc).toHaveBeenCalledWith("customer_current_id", { p_customer_id: "c1" });
        expect(customer).toMatchObject({ id: "c1", full_name: "Jane Citizen", aliases: ["First", "Second"] });
        expect(customer.current_id).toEqual({ verification_id: "v1", document_type: "Passport" });
    });

    it("has a null current ID when none is on file", async () => {
        mocks.select.mockResolvedValue({
            error: null,
            data: { id: "c1", first_name: "J", last_name: "C", customer_aliases: [] },
        });
        mocks.rpc.mockResolvedValue({ error: null, data: [] });

        expect((await getCustomer("c1")).current_id).toBeNull();
    });

    it.each([
        ["another business's or unknown id", { error: null, data: null }],
        ["a malformed id", { error: { code: "22P02" }, data: null }],
    ])("throws a 404 for %s", async (_name, result) => {
        mocks.select.mockResolvedValue(result);
        mocks.rpc.mockResolvedValue({ error: null, data: [] });

        await expect(getCustomer("nope")).rejects.toMatchObject({ status: 404, message: "Customer not found." });
    });
});

describe("getCustomerIdImages", () => {
    it("returns a URL per side, null where there is none", async () => {
        mocks.getIdImageSignedUrls.mockResolvedValue({ f1: "https://signed/f1" });

        const images = await getCustomerIdImages({ front_image_id: "f1", back_image_id: "b1" });

        expect(mocks.getIdImageSignedUrls).toHaveBeenCalledWith(["f1", "b1"]);
        expect(images).toEqual({ front: "https://signed/f1", back: null });
    });
});

describe("duplicate and collision lookups", () => {
    it("maps possible duplicates, and treats a failed lookup as none", async () => {
        mocks.rpc.mockResolvedValueOnce({
            error: null,
            data: [
                {
                    customer_id: "c9",
                    first_name: "Jane",
                    last_name: "Citizen",
                    date_of_birth: "1985-06-15",
                    phone: "0412",
                    match_reason: "phone",
                },
            ],
        });

        const found = await findPossibleDuplicates({
            firstName: "Jane",
            lastName: "Citizen",
            dateOfBirth: "1985-06-15",
            phone: "0412 345 678",
        });

        expect(mocks.rpc).toHaveBeenCalledWith("find_possible_duplicate_customers", {
            p_first_name: "Jane",
            p_last_name: "Citizen",
            p_dob: "1985-06-15",
            p_phone: "0412 345 678",
        });
        expect(found).toEqual([
            {
                customerId: "c9",
                firstName: "Jane",
                lastName: "Citizen",
                dateOfBirth: "1985-06-15",
                phone: "0412",
                matchReason: "phone",
            },
        ]);

        mocks.rpc.mockResolvedValueOnce({ error: { message: "x" }, data: null });
        expect(await findPossibleDuplicates({ firstName: "J", lastName: "C", dateOfBirth: "", phone: "" })).toEqual([]);
    });

    it("finds who owns a document number, or null", async () => {
        mocks.rpc.mockResolvedValueOnce({
            error: null,
            data: [
                {
                    customer_id: "c9",
                    owner_kind: "customer",
                    owner_name: "Jane Citizen",
                    owner_dob: "1985-06-15",
                    document_type: "Passport",
                },
            ],
        });
        expect(await findIdOwner({ documentType: "Passport", documentNumber: "PA1" })).toEqual({
            customerId: "c9",
            kind: "customer",
            name: "Jane Citizen",
            dateOfBirth: "1985-06-15",
            documentType: "Passport",
        });
        expect(mocks.rpc).toHaveBeenCalledWith("get_verification_for_document", {
            p_document_type: "Passport",
            p_document_number: "PA1",
        });

        mocks.rpc.mockResolvedValueOnce({ error: null, data: [] });
        expect(await findIdOwner({ documentType: "Passport", documentNumber: "PA2" })).toBeNull();
    });
});

describe("edge function calls", () => {
    it("createCustomer sends multipart: the JSON payload without photos, then front and back as JPEG files", async () => {
        fetch.mockResolvedValue(reply(201, { customerId: "c1" }));

        const result = await createCustomer({ firstName: "Jane", id: { documentType: "Driver licence" }, front, back });

        const [url, init] = fetch.mock.calls[0];
        expect(url).toMatch(/\/functions\/v1\/gold-create-customer$/);
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("Bearer jwt-1");
        expect(init.headers["Content-Type"]).toBeUndefined(); // the browser sets the multipart boundary
        expect(JSON.parse(init.body.get("payload"))).toEqual({
            firstName: "Jane",
            id: { documentType: "Driver licence" },
        });
        expect(init.body.get("front").name).toBe("front.jpg");
        expect(init.body.get("back").name).toBe("back.jpg");
        expect(result).toEqual({ customerId: "c1" });
    });

    it("createCustomer leaves out a back photo that was not taken", async () => {
        fetch.mockResolvedValue(reply(201, {}));

        await createCustomer({ firstName: "Jane", front });

        expect(fetch.mock.calls[0][1].body.has("back")).toBe(false);
    });

    it("updateCustomerId sends the customer, reason and document in the payload", async () => {
        fetch.mockResolvedValue(reply(201, { superseded: 2 }));

        await updateCustomerId("c1", { reason: "renewed", documentNumber: "123", front, back });

        const [url, init] = fetch.mock.calls[0];
        expect(url).toMatch(/\/functions\/v1\/gold-update-customer-id$/);
        expect(JSON.parse(init.body.get("payload"))).toEqual({
            customerId: "c1",
            reason: "renewed",
            documentNumber: "123",
        });
    });

    it("updateCustomerDetails sends JSON", async () => {
        fetch.mockResolvedValue(reply(200, { changed: ["last_name"] }));

        await updateCustomerDetails("c1", { lastName: "Smith" });

        const [url, init] = fetch.mock.calls[0];
        expect(url).toMatch(/\/functions\/v1\/gold-update-customer$/);
        expect(init.headers["Content-Type"]).toBe("application/json");
        expect(JSON.parse(init.body)).toEqual({ customerId: "c1", changes: { lastName: "Smith" } });
    });

    it("goToAustracForm calls gold-start-ttr with the purchase id and returns the route that opens the first report", async () => {
        const ttrs = [
            { id: "t-1", type: "scrap", scenario: "precious_metal_buy", status: "draft", created: true, case: "A" },
            { id: "t-2", type: "bullion", scenario: "bullion_buy", status: "draft", created: true, case: "A" },
        ];
        fetch.mockResolvedValue(reply(200, { ttrs }));

        const result = await goToAustracForm("p-1");

        const [url, init] = fetch.mock.calls[0];
        expect(url).toMatch(/\/functions\/v1\/gold-start-ttr$/);
        expect(JSON.parse(init.body)).toEqual({ purchaseId: "p-1" });
        expect(result).toEqual({ ttrs, path: "/open-ttr/t-1" });
    });

    it.each([
        ["invoice_required", 422, /Enter the ERP invoice number/],
        ["not_reportable", 422, /under \$10,000/],
        ["no_cash", 422, /paid in cash/],
        ["ttr_reference_in_use", 409, /already uses this invoice number/],
    ])("goToAustracForm explains %s", async (code, status, words) => {
        fetch.mockResolvedValue(reply(status, { error: code }));
        await expect(goToAustracForm("p-1")).rejects.toThrow(words);
    });

    it("turns a refusal into a GoldApiError carrying the status, code and body", async () => {
        const body = { error: "possible_duplicates", duplicates: [{ customerId: "c9" }] };
        fetch.mockResolvedValue(reply(409, body));

        const error = await createCustomer({ front }).catch((e) => e);

        expect(error).toBeInstanceOf(GoldApiError);
        expect(error).toMatchObject({ status: 409, code: "possible_duplicates", body });
    });

    it.each([
        ["gold_disabled", 403, "not switched on"],
        ["mfa_required", 403, "authenticator"],
        ["forbidden", 403, "permission"],
        ["document_not_on_file", 409, "Different document"],
        ["create_failed", 500, "Could not save"],
    ])("explains %s in words staff can act on", async (code, status, words) => {
        fetch.mockResolvedValue(reply(status, { error: code }));

        await expect(updateCustomerDetails("c1", { lastName: "x" })).rejects.toThrow(words);
    });

    it("explains a network failure", async () => {
        fetch.mockRejectedValue(new TypeError("Failed to fetch"));

        await expect(updateCustomerDetails("c1", { lastName: "x" })).rejects.toThrow("Could not reach the server");
    });
});

describe("updateCustomerPhone", () => {
    it("calls the RPC and resolves whether the number changed", async () => {
        mocks.rpc.mockResolvedValue({ error: null, data: true });

        expect(await updateCustomerPhone("c1", "0412 345 678")).toBe(true);
        expect(mocks.rpc).toHaveBeenCalledWith("update_customer_phone", {
            p_customer_id: "c1",
            p_phone: "0412 345 678",
        });
    });

    it.each([
        ["invalid_phone", "Phone number looks too short."],
        ["forbidden", "permission"],
        ["customer_not_found", "Customer not found."],
    ])("maps the RPC error %s to a message", async (code, words) => {
        mocks.rpc.mockResolvedValue({ error: { message: code }, data: null });

        await expect(updateCustomerPhone("c1", "1234")).rejects.toThrow(words);
    });
});
