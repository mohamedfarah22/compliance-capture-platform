import { describe, it, expect } from "vitest";
import {
    AUSTRAC_REPORT_BUSINESS_DAYS,
    BULLION_BANDS,
    BUSINESS_TIMEZONE,
    LOCATION_SNAPSHOT,
    PURCHASE_TYPES,
    addBusinessDays,
    austracDueDate,
    bandLabel,
    businessDate,
    cashAmountValue,
    cashBand,
    evaluateCash,
    idStatus,
    isIncomplete,
    isReportable,
    needsCurrentId,
    parseAud,
    ttrCase,
    typeLabel,
    validateCompletion,
    validatePurchase,
} from "@gold-rules";

// A fixed "now": Monday 2 Nov 2026, 12:00 in Melbourne (UTC+11).
const NOW = new Date("2026-11-02T01:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const validId = { expiry_date: "2030-01-01", captured_at: daysAgo(30) };
const expiredId = { expiry_date: "2026-01-01", captured_at: daysAgo(300) };
const staleId = { expiry_date: "2030-01-01", captured_at: daysAgo(800) };

const jane = { id: "jane", first_name: "Jane", last_name: "Citizen", current_id: validId };
const mark = { id: "mark", first_name: "Mark", last_name: "Nguyen", current_id: expiredId };
const priya = { id: "priya", first_name: "Priya", last_name: "Sharma", current_id: validId };
const stale = { id: "stale", first_name: "Sam", last_name: "Stale", current_id: staleId };

const draft = (overrides = {}) => ({ type: "scrap", photos: ["goods.jpg"], idSighted: true, ...overrides });
const scrapCash = (overrides = {}) => draft({ cash10k: true, ...overrides });
const bullion = (band, overrides = {}) => draft({ type: "bullion", bullionBand: band, ...overrides });

const READY = [];
const BOTH_YES = { selfConducted: true, detailsConfirmed: true };
const ctx = (overrides = {}) => ({ mainCustomer: jane, now: NOW, ...overrides });
const caseAContext = (overrides = {}) => ctx({ readiness: READY, answers: BOTH_YES, ...overrides });

const part = (overrides = {}) => ({ id: "p1", purchase_type: "scrap", cash_amount: 6000, ...overrides });
const dateOf = (d) => d.toISOString().slice(0, 10);

describe("handover test checklist (section 10)", () => {
    it("case 1: photo is required", () => {
        const { errors } = validatePurchase(draft({ photos: [] }), ctx());
        expect(errors.photos).toBe("Add at least one photo of the items purchased.");
    });

    it("case 2: photo only saves, and shows as Incomplete", () => {
        const result = validatePurchase(draft(), ctx());
        expect(result.errors).toEqual({});
        expect(result.warnings).toEqual({});
        expect(result.blocked).toEqual([]);
        expect(result.cash.reportable).toBe(false);
        expect(result.ttr).toEqual({ case: null, invoiceRequired: false });
        expect(isIncomplete({ erp_invoice_no: "" })).toBe(true);
        expect(isIncomplete({ erp_invoice_no: null })).toBe(true);
    });

    it("case 3: cash Yes with an invoice saves and hands off to AUSTRAC (case B opens the TTR at the counter)", () => {
        const result = validatePurchase(scrapCash({ erp_invoice_no: "INV-1" }), ctx({ readiness: ["date_of_birth"] }));
        expect(result.errors).toEqual({});
        expect(result.cash.reportable).toBe(true);
        expect(result.ttr).toEqual({ case: "B", invoiceRequired: true });
    });

    it("case 4: cash Yes without an invoice is AUSTRAC pending with a due date (case A); case B must have the invoice now", () => {
        const caseA = validatePurchase(scrapCash(), caseAContext());
        expect(caseA.errors).toEqual({});
        expect(caseA.ttr).toEqual({ case: "A", invoiceRequired: false });
        expect(isIncomplete({ erp_invoice_no: "" })).toBe(true);
        expect(dateOf(austracDueDate({ created_at: "2026-11-02T01:00:00Z" }))).toBe("2026-11-16");
        const caseB = validatePurchase(scrapCash(), ctx({ readiness: ["date_of_birth"] }));
        expect(caseB.errors.erp_invoice_no).toMatch(/^Enter the ERP invoice number\./);
    });

    it("case 5: completing a cash purchase needs the invoice and hands off to AUSTRAC", () => {
        const withInvoice = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-5" }),
            { id: "t5" },
            { mainCustomer: jane }
        );
        expect(withInvoice.errors).toEqual({});
        expect(withInvoice.blocked).toBe(false);
        expect(withInvoice.cash.reportable).toBe(true);
        const without = validateCompletion(scrapCash(), { id: "t5" }, { mainCustomer: jane, readiness: READY });
        expect(without.errors.erp_invoice_no).toBeTruthy();
    });

    it("case 6: completing a bank purchase with an invoice is not reportable", () => {
        const result = validateCompletion(draft({ erp_invoice_no: "INV-6" }), { id: "t6" }, { mainCustomer: jane });
        expect(result.errors).toEqual({});
        expect(result.blocked).toBe(false);
        expect(result.cash.reportable).toBe(false);
        expect(result.ttr.case).toBe(null);
    });

    it("case 7: an expired main seller blocks a cash purchase, naming them", () => {
        const { blocked, expired } = validatePurchase(scrapCash(), ctx({ mainCustomer: mark }));
        expect(blocked).toEqual([{ customer: mark, role: "main", status: "expired" }]);
        expect(expired).toEqual([{ customer: mark, role: "main" }]);
    });

    it("case 8: an expired joint seller blocks a cash purchase, naming the joint seller", () => {
        const { blocked } = validatePurchase(scrapCash(), ctx({ jointCustomer: mark }));
        expect(blocked).toHaveLength(1);
        expect(blocked[0].role).toBe("joint");
        expect(blocked[0].customer).toBe(mark);
    });

    it("case 9: a new joint seller added mid-form keeps the photos and invoice valid", () => {
        const newJoint = { id: "new", first_name: "Nina", last_name: "New", current_id: validId };
        const result = validatePurchase(scrapCash({ erp_invoice_no: "INV-9" }), ctx({ jointCustomer: newJoint }));
        expect(result.errors).toEqual({});
        expect(result.blocked).toEqual([]);
    });

    it("case 10: the same person cannot be their own joint seller", () => {
        const { errors } = validatePurchase(draft(), ctx({ jointCustomer: jane }));
        expect(errors.joint).toBe("The second person must be a different customer.");
    });

    it("case 11: a joint cash sale with an invoice is always case B", () => {
        const result = validatePurchase(
            scrapCash({ erp_invoice_no: "INV-11" }),
            caseAContext({ jointCustomer: priya })
        );
        expect(result.errors).toEqual({});
        expect(result.ttr).toEqual({ case: "B", invoiceRequired: true });
    });

    it.todo("case 12: a joint purchase appears in both people's history (a database query, tested in Phase 5)");

    it("case 13: cash amount parsing, and the $10,000 line", () => {
        expect(parseAud("12,500")).toBe(12500);
        expect(parseAud("$12500.50")).toBe(12500.5);
        expect(parseAud("abc")).toBeNaN();
        expect(parseAud("")).toBe(null);
        expect(validatePurchase(scrapCash({ cashAmount: "abc" }), ctx()).errors.cashAmount).toBe(
            "Enter an amount like 12,500 or 12500.50."
        );
        expect(validatePurchase(scrapCash({ cashAmount: "" }), caseAContext()).errors.cashAmount).toBeUndefined();
        expect(isReportable(scrapCash({ cashAmount: "8,000" }))).toBe(false);
        expect(isReportable(scrapCash({ cashAmount: "10000" }))).toBe(true);
        expect(isReportable(scrapCash({ cashAmount: "" }))).toBe(true);
    });

    it("case 14: a phone shorter than 8 digits is rejected, 8 or more is fine", () => {
        expect(validatePurchase(draft({ phone: "0412 345" }), ctx()).errors.phone).toBe(
            "Phone number looks too short."
        );
        expect(validatePurchase(draft({ phone: "0412 345 678" }), ctx()).errors.phone).toBeUndefined();
        expect(validatePurchase(draft({ phone: "" }), ctx()).errors.phone).toBeUndefined();
    });

    it.todo("case 15: changing the phone on the customer page (the update_customer_phone RPC, tested in Phase 6)");

    it("case 16: an existing invoice number only warns on a non-reportable purchase", () => {
        const result = validatePurchase(draft({ erp_invoice_no: "INV-106" }), ctx({ sameInvoice: [{ id: "other" }] }));
        expect(result.errors).toEqual({});
        expect(result.warnings.duplicateInvoice).toMatch(/INV-106/);
    });

    it("case 17: every unfinished row is Incomplete, cash or not", () => {
        expect(isIncomplete({ erp_invoice_no: "  " })).toBe(true);
        expect(isIncomplete({ erp_invoice_no: "", cash_10k_or_more: true })).toBe(true);
    });

    it("case 18: the Completed status is 'has an invoice'", () => {
        expect(isIncomplete({ erp_invoice_no: "INV-106" })).toBe(false);
    });

    it.todo("case 19: filters persist in the URL (UI, Phase 9)");
    it.todo("case 20: download zip (UI and gold-export, Phase 11)");
    it.todo("case 21: download record print preview (UI, Phase 11)");
    it.todo("case 22: invoice number links to the purchase record (UI, Phase 9)");

    it("case 23: bullion under $5,000 saves with no report and no ID requirement", () => {
        const d = bullion("under_5k");
        expect(isReportable(d)).toBe(false);
        expect(needsCurrentId(d)).toBe(false);
        expect(cashBand(d)).toBe("under_5k");
        expect(typeLabel(d.type)).toBe("Bullion");
        const result = validatePurchase(d, ctx({ mainCustomer: mark }));
        expect(result.blocked).toEqual([]);
    });

    it("case 24: bullion $5,000 to $9,999 needs a current ID, with no report", () => {
        const d = bullion("5k_to_10k");
        expect(needsCurrentId(d)).toBe(true);
        expect(isReportable(d)).toBe(false);
        expect(validatePurchase(d, ctx({ mainCustomer: mark })).blocked).toHaveLength(1);
        const janeResult = validatePurchase(d, ctx());
        expect(janeResult.blocked).toEqual([]);
        expect(janeResult.cash.reportable).toBe(false);
    });

    it("case 25: bullion $10,000 or more is reported; an amount of 7,000 is not, but still needs the ID", () => {
        expect(isReportable(bullion("10k_plus"))).toBe(true);
        const seven = bullion("10k_plus", { cashAmount: "7,000" });
        expect(isReportable(seven)).toBe(false);
        expect(needsCurrentId(seven)).toBe(true);
        expect(bandLabel(cashBand(seven))).toBe("$5,000 to $9,999");
    });

    it("case 26: purchase types and their labels (the Type filter options)", () => {
        expect(PURCHASE_TYPES).toEqual([
            ["scrap", "Scrap jewellery"],
            ["bullion", "Bullion"],
        ]);
        expect(BULLION_BANDS.map(([value]) => value)).toEqual(["under_5k", "5k_to_10k", "10k_plus"]);
        expect(typeLabel("scrap")).toBe("Scrap jewellery");
    });

    it("case 27: a mixed invoice reaching $10,000 on the same day is reported", () => {
        // Scrap part first: not reported on its own.
        expect(validatePurchase(draft({ erp_invoice_no: "INV-900" }), ctx()).cash.reportable).toBe(false);
        // Then a bullion part on the same invoice: 6,000 + 6,000.
        const result = validatePurchase(
            bullion("10k_plus", { erp_invoice_no: "INV-900", partAmount: "6,000" }),
            ctx({ linked: [part({ id: "scrap-1", cash_amount: 6000 })], sameInvoice: [{ id: "scrap-1" }] })
        );
        expect(result.cash.total).toBe(12000);
        expect(result.cash.reportable).toBe(true);
        expect(result.errors.erp_invoice_no).toBeUndefined();
    });

    it("case 28: a mixed invoice under $10,000 is not reported", () => {
        const cash = evaluateCash(bullion("under_5k", { partAmount: "5,000" }), [part({ cash_amount: 4000 })]);
        expect(cash.total).toBe(9000);
        expect(cash.reportable).toBe(false);
    });

    it("case 29: a third part on an invoice already reported does not report again", () => {
        const reported = [
            part({ id: "p1", purchase_type: "scrap", ttr_transaction_id: "ttr-1" }),
            part({ id: "p2", purchase_type: "bullion", ttr_transaction_id: "ttr-2" }),
        ];
        const cash = evaluateCash(draft({ partAmount: "1,000" }), reported);
        expect(cash.reportable).toBe(true);
        expect(cash.alreadyReported).toBe(true);
    });

    it("case 30: the same invoice on another day or customer is not linked; only the duplicate warning shows", () => {
        const result = validatePurchase(
            draft({ erp_invoice_no: "INV-900" }),
            ctx({ linked: [], sameInvoice: [{ id: "x" }] })
        );
        expect(result.cash.linked).toBe(false);
        expect(result.errors).toEqual({});
        expect(result.warnings.duplicateInvoice).toBeTruthy();
    });
});

describe("cash boundaries", () => {
    it("scrap: $9,999.99 is not reportable, $10,000 is", () => {
        expect(isReportable(scrapCash({ cashAmount: "9,999.99" }))).toBe(false);
        expect(isReportable(scrapCash({ cashAmount: "10,000" }))).toBe(true);
        expect(cashBand(scrapCash({ cashAmount: "9999.99" }))).toBe("under_10k");
        expect(cashBand(scrapCash({ cashAmount: "10000" }))).toBe("10k_plus");
        expect(cashAmountValue(draft({ cashAmount: "10000" }))).toBe(null);
    });

    it("bullion: exactly $5,000 needs a current ID, $4,999.99 does not", () => {
        expect(needsCurrentId(bullion("10k_plus", { cashAmount: "5000" }))).toBe(true);
        expect(needsCurrentId(bullion("10k_plus", { cashAmount: "4999.99" }))).toBe(false);
        expect(needsCurrentId(bullion("5k_to_10k"))).toBe(true);
        expect(isReportable(bullion("10k_plus", { cashAmount: "5000" }))).toBe(false);
    });

    it("linked parts: $9,999.99 + $0.01 adds up to exactly $10,000 and is reportable", () => {
        const cash = evaluateCash(draft({ partAmount: "0.01" }), [part({ cash_amount: 9999.99 })]);
        expect(cash.total).toBe(10000);
        expect(cash.reportable).toBe(true);
        expect(evaluateCash(draft({ partAmount: "0" }), [part({ cash_amount: 9999.99 })]).reportable).toBe(false);
    });

    it("linked parts: an unanswered amount is an error, not a guess", () => {
        const cash = evaluateCash(draft(), [part({ id: "p9", cash_amount: null })]);
        expect(cash.errors.partAmount).toBeTruthy();
        expect(cash.errors.linked_p9).toBeTruthy();
        expect(cash.total).toBe(null);
        expect(cash.byType).toBe(null);
    });
});

describe("idStatus and the ID window (C2)", () => {
    it("is valid, expiring, expired by expiry date, counted in Melbourne days", () => {
        expect(idStatus({ expiry_date: "2026-12-03", captured_at: daysAgo(1) }, 730, NOW)).toBe("valid");
        expect(idStatus({ expiry_date: "2026-12-02", captured_at: daysAgo(1) }, 730, NOW)).toBe("expiring");
        expect(idStatus({ expiry_date: "2026-11-02", captured_at: daysAgo(1) }, 730, NOW)).toBe("expiring");
        expect(idStatus({ expiry_date: "2026-11-01", captured_at: daysAgo(1) }, 730, NOW)).toBe("expired");
    });

    it("uses the Melbourne date, not the server's (23:30 UTC on 1 Nov is already 2 Nov in Melbourne)", () => {
        const late = new Date("2026-11-01T23:30:00Z");
        expect(idStatus({ expiry_date: "2026-11-01", captured_at: daysAgo(1) }, 730, late)).toBe("expired");
    });

    it("is reverify when photographed longer ago than the window", () => {
        expect(idStatus({ expiry_date: "2030-01-01", captured_at: daysAgo(730) }, 730, NOW)).toBe("valid");
        expect(idStatus({ expiry_date: "2030-01-01", captured_at: daysAgo(731) }, 730, NOW)).toBe("reverify");
        expect(idStatus({ expiry_date: "2030-01-01", captured_at: daysAgo(100) }, 90, NOW)).toBe("reverify");
    });

    it("expired wins over reverify; an ID with no expiry is valid; nothing on file is unknown", () => {
        expect(idStatus({ expiry_date: "2020-01-01", captured_at: daysAgo(900) }, 730, NOW)).toBe("expired");
        expect(idStatus({ expiry_date: null, captured_at: daysAgo(10) }, 730, NOW)).toBe("valid");
        expect(idStatus(null, 730, NOW)).toBe("unknown");
        expect(idStatus({}, 730, NOW)).toBe("unknown");
    });

    it("C2: an out-of-window ID blocks when a current ID is needed (reportable)", () => {
        const { blocked, reverify } = validatePurchase(scrapCash(), ctx({ mainCustomer: stale }));
        expect(blocked).toEqual([{ customer: stale, role: "main", status: "reverify" }]);
        expect(reverify).toHaveLength(1);
    });

    it("C2: an out-of-window ID blocks bullion with $5,000 or more cash", () => {
        expect(validatePurchase(bullion("5k_to_10k"), ctx({ mainCustomer: stale })).blocked).toHaveLength(1);
    });

    it("C2: an out-of-window ID is only amber on a purchase that does not need a current ID", () => {
        const { blocked, reverify, errors } = validatePurchase(draft(), ctx({ mainCustomer: stale }));
        expect(blocked).toEqual([]);
        expect(reverify).toEqual([{ customer: stale, role: "main" }]);
        expect(errors).toEqual({});
    });

    it("C2: the window can be changed per business", () => {
        const customer = { ...jane, current_id: { expiry_date: "2030-01-01", captured_at: daysAgo(100) } };
        expect(validatePurchase(scrapCash(), ctx({ mainCustomer: customer })).blocked).toEqual([]);
        expect(
            validatePurchase(scrapCash(), ctx({ mainCustomer: customer, idvMaxRelianceDays: 90 })).blocked
        ).toHaveLength(1);
    });

    it("C2: an expired ID blocks when needed and is only flagged otherwise", () => {
        expect(validatePurchase(scrapCash(), ctx({ mainCustomer: mark })).blocked).toHaveLength(1);
        const nonReportable = validatePurchase(draft(), ctx({ mainCustomer: mark }));
        expect(nonReportable.blocked).toEqual([]);
        expect(nonReportable.expired).toHaveLength(1);
    });

    it("C2: both sellers are checked, and a joint seller outside the window blocks", () => {
        const { blocked } = validatePurchase(scrapCash(), ctx({ jointCustomer: stale }));
        expect(blocked).toEqual([{ customer: stale, role: "joint", status: "reverify" }]);
    });
});

describe("ID sighted (C3)", () => {
    it("is required: unticked and unset both give an error with the hint", () => {
        for (const idSighted of [false, undefined]) {
            const { errors } = validatePurchase(draft({ idSighted }), ctx());
            expect(errors.idSighted).toBe(
                "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first."
            );
        }
    });

    it("uses the joint wording for a joint sale", () => {
        const { errors } = validatePurchase(draft({ idSighted: false }), ctx({ jointCustomer: priya }));
        expect(errors.idSighted).toMatch(/^Both people's IDs/);
        expect(errors.idSighted).toMatch(/Update ID first\.$/);
    });

    it("no error when ticked", () => {
        expect(validatePurchase(draft({ idSighted: true }), ctx()).errors.idSighted).toBeUndefined();
    });
});

describe("ttrCase", () => {
    const reportable = evaluateCash(scrapCash());
    const notReportable = evaluateCash(draft());
    const run = (overrides = {}) =>
        ttrCase({ cash: reportable, isJoint: false, readiness: READY, answers: BOTH_YES, ...overrides });

    it("a purchase that is not reportable has no case and no invoice requirement", () => {
        expect(run({ cash: notReportable })).toEqual({ case: null, invoiceRequired: false });
    });

    it("ready, single seller, both answers Yes is case A and the invoice is optional", () => {
        expect(run()).toEqual({ case: "A", invoiceRequired: false });
        expect(run({ readiness: { missing: [] } })).toEqual({ case: "A", invoiceRequired: false });
    });

    it("any No answer is case B with the invoice required", () => {
        expect(run({ answers: { selfConducted: false, detailsConfirmed: true } })).toEqual({
            case: "B",
            invoiceRequired: true,
        });
        expect(run({ answers: { selfConducted: true, detailsConfirmed: false } })).toEqual({
            case: "B",
            invoiceRequired: true,
        });
    });

    it("an unanswered question is case B", () => {
        expect(run({ answers: { selfConducted: true } }).case).toBe("B");
        expect(run({ answers: undefined }).case).toBe("B");
    });

    it("a joint sale is always case B", () => {
        expect(run({ isJoint: true })).toEqual({ case: "B", invoiceRequired: true });
    });

    it("details missing on file is case B, and so is not knowing", () => {
        expect(run({ readiness: ["date_of_birth"] })).toEqual({ case: "B", invoiceRequired: true });
        expect(run({ readiness: undefined })).toEqual({ case: "B", invoiceRequired: true });
    });
});

describe("invoice required in case B", () => {
    it("names the customer and says their details are incomplete when fields are missing", () => {
        const { errors } = validatePurchase(scrapCash(), ctx({ readiness: ["date_of_birth"] }));
        expect(errors.erp_invoice_no).toBe(
            "Enter the ERP invoice number. Jane Citizen's AUSTRAC details are incomplete, so the report must be started now."
        );
    });

    it("names the customer when the reason is a No answer or a joint sale", () => {
        const noAnswer = validatePurchase(scrapCash(), caseAContext({ answers: { selfConducted: false } }));
        expect(noAnswer.errors.erp_invoice_no).toMatch(/Jane Citizen/);
        const joint = validatePurchase(scrapCash(), caseAContext({ jointCustomer: priya }));
        expect(joint.errors.erp_invoice_no).toMatch(/Jane Citizen/);
    });

    it("is satisfied by entering the invoice", () => {
        const result = validatePurchase(scrapCash({ erp_invoice_no: "INV-7" }), ctx({ readiness: ["date_of_birth"] }));
        expect(result.errors.erp_invoice_no).toBeUndefined();
    });

    it("is not asked in case A or when the purchase is not reportable", () => {
        expect(validatePurchase(scrapCash(), caseAContext()).errors.erp_invoice_no).toBeUndefined();
        expect(validatePurchase(draft(), ctx({ readiness: ["date_of_birth"] })).errors.erp_invoice_no).toBeUndefined();
    });

    it("on Complete purchase a blank invoice is an error either way", () => {
        const b = validateCompletion(scrapCash(), { id: "t1" }, { mainCustomer: jane, readiness: ["date_of_birth"] });
        expect(b.errors.erp_invoice_no).toMatch(/Jane Citizen/);
        const a = validateCompletion(
            scrapCash(),
            { id: "t1", ttr_self_conducted: true, ttr_details_confirmed: true },
            { mainCustomer: jane, readiness: READY }
        );
        expect(a.errors.erp_invoice_no).toBe("Enter the ERP invoice number for this purchase.");
        expect(a.ttr.case).toBe("A");
    });
});

describe("duplicate invoice", () => {
    it("blocks a reportable purchase that is not a linked part", () => {
        const result = validatePurchase(
            scrapCash({ erp_invoice_no: "INV-1" }),
            caseAContext({ sameInvoice: [{ id: "someone-elses" }] })
        );
        expect(result.errors.erp_invoice_no).toMatch(/INV-1 is already used by another purchase/);
        expect(result.warnings).toEqual({});
    });

    it("only warns for a non-reportable purchase", () => {
        const result = validatePurchase(draft({ erp_invoice_no: "INV-1" }), ctx({ sameInvoice: [{ id: "x" }] }));
        expect(result.errors).toEqual({});
        expect(result.warnings.duplicateInvoice).toMatch(/INV-1/);
    });

    it("allows a same-day linked part", () => {
        const result = validatePurchase(
            scrapCash({ erp_invoice_no: "INV-1", partAmount: "6000" }),
            caseAContext({ linked: [part({ id: "p1" })], sameInvoice: [{ id: "p1" }] })
        );
        expect(result.cash.reportable).toBe(true);
        expect(result.errors).toEqual({});
        expect(result.warnings).toEqual({});
    });

    it("still blocks when a different purchase, not a linked part, also uses the invoice", () => {
        const result = validatePurchase(
            scrapCash({ erp_invoice_no: "INV-1", partAmount: "6000" }),
            caseAContext({ linked: [part({ id: "p1" })], sameInvoice: [{ id: "p1" }, { id: "last-week" }] })
        );
        expect(result.errors.erp_invoice_no).toMatch(/already used/);
    });

    it("on Complete purchase the purchase itself is not a duplicate of itself", () => {
        const result = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-1" }),
            { id: "t1" },
            { mainCustomer: jane, sameInvoice: [{ id: "t1" }] }
        );
        expect(result.errors).toEqual({});
        const dup = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-1" }),
            { id: "t1" },
            { mainCustomer: jane, sameInvoice: [{ id: "t1" }, { id: "t2" }] }
        );
        expect(dup.errors.erp_invoice_no).toMatch(/already used/);
    });
});

describe("a completed TTR on the invoice (spec 3.5)", () => {
    const completedScrap = part({
        id: "p1",
        purchase_type: "scrap",
        cash_amount: 12000,
        ttr_transaction_id: "t1",
        ttr_status: "completed",
    });
    const message =
        "The AUSTRAC report for INV-900 is already finished. Use a new ERP invoice number for this purchase.";

    it("blocks a new part of the same type", () => {
        const result = validatePurchase(
            draft({ erp_invoice_no: "INV-900", partAmount: "3000" }),
            ctx({ linked: [completedScrap], sameInvoice: [{ id: "p1" }] })
        );
        expect(result.errors.erp_invoice_no).toBe(message);
        expect(result.cash.ttrCompleted).toBe(true);
    });

    it("blocks adding the invoice on Complete purchase", () => {
        const result = validateCompletion(
            draft({ type: "scrap", erp_invoice_no: "INV-900", partAmount: "3000" }),
            { id: "t9" },
            { mainCustomer: jane, linked: [completedScrap] }
        );
        expect(result.errors.erp_invoice_no).toBe(message);
    });

    it("does not block a part of the other type", () => {
        const result = validatePurchase(
            bullion("under_5k", { erp_invoice_no: "INV-900", partAmount: "3000" }),
            ctx({ linked: [completedScrap], sameInvoice: [{ id: "p1" }] })
        );
        expect(result.errors.erp_invoice_no).toBeUndefined();
    });

    it("does not block when the TTR is still a draft; the part joins it", () => {
        const draftTtr = { ...completedScrap, ttr_status: "draft" };
        const result = validatePurchase(
            draft({ erp_invoice_no: "INV-900", partAmount: "3000" }),
            caseAContext({ linked: [draftTtr], sameInvoice: [{ id: "p1" }] })
        );
        expect(result.errors.erp_invoice_no).toBeUndefined();
        expect(result.cash.alreadyReported).toBe(true);
        expect(result.cash.ttrCompleted).toBe(false);
    });
});

describe("mixed scrap and bullion invoice (spec 3.4)", () => {
    it("$6k scrap + $6k bullion is reportable, with $6k of cash per type", () => {
        const cash = evaluateCash(bullion("10k_plus", { partAmount: "6000" }), [
            part({ id: "scrap-1", purchase_type: "scrap", cash_amount: 6000 }),
        ]);
        expect(cash.total).toBe(12000);
        expect(cash.reportable).toBe(true);
        expect(cash.byType).toEqual({ bullion: 6000, scrap: 6000 });
        expect([...cash.ttrTypes].sort()).toEqual(["bullion", "scrap"]);
    });

    it("bullion paid by bank transfer adds no bullion cash, so only a scrap TTR", () => {
        const cash = evaluateCash(bullion("under_5k", { partAmount: "0" }), [
            part({ id: "scrap-1", purchase_type: "scrap", cash_amount: 12000 }),
        ]);
        expect(cash.reportable).toBe(true);
        expect(cash.byType).toEqual({ bullion: 0, scrap: 12000 });
        expect(cash.ttrTypes).toEqual(["scrap"]);
    });

    it("several parts of one type are added together", () => {
        const cash = evaluateCash(draft({ partAmount: "2000" }), [
            part({ id: "a", purchase_type: "scrap", cash_amount: 5000 }),
            part({ id: "b", purchase_type: "scrap", cash_amount: 4000 }),
            part({ id: "c", purchase_type: "bullion", cash_amount: 1000 }),
        ]);
        expect(cash.byType).toEqual({ scrap: 11000, bullion: 1000 });
    });

    it("a single purchase reports its own type only, and a non-reportable one has no TTR types", () => {
        expect(evaluateCash(scrapCash({ cashAmount: "11000" })).ttrTypes).toEqual(["scrap"]);
        expect(evaluateCash(scrapCash({ cashAmount: "11000" })).byType).toEqual({ scrap: 11000 });
        expect(evaluateCash(draft()).ttrTypes).toEqual([]);
    });

    it("alreadyReported is per type", () => {
        const scrapReported = [part({ purchase_type: "scrap", ttr_transaction_id: "t1" })];
        expect(evaluateCash(bullion("10k_plus", { partAmount: "6000" }), scrapReported).alreadyReported).toBe(false);
        expect(evaluateCash(draft({ partAmount: "6000" }), scrapReported).alreadyReported).toBe(true);
        expect(evaluateCash(draft({ partAmount: "6000" }), [part()]).alreadyReported).toBe(false);
    });
});

describe("AUSTRAC deadline", () => {
    it("a Friday sale is due 10 business days later (Friday, two weeks on)", () => {
        // Fri 6 Nov 2026, 14:00 Melbourne
        expect(dateOf(austracDueDate({ created_at: "2026-11-06T03:00:00Z" }))).toBe("2026-11-20");
        expect(AUSTRAC_REPORT_BUSINESS_DAYS).toBe(10);
    });

    it("a Saturday sale counts from the next Monday", () => {
        // Sat 7 Nov 2026, 12:00 Melbourne: Mon 9 is day 1, Fri 20 is day 10
        expect(dateOf(austracDueDate({ created_at: "2026-11-07T01:00:00Z" }))).toBe("2026-11-20");
        // Sun 8 Nov
        expect(dateOf(austracDueDate({ created_at: "2026-11-08T01:00:00Z" }))).toBe("2026-11-20");
    });

    it("a sale at month end rolls into the next month, skipping weekends", () => {
        // Mon 30 Nov 2026 -> Mon 14 Dec
        expect(dateOf(austracDueDate({ created_at: "2026-11-30T03:00:00Z" }))).toBe("2026-12-14");
        // Thu 29 Oct 2026 -> Thu 12 Nov
        expect(dateOf(austracDueDate({ created_at: "2026-10-29T03:00:00Z" }))).toBe("2026-11-12");
    });

    it("counts from the Melbourne date, not the UTC date", () => {
        // 22:30 UTC Thu 5 Nov is 09:30 Fri 6 Nov in Melbourne -> Fri 20 Nov, not Thu 19 Nov
        expect(dateOf(austracDueDate({ created_at: "2026-11-05T22:30:00Z" }))).toBe("2026-11-20");
    });

    it("addBusinessDays adds n weekdays and does not skip holidays", () => {
        expect(dateOf(addBusinessDays("2026-11-02T01:00:00Z", 1))).toBe("2026-11-03");
        expect(dateOf(addBusinessDays("2026-11-06T03:00:00Z", 1))).toBe("2026-11-09");
        // Melbourne Cup day, Tue 3 Nov 2026, is not skipped
        expect(dateOf(addBusinessDays("2026-11-02T01:00:00Z", 2))).toBe("2026-11-04");
    });
});

describe("validateCompletion window and expiry block", () => {
    it("blocks a reportable purchase whose ID was outside the window at the time", () => {
        const result = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-1" }),
            { id: "t1", id_outside_window_at_time: true },
            { mainCustomer: jane }
        );
        expect(result.blocked).toBe(true);
    });

    it("blocks a reportable purchase whose ID had expired at the time", () => {
        const result = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-1" }),
            { id: "t1", id_expired_at_time: true },
            { mainCustomer: jane }
        );
        expect(result.blocked).toBe(true);
    });

    it("does not block a purchase that is not reportable", () => {
        const result = validateCompletion(
            draft({ erp_invoice_no: "INV-1" }),
            { id: "t1", id_outside_window_at_time: true, id_expired_at_time: true },
            { mainCustomer: jane }
        );
        expect(result.blocked).toBe(false);
    });

    it("does not block a reportable purchase whose ID was fine at the time", () => {
        const result = validateCompletion(scrapCash({ erp_invoice_no: "INV-1" }), { id: "t1" }, { mainCustomer: jane });
        expect(result.blocked).toBe(false);
    });
});

describe("shared constants and dates", () => {
    it("business time zone and location", () => {
        expect(BUSINESS_TIMEZONE).toBe("Australia/Melbourne");
        expect(LOCATION_SNAPSHOT).toBe("Coburg, VIC");
    });

    it("businessDate gives the Melbourne calendar date across the UTC boundary", () => {
        expect(businessDate("2026-11-04T23:30:00Z")).toBe("2026-11-05");
        expect(businessDate("2026-11-05T12:00:00Z")).toBe("2026-11-05");
        expect(businessDate("2026-06-30T14:30:00Z")).toBe("2026-07-01"); // winter, UTC+10
    });
});
