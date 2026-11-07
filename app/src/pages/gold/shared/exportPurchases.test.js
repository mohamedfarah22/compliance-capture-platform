import { afterEach, describe, expect, it, vi } from "vitest";
import { COLUMNS, buildPurchasesZip, cell, csvLine, folderOf } from "./exportPurchases.js";

const rowOf = (overrides = {}) => ({
    purchase_id: "p1",
    created_at: "2026-11-05T01:00:00Z",
    created_by: "Sam Counter",
    completed_at: null,
    completed_by: "",
    erp_invoice_no: "INV-1",
    purchase_type: "scrap",
    cash_band: "10k_plus",
    cash_10k_or_more: true,
    cash_amount: 12000,
    main_seller_name: "Jane Citizen",
    main_seller_phone: "0400 111 222",
    main_id_type: "Driver licence",
    main_id_number: "DL-123",
    main_id_expiry: "2031-01-01",
    joint_seller_name: "",
    joint_seller_phone: "",
    joint_id_type: "",
    joint_id_number: "",
    joint_id_expiry: "",
    phone_at_purchase: "0412 345 678",
    id_sighted: true,
    id_expired_at_time: false,
    goods_photo_count: 1,
    ttr_status: "complete",
    ttr_reference: "INV-1",
    id_document_used: "main: Driver licence, captured 2026-03-01",
    id_photo_copy_taken: "main: newer copy, taken 2026-05-20",
    ...overrides,
});
const purchaseOf = (row = {}, photos = []) => ({ id: row.purchase_id ?? "p1", row: rowOf(row), photos });

// Reads the bytes of a Blob (jsdom's Blob has no arrayBuffer()).
const bytesOf = (blob) =>
    new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.readAsArrayBuffer(blob);
    });

// The stored (uncompressed) entries of a zip made by createZip: { [name]: Uint8Array }.
const entriesOf = (bytes) => {
    const view = new DataView(bytes.buffer);
    const decoder = new TextDecoder();
    const entries = {};
    let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
        const size = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength));
        entries[name] = bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + size);
        offset += 30 + nameLength + size;
    }
    return entries;
};

afterEach(() => vi.unstubAllGlobals());

describe("cell", () => {
    it("always quotes and doubles quotes", () => {
        expect(cell('O"Brien, José')).toBe('"O""Brien, José"');
        expect(cell(null)).toBe('""');
        expect(cell(0)).toBe('"0"');
    });

    it("prefixes a leading = + - @ tab or carriage return with a quote, and nothing else", () => {
        for (const text of ['=HYPERLINK("x")', "+61 412", "-1", "@SUM(1)", "\tx", "\rx"]) {
            expect(cell(text)).toBe(`"'${text.replace(/"/g, '""')}"`);
        }
        expect(cell("a=b")).toBe('"a=b"');
        expect(cell("Jane")).toBe('"Jane"');
    });
});

describe("csvLine", () => {
    const cells = (line) => line.slice(1, -1).split('","');

    it("is in COLUMNS order, with the four new columns last", () => {
        expect(COLUMNS.slice(-4)).toEqual(["ttr_status", "ttr_reference", "id_document_used", "id_photo_copy_taken"]);
        const line = cells(csvLine(purchaseOf()));
        expect(line).toHaveLength(COLUMNS.length);
        const at = (column) => line[COLUMNS.indexOf(column)];
        expect(at("purchase_id")).toBe("p1");
        expect(at("status")).toBe("Completed");
        expect(at("purchase_type")).toBe("Scrap jewellery");
        expect(at("cash_paid")).toBe("$10,000 or more");
        expect(at("austrac_reportable")).toBe("Yes");
        expect(at("cash_amount_aud")).toBe("12000");
        expect(at("id_sighted")).toBe("Yes");
        expect(at("id_expired_at_time")).toBe("No");
        expect(at("folder")).toBe("2026-11-05_INV-1_p1");
        expect(at("ttr_status")).toBe("complete");
        expect(at("ttr_reference")).toBe("INV-1");
        expect(at("id_document_used")).toBe("main: Driver licence, captured 2026-03-01");
        expect(at("id_photo_copy_taken")).toBe("main: newer copy, taken 2026-05-20");
    });

    it("says Incomplete without an invoice, not reportable without cash or a TTR, and empty for no amount", () => {
        const line = cells(
            csvLine(
                purchaseOf({
                    purchase_id: "p3",
                    erp_invoice_no: "",
                    cash_10k_or_more: false,
                    cash_band: "under_10k",
                    cash_amount: null,
                    ttr_status: "",
                    ttr_reference: "",
                })
            )
        );
        const at = (column) => line[COLUMNS.indexOf(column)];
        expect([at("status"), at("austrac_reportable"), at("cash_amount_aud")]).toEqual(["Incomplete", "No", ""]);
        expect(at("folder")).toBe("2026-11-05_NO-INVOICE_p3");
    });

    it("counts a part linked to a TTR as reportable even when it is not flagged", () => {
        const line = cells(csvLine(purchaseOf({ cash_10k_or_more: false, ttr_status: "draft" })));
        expect(line[COLUMNS.indexOf("austrac_reportable")]).toBe("Yes");
    });

    it("keeps the formula protection on text the sellers typed", () => {
        expect(
            csvLine(purchaseOf({ main_seller_name: '=HYPERLINK("http://x")', main_seller_phone: "+61 412" }))
        ).toContain(`"'=HYPERLINK(""http://x"")","'+61 412"`);
    });
});

describe("folderOf", () => {
    it("is the business date, a safe invoice number and the purchase id", () => {
        expect(folderOf({ id: "p9", row: rowOf({ erp_invoice_no: "INV / 9?" }) })).toBe("2026-11-05_INV-9_p9");
    });
});

describe("buildPurchasesZip", () => {
    it("makes a zip with the CSV (byte order mark, CRLF), a read me and one folder per purchase", async () => {
        // jsdom's Blob has no arrayBuffer(), so the image is a stand-in with one.
        const jpeg = { type: "image/jpeg", arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 1, 2, 3]).buffer };
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url) => (url.includes("broken") ? { ok: false } : { ok: true, blob: async () => jpeg }))
        );
        const progress = vi.fn();
        const purchases = [
            purchaseOf({ purchase_id: "p1" }, [
                { name: "main-seller-id-front", url: "https://signed/front" },
                { name: "goods-1", url: "https://signed/goods" },
                { name: "goods-2", url: "https://signed/broken" },
            ]),
            purchaseOf({ purchase_id: "p2", erp_invoice_no: "" }, []),
        ];

        const { blob, filename } = await buildPurchasesZip(purchases, progress);

        expect(filename).toMatch(/^purchases-\d{4}-\d{2}-\d{2}\.zip$/);
        expect(progress).toHaveBeenLastCalledWith(2, 2);
        const entries = entriesOf(await bytesOf(blob));
        expect(Object.keys(entries)).toEqual([
            "purchases.csv",
            "READ ME.txt",
            "2026-11-05_INV-1_p1/main-seller-id-front.jpg",
            "2026-11-05_INV-1_p1/goods-1.jpg",
        ]);
        const csv = entries["purchases.csv"];
        expect([...csv.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const text = new TextDecoder().decode(csv.slice(3));
        const lines = text.split("\r\n");
        expect(lines[0]).toBe(COLUMNS.map((c) => `"${c}"`).join(","));
        expect(lines).toHaveLength(4);
        expect(lines[3]).toBe("");
        expect(lines[1]).toContain('"2026-11-05_INV-1_p1"');
        expect(lines[2]).toContain('"2026-11-05_NO-INVOICE_p2"');
        expect(new TextDecoder().decode(entries["READ ME.txt"])).toContain("contains identity documents");
        expect([...entries["2026-11-05_INV-1_p1/goods-1.jpg"]]).toEqual([0xff, 0xd8, 1, 2, 3]);
    });
});
