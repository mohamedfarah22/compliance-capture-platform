import { beforeEach, describe, expect, it, vi } from "vitest";

// A query builder that records each call and resolves with the result set for it. Any method returns the builder,
// so .select().eq().order() works whatever the order.
const mocks = vi.hoisted(() => ({
    calls: [],
    results: {},
    getSession: vi.fn(),
}));

const builder = (result) => {
    const proxy = new Proxy(
        {},
        {
            get: (_target, prop) =>
                prop === "then"
                    ? (resolve) => resolve(result)
                    : (...args) => {
                          mocks.calls.push([prop, args]);
                          return proxy;
                      },
        }
    );
    return proxy;
};

vi.mock("./supabase.js", () => ({
    supabase: {
        rpc: (name, args) => {
            mocks.calls.push(["public.rpc", [name, args]]);
            return builder(mocks.results[`public.rpc.${name}`]);
        },
        from: (table) => builder(mocks.results[`public.${table}`]),
        schema: (schema) => ({
            from: (table) => builder(mocks.results[`${schema}.${table}`]),
            rpc: (name, args) => {
                mocks.calls.push([`${schema}.rpc`, [name, args]]);
                return builder(mocks.results[`${schema}.rpc.${name}`]);
            },
        }),
        auth: { getSession: mocks.getSession },
    },
}));
vi.mock("./wizardApi.js", () => ({ getIdImageSignedUrls: vi.fn() }));

const {
    createTransaction,
    findInvoicePurchases,
    findSameDayInvoicePurchases,
    getGoldPhotoUrls,
    getTransaction,
    getTtrReadiness,
    invoiceExists,
    listIncompleteTransactions,
    listTransactions,
    searchTransactions,
    updateTransaction,
} = await import("./goldApi.js");

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const ok = (data) => ({ data, error: null });
const callsTo = (name) => mocks.calls.filter(([method]) => method === name).map(([, args]) => args);

beforeEach(() => {
    mocks.calls = [];
    mocks.results = {};
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "jwt-1" } } });
    globalThis.fetch = vi.fn();
});

describe("searchTransactions", () => {
    it("sends the filters as the RPC names them, with the page, and returns the rows and total", async () => {
        mocks.results["gold.rpc.search_gold_purchases"] = ok([
            { id: "p1", total_count: 26 },
            { id: "p2", total_count: 26 },
        ]);
        mocks.results["gold.goods_photos"] = ok([{ purchase_id: "p1" }, { purchase_id: "p1" }]);

        const found = await searchTransactions(
            {
                q: "jane",
                type: "bullion",
                status: "austrac_pending",
                cash: "yes",
                from: "2026-11-01",
                to: "",
                recordedBy: "s1",
            },
            { page: 2, pageSize: 25 }
        );

        expect(callsTo("gold.rpc")[0]).toEqual([
            "search_gold_purchases",
            {
                p_filters: {
                    q: "jane",
                    type: "bullion",
                    status: "austrac_pending",
                    cash: "yes",
                    date_from: "2026-11-01",
                    date_to: "",
                    recorded_by: "s1",
                },
                p_page: 2,
                p_page_size: 25,
            },
        ]);
        expect(found.total).toBe(26);
        expect(found.rows.map((row) => [row.id, row.photo_count])).toEqual([
            ["p1", 2],
            ["p2", 0],
        ]);
    });

    it("has no rows and a total of 0 when nothing matches", async () => {
        mocks.results["gold.rpc.search_gold_purchases"] = ok([]);

        expect(await searchTransactions({})).toEqual({ rows: [], total: 0 });
    });

    it("throws a message safe to show when the search fails", async () => {
        mocks.results["gold.rpc.search_gold_purchases"] = { data: null, error: { code: "XX000" } };

        await expect(searchTransactions({})).rejects.toThrow("Could not load purchases. Try again.");
    });
});

describe("listTransactions", () => {
    it("adds the photo count and the TTR status to each purchase, newest first", async () => {
        mocks.results["gold.purchases"] = ok([
            { id: "p1", ttr_transaction_id: "t1", goods_photos: [{ count: 3 }] },
            { id: "p2", ttr_transaction_id: null, goods_photos: [{ count: 1 }] },
        ]);
        mocks.results["ttr.transactions"] = ok([{ id: "t1", status: "complete", transaction_ref: "INV-1" }]);

        const rows = await listTransactions("c1");

        expect(callsTo("or")[0]).toEqual(["customer_id.eq.c1,joint_customer_id.eq.c1"]);
        expect(callsTo("order")[0]).toEqual(["created_at", { ascending: false }]);
        expect(rows.map((row) => [row.id, row.photo_count, row.ttr_status])).toEqual([
            ["p1", 3, "complete"],
            ["p2", 1, null],
        ]);
    });
});

describe("getTransaction", () => {
    it("returns the purchase with its photos in order and its TTR", async () => {
        mocks.results["gold.purchases"] = ok({
            id: "p1",
            ttr_transaction_id: "t1",
            goods_photos: [
                { id: "b", sort_order: 1 },
                { id: "a", sort_order: 0 },
            ],
        });
        mocks.results["ttr.transactions"] = ok([{ id: "t1", status: "draft", transaction_ref: "INV-1" }]);

        const purchase = await getTransaction("p1");

        expect(purchase.goods_photos.map((photo) => photo.id)).toEqual(["a", "b"]);
        expect(purchase.ttr).toMatchObject({ id: "t1", status: "draft" });
    });

    it("is a 404 when there is no such purchase, or the id is malformed", async () => {
        mocks.results["gold.purchases"] = ok(null);
        await expect(getTransaction("nope")).rejects.toMatchObject({ status: 404, code: "purchase_not_found" });

        mocks.results["gold.purchases"] = { data: null, error: { code: "22P02" } };
        await expect(getTransaction("not-a-uuid")).rejects.toMatchObject({ status: 404, code: "purchase_not_found" });
    });
});

describe("invoice lookups", () => {
    it("finds the earlier parts for a customer on a day, leaving out the purchase being completed", async () => {
        mocks.results["gold.rpc.linked_parts"] = ok([{ id: "p1" }, { id: "p2" }]);

        const found = await findSameDayInvoicePurchases({
            customerId: "c1",
            invoice: "INV-1",
            date: "2026-11-05",
            excludeId: "p2",
        });

        expect(found).toEqual([{ id: "p1" }]);
        expect(callsTo("gold.rpc")[0]).toEqual([
            "linked_parts",
            { p_customer_id: "c1", p_invoice_norm: "INV-1", p_sale_date: "2026-11-05" },
        ]);
    });

    it("says whether another purchase already uses an invoice number", async () => {
        mocks.results["gold.rpc.invoice_purchases"] = ok([{ id: "p1" }]);

        expect(await invoiceExists("INV-1")).toBe(true);
        expect(await invoiceExists("INV-1", "p1")).toBe(false);
        expect(await findInvoicePurchases("INV-1")).toEqual([{ id: "p1" }]);
    });
});

describe("getTtrReadiness", () => {
    it("returns the missing fields, and null when it could not be worked out", async () => {
        mocks.results["public.rpc.customer_ttr_ready"] = ok(["occupation"]);
        expect(await getTtrReadiness("c1")).toEqual(["occupation"]);

        mocks.results["public.rpc.customer_ttr_ready"] = { data: null, error: { code: "42501" } };
        expect(await getTtrReadiness("c1")).toBeNull();
    });
});

describe("listIncompleteTransactions", () => {
    it("adds the photo count to each row", async () => {
        mocks.results["gold.rpc.list_incomplete_purchases"] = ok([{ id: "p1" }]);
        mocks.results["gold.goods_photos"] = ok([{ purchase_id: "p1" }]);

        expect(await listIncompleteTransactions()).toEqual([{ id: "p1", photo_count: 1 }]);
    });
});

describe("edge function calls", () => {
    it("createTransaction sends multipart: the fields as text and each photo as a JPEG file", async () => {
        globalThis.fetch.mockResolvedValue(reply(201, { purchaseId: "p1", ttr: "B", warnings: {} }));
        const photo = new Blob(["jpeg"], { type: "image/jpeg" });

        const saved = await createTransaction({
            customerId: "c1",
            jointCustomerId: "c2",
            purchaseType: "scrap",
            cash10k: true,
            bullionBand: "under_5k",
            cashAmount: "12,500",
            partAmount: "",
            linkedAmounts: {},
            phone: "0412 345 678",
            idSighted: true,
            erpInvoiceNo: "INV-1",
            ttrSelfConducted: null,
            ttrDetailsConfirmed: null,
            photos: [photo, photo],
        });

        expect(saved).toEqual({ purchaseId: "p1", ttr: "B", warnings: {} });
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toMatch(/\/gold-save-purchase$/);
        expect(init.headers.Authorization).toBe("Bearer jwt-1");
        const form = init.body;
        expect(Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
            customerId: "c1",
            jointCustomerId: "c2",
            purchaseType: "scrap",
            phone: "0412 345 678",
            idSighted: "true",
            erpInvoiceNo: "INV-1",
            cashAmount: "12,500",
            cash10k: "true",
        });
        const files = form.getAll("photos");
        expect(files).toHaveLength(2);
        expect(files[0].type).toBe("image/jpeg");
    });

    it("createTransaction sends the bullion band instead of the scrap answer, and the counter answers when asked", async () => {
        globalThis.fetch.mockResolvedValue(reply(201, { purchaseId: "p1", ttr: "A", warnings: {} }));

        await createTransaction({
            customerId: "c1",
            purchaseType: "bullion",
            cash10k: false,
            bullionBand: "10k_plus",
            linkedAmounts: { p0: "6,000" },
            partAmount: "6000",
            phone: "0412 345 678",
            idSighted: true,
            ttrSelfConducted: true,
            ttrDetailsConfirmed: false,
            photos: [new Blob(["jpeg"], { type: "image/jpeg" })],
        });

        const form = globalThis.fetch.mock.calls[0][1].body;
        expect(form.get("bullionBand")).toBe("10k_plus");
        expect(form.has("cash10k")).toBe(false);
        expect(form.get("ttrSelfConducted")).toBe("true");
        expect(form.get("ttrDetailsConfirmed")).toBe("false");
        expect(form.get("linkedAmounts")).toBe('{"p0":"6,000"}');
        expect(form.get("partAmount")).toBe("6000");
    });

    it("keeps the server's field errors when a purchase is refused", async () => {
        globalThis.fetch.mockResolvedValue(
            reply(422, { error: "validation_failed", errors: { photos: "Add at least one photo." } })
        );

        await expect(createTransaction({ customerId: "c1", purchaseType: "scrap", photos: [] })).rejects.toMatchObject({
            status: 422,
            code: "validation_failed",
            body: { errors: { photos: "Add at least one photo." } },
        });
    });

    it("updateTransaction sends the invoice and the amounts as JSON", async () => {
        globalThis.fetch.mockResolvedValue(reply(200, { purchaseId: "p1", ttr: null, warnings: {} }));

        await updateTransaction("p1", { erpInvoiceNo: "INV-2", partAmount: "0", linkedAmounts: { p0: "5" } });

        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toMatch(/\/gold-complete-purchase$/);
        expect(JSON.parse(init.body)).toEqual({
            purchaseId: "p1",
            erpInvoiceNo: "INV-2",
            partAmount: "0",
            linkedAmounts: { p0: "5" },
        });
    });

    it("getGoldPhotoUrls returns the signed URLs in photo order", async () => {
        globalThis.fetch.mockResolvedValue(reply(200, { urls: [{ id: "a", sortOrder: 0, url: "https://signed/a" }] }));

        expect(await getGoldPhotoUrls("p1")).toEqual([{ id: "a", sortOrder: 0, url: "https://signed/a" }]);
        expect(globalThis.fetch.mock.calls[0][0]).toMatch(/\/get-gold-photo-urls$/);
    });
});
