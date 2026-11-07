// Builds the "Download" zip on the Purchases page (spec 6.2). `purchases` is the list gold-export returns:
// [{ id, row, photos: [{ name, url }] }], where row holds the CSV fields as raw values and url is a signed URL.
//   purchases.csv                       one row per purchase
//   READ ME.txt                         what is inside and how to handle it
//   <date>_<invoice>_<id>/              one folder per purchase
//     main-seller-id-front.jpg, main-seller-id-back.jpg, joint-seller-id-..., goods-1.jpg ...
// An ID photo is the current copy where the capture's photos were replaced (spec 1.7 C1); the CSV columns
// id_document_used and id_photo_copy_taken say which copy each photo is.
import { BUSINESS_TIMEZONE, bandLabel, businessDate, isIncomplete, typeLabel } from "@gold-rules";
import { isAustracReportable } from "./purchaseAustrac.js";
import { createZip } from "./zip.js";

/** The most purchases one export may hold (the server refuses more). */
export const MAX_EXPORT_PURCHASES = 200;

// The byte order mark makes Excel read the file as UTF-8.
const BOM = "\uFEFF";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// Signed URLs last five minutes, so photos are fetched a few at a time rather than one after another.
const PURCHASES_AT_ONCE = 4;

export const COLUMNS = [
    "purchase_id",
    "recorded_at",
    "recorded_by",
    "status",
    "completed_at",
    "completed_by",
    "erp_invoice_no",
    "purchase_type",
    "cash_paid",
    "austrac_reportable",
    "cash_amount_aud",
    "main_seller_name",
    "main_seller_phone",
    "main_id_type",
    "main_id_number",
    "main_id_expiry",
    "joint_seller_name",
    "joint_seller_phone",
    "joint_id_type",
    "joint_id_number",
    "joint_id_expiry",
    "phone_at_purchase",
    "id_sighted",
    "id_expired_at_time",
    "goods_photo_count",
    "folder",
    "ttr_status",
    "ttr_reference",
    "id_document_used",
    "id_photo_copy_taken",
];

/** CSV cell: always quoted; a value that starts like a formula gets a leading ' so spreadsheets do not run it. */
export const cell = (value) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

const dateTime = (iso) =>
    iso ? new Date(iso).toLocaleString("en-AU", { hour12: false, timeZone: BUSINESS_TIMEZONE }) : "";
const safe = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const yesNo = (value) => (value ? "Yes" : "No");

/** The folder of a purchase's photos in the zip. */
export const folderOf = ({ id, row }) =>
    `${businessDate(row.created_at)}_${safe(row.erp_invoice_no || "") || "NO-INVOICE"}_${id}`;

/** The CSV line for one purchase, in COLUMNS order. */
export const csvLine = (purchase) => {
    const { row } = purchase;
    const values = {
        ...row,
        recorded_at: dateTime(row.created_at),
        recorded_by: row.created_by,
        status: isIncomplete(row) ? "Incomplete" : "Completed",
        completed_at: dateTime(row.completed_at),
        purchase_type: typeLabel(row.purchase_type),
        cash_paid: bandLabel(row.cash_band),
        austrac_reportable: yesNo(isAustracReportable({ ...row, ttr_status: row.ttr_status || null })),
        cash_amount_aud: row.cash_amount ?? "",
        phone_at_purchase: row.phone_at_purchase,
        id_sighted: yesNo(row.id_sighted),
        id_expired_at_time: yesNo(row.id_expired_at_time),
        folder: folderOf(purchase),
    };
    return COLUMNS.map((column) => cell(values[column])).join(",");
};

/** Fetches an image (a signed URL) as bytes. Returns null if it cannot be read. */
const imageBytes = async (src) => {
    try {
        const res = await fetch(src);
        if (!res.ok) return null;
        const blob = await res.blob();
        return { data: new Uint8Array(await blob.arrayBuffer()), ext: EXT[blob.type.split(";")[0]] || "jpg" };
    } catch {
        return null;
    }
};

// Runs fn over the items a few at a time and keeps the results in order.
const mapPool = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
};

/** onProgress(done, total) is optional. Returns { blob, filename }. */
export async function buildPurchasesZip(purchases, onProgress) {
    let done = 0;
    const perPurchase = await mapPool(purchases, PURCHASES_AT_ONCE, async (purchase) => {
        const folder = folderOf(purchase);
        const fetched = await Promise.all(
            purchase.photos.map(async (photo) => {
                const image = await imageBytes(photo.url);
                return image ? { name: `${folder}/${photo.name}.${image.ext}`, data: image.data } : null;
            })
        );
        done += 1;
        onProgress?.(done, purchases.length);
        return { line: csvLine(purchase), files: fetched.filter(Boolean) };
    });

    const stamp = new Date().toLocaleDateString("en-CA");
    const files = [
        {
            name: "purchases.csv",
            data: `${BOM}${[COLUMNS.map(cell).join(","), ...perPurchase.map((p) => p.line)].join("\r\n")}\r\n`,
        },
        {
            name: "READ ME.txt",
            data: [
                `Purchases (scrap jewellery and bullion), downloaded ${new Date().toLocaleString("en-AU")}`,
                `${purchases.length} purchase(s).`,
                "",
                'purchases.csv has one row per purchase. The "folder" column names the folder with that',
                "purchase's photos: the sellers' ID (front and back) and the goods.",
                "Where a seller's ID photos were replaced by a newer copy of the same document, the folder has the newer copy;",
                'the columns "id_document_used" and "id_photo_copy_taken" say which ID was used and which copy the photos are.',
                "",
                "This download contains identity documents. Store it securely and delete it when no longer needed.",
            ].join("\r\n"),
        },
        ...perPurchase.flatMap((p) => p.files),
    ];
    return { blob: createZip(files), filename: `purchases-${stamp}.zip` };
}

/** Saves a Blob as a file in the browser. */
export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
