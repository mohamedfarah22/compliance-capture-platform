import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { addBusinessDays, austracDueDate, isIncomplete, validateCompletion, validatePurchase } from "@gold-rules";

// One test per row of docs/uat-gold-04-rules.md, the sign-off sheet the client and compliance officer
// agree. Each test is named with its row ID, and the last test fails if a row and a test ever differ.

// A fixed "now": Monday 2 Nov 2026, 12:00 in Melbourne (UTC+11).
const NOW = new Date("2026-11-02T01:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const jane = {
    id: "jane",
    first_name: "Jane",
    last_name: "Citizen",
    current_id: { expiry_date: "2030-01-01", captured_at: daysAgo(30) },
};
const priya = {
    id: "priya",
    first_name: "Priya",
    last_name: "Sharma",
    current_id: { expiry_date: "2030-01-01", captured_at: daysAgo(30) },
};
const expired = {
    id: "mark",
    first_name: "Mark",
    last_name: "Nguyen",
    current_id: { expiry_date: "2026-01-01", captured_at: daysAgo(300) },
};
const tooOld = {
    id: "sam",
    first_name: "Sam",
    last_name: "Stale",
    current_id: { expiry_date: "2030-01-01", captured_at: daysAgo(800) },
};

const draft = (overrides = {}) => ({ type: "scrap", photos: ["goods.jpg"], idSighted: true, ...overrides });
const scrapCash = (overrides = {}) => draft({ cash10k: true, ...overrides });
const bullion = (band, overrides = {}) => draft({ type: "bullion", bullionBand: band, ...overrides });
const part = (overrides = {}) => ({ id: "p1", purchase_type: "scrap", cash_amount: 6000, ...overrides });

// Rows outside section D assume case A, so a missing invoice never shows up as "blocked".
const caseA = (overrides = {}) => ({
    mainCustomer: jane,
    readiness: [],
    answers: { selfConducted: true, detailsConfirmed: true },
    now: NOW,
    ...overrides,
});

// The sheet's columns for one sale at the counter.
const atCounter = (d, context = caseA()) => {
    const result = validatePurchase(d, context);
    return {
        reported: result.cash.reportable,
        currentIdNeeded: result.cash.needsId,
        blocked: Object.keys(result.errors).length > 0 || result.blocked.length > 0,
        case: result.ttr.case,
        invoiceNow: result.ttr.invoiceRequired,
        result,
    };
};

const dueDate = (createdAt) => austracDueDate({ created_at: createdAt }).toISOString().slice(0, 10);

describe("A. Cash amounts", () => {
    it("A1: scrap, cash $9,999.99 is not reported", () => {
        expect(atCounter(scrapCash({ cashAmount: "9999.99" }))).toMatchObject({
            reported: false,
            currentIdNeeded: false,
            blocked: false,
            case: null,
            invoiceNow: false,
        });
    });

    it("A2: scrap, cash exactly $10,000 is reported and needs a current ID", () => {
        expect(atCounter(scrapCash({ cashAmount: "10000" }))).toMatchObject({
            reported: true,
            currentIdNeeded: true,
            blocked: false,
        });
    });

    it("A3: scrap, $10,000 or more answered Yes with no amount is reported", () => {
        expect(atCounter(scrapCash())).toMatchObject({ reported: true, currentIdNeeded: true, blocked: false });
    });

    it("A4: scrap, Yes answered but $8,000 entered is not reported", () => {
        expect(atCounter(scrapCash({ cashAmount: "8000" }))).toMatchObject({
            reported: false,
            currentIdNeeded: false,
            blocked: false,
            case: null,
        });
    });

    it("A5: scrap paid by bank transfer is not reported", () => {
        expect(atCounter(draft({ cash10k: false }))).toMatchObject({
            reported: false,
            currentIdNeeded: false,
            blocked: false,
            case: null,
        });
    });

    it("A6: bullion, cash under $5,000 needs nothing", () => {
        expect(atCounter(bullion("under_5k"))).toMatchObject({
            reported: false,
            currentIdNeeded: false,
            blocked: false,
            case: null,
        });
    });

    it("A7: bullion, cash $5,000 to $9,999 needs a current ID, blocked only if it is expired or too old", () => {
        expect(atCounter(bullion("5k_to_10k"))).toMatchObject({
            reported: false,
            currentIdNeeded: true,
            blocked: false,
        });
        expect(atCounter(bullion("5k_to_10k"), caseA({ mainCustomer: expired })).blocked).toBe(true);
        expect(atCounter(bullion("5k_to_10k"), caseA({ mainCustomer: tooOld })).blocked).toBe(true);
    });

    it("A8: bullion, $10,000 or more answered but $7,000 entered needs a current ID, no report", () => {
        const d = bullion("10k_plus", { cashAmount: "7000" });
        expect(atCounter(d)).toMatchObject({ reported: false, currentIdNeeded: true, blocked: false, case: null });
        expect(atCounter(d, caseA({ mainCustomer: tooOld })).blocked).toBe(true);
    });

    it("A9: bullion, $10,000 or more answered but exactly $5,000 entered needs a current ID", () => {
        const d = bullion("10k_plus", { cashAmount: "5000" });
        expect(atCounter(d)).toMatchObject({ reported: false, currentIdNeeded: true, blocked: false });
        expect(atCounter(d, caseA({ mainCustomer: expired })).blocked).toBe(true);
    });

    it("A10: bullion, $10,000 or more answered but $4,999.99 entered needs nothing", () => {
        expect(atCounter(bullion("10k_plus", { cashAmount: "4999.99" }))).toMatchObject({
            reported: false,
            currentIdNeeded: false,
            blocked: false,
            case: null,
        });
    });

    it("A11: bullion, cash $10,000 or more is reported", () => {
        expect(atCounter(bullion("10k_plus"))).toMatchObject({ reported: true, currentIdNeeded: true, blocked: false });
    });
});

describe("B. Several parts on one invoice", () => {
    const linkedContext = (linked, overrides = {}) =>
        caseA({ linked, sameInvoice: linked.map((t) => ({ id: t.id })), ...overrides });

    it("B1: scrap $6,000 + bullion $6,000 on INV-900 is two reports of $6,000 each", () => {
        const row = atCounter(
            bullion("10k_plus", { erp_invoice_no: "INV-900", partAmount: "6000" }),
            linkedContext([part({ purchase_type: "scrap", cash_amount: 6000 })])
        );
        expect(row).toMatchObject({ reported: true, currentIdNeeded: true, blocked: false });
        expect(row.result.cash.total).toBe(12000);
        expect(row.result.cash.byType).toEqual({ scrap: 6000, bullion: 6000 });
        expect(row.result.cash.ttrTypes.sort()).toEqual(["bullion", "scrap"]);
    });

    it("B2: scrap $4,000 + bullion $5,000 is not reported, but the bullion part needs a current ID", () => {
        const d = bullion("5k_to_10k", { erp_invoice_no: "INV-900", partAmount: "5000" });
        const linked = [part({ purchase_type: "scrap", cash_amount: 4000 })];
        expect(atCounter(d, linkedContext(linked))).toMatchObject({
            reported: false,
            currentIdNeeded: true,
            blocked: false,
            case: null,
        });
        expect(atCounter(d, linkedContext(linked, { mainCustomer: expired })).blocked).toBe(true);
    });

    it("B3: scrap $9,999.99 + $0.01 is exactly $10,000 and reported", () => {
        const row = atCounter(
            scrapCash({ erp_invoice_no: "INV-900", partAmount: "0.01" }),
            linkedContext([part({ cash_amount: 9999.99 })])
        );
        expect(row).toMatchObject({ reported: true, currentIdNeeded: true, blocked: false });
        expect(row.result.cash.total).toBe(10000);
    });

    it("B4: scrap $12,000 cash + bullion by bank transfer is one scrap report only", () => {
        const row = atCounter(
            bullion("under_5k", { erp_invoice_no: "INV-900", partAmount: "0" }),
            linkedContext([part({ cash_amount: 12000 })])
        );
        expect(row).toMatchObject({ reported: true, blocked: false });
        expect(row.result.cash.ttrTypes).toEqual(["scrap"]);
    });

    it("B5: another scrap part while the scrap report is still a draft joins that report", () => {
        const row = atCounter(
            scrapCash({ erp_invoice_no: "INV-900", partAmount: "3000" }),
            linkedContext([part({ cash_amount: 12000, ttr_transaction_id: "t1", ttr_status: "draft" })])
        );
        expect(row).toMatchObject({ reported: true, currentIdNeeded: true, blocked: false });
        expect(row.result.cash.alreadyReported).toBe(true);
        expect(row.result.cash.ttrCompleted).toBe(false);
    });

    it("B6: another scrap part after the scrap report was completed is blocked", () => {
        const row = atCounter(
            scrapCash({ erp_invoice_no: "INV-900", partAmount: "3000" }),
            linkedContext([part({ cash_amount: 12000, ttr_transaction_id: "t1", ttr_status: "complete" })])
        );
        expect(row.blocked).toBe(true);
        expect(row.result.errors.erp_invoice_no).toBe(
            "The AUSTRAC report for INV-900 is already finished. Use a new ERP invoice number for this purchase."
        );
    });

    it("B7: a bullion part when only the scrap report was completed is not blocked", () => {
        const row = atCounter(
            bullion("under_5k", { erp_invoice_no: "INV-900", partAmount: "3000" }),
            linkedContext([part({ cash_amount: 12000, ttr_transaction_id: "t1", ttr_status: "complete" })])
        );
        expect(row.blocked).toBe(false);
        expect(row.result.cash.ttrCompleted).toBe(false);
    });

    it("B8: the same invoice on another day or for another customer is judged alone", () => {
        // gold.linked_parts only returns same-customer, same-day parts (pgTAP 08_gold_reads), so nothing is linked.
        const row = atCounter(draft({ erp_invoice_no: "INV-900" }), caseA({ sameInvoice: [{ id: "last-week" }] }));
        expect(row.result.cash.linked).toBe(false);
        expect(row.result.cash.total).toBeNull();
        expect(row.result.warnings.duplicateInvoice).toMatch(/INV-900/);
    });
});

describe("C. ID checks", () => {
    it("C1: a reportable sale with an expired ID is blocked (Update ID now)", () => {
        const row = atCounter(scrapCash(), caseA({ mainCustomer: expired }));
        expect(row).toMatchObject({ reported: true, currentIdNeeded: true, blocked: true });
        expect(row.result.blocked).toEqual([{ customer: expired, role: "main", status: "expired" }]);
    });

    it("C2: a reportable sale with an ID photographed longer ago than 730 days is blocked", () => {
        const row = atCounter(scrapCash(), caseA({ mainCustomer: tooOld }));
        expect(row.blocked).toBe(true);
        expect(row.result.blocked).toEqual([{ customer: tooOld, role: "main", status: "reverify" }]);
    });

    it("C3: bullion $5,000 to $9,999 with an expired or too-old ID is blocked", () => {
        expect(atCounter(bullion("5k_to_10k"), caseA({ mainCustomer: expired }))).toMatchObject({
            reported: false,
            currentIdNeeded: true,
            blocked: true,
        });
        expect(atCounter(bullion("5k_to_10k"), caseA({ mainCustomer: tooOld })).blocked).toBe(true);
    });

    it("C4: a joint reportable sale is blocked by the second person's expired ID, naming them", () => {
        const row = atCounter(scrapCash({ erp_invoice_no: "INV-1" }), caseA({ jointCustomer: expired }));
        expect(row.result.blocked).toEqual([{ customer: expired, role: "joint", status: "expired" }]);
    });

    it("C5: scrap under $10,000 with an expired ID saves, flagged as expired", () => {
        const row = atCounter(draft(), caseA({ mainCustomer: expired }));
        expect(row).toMatchObject({ reported: false, currentIdNeeded: false, blocked: false });
        expect(row.result.expired).toEqual([{ customer: expired, role: "main" }]);
    });

    it("C6: scrap under $10,000 with a too-old ID saves, with the amber notice", () => {
        const row = atCounter(draft(), caseA({ mainCustomer: tooOld }));
        expect(row).toMatchObject({ reported: false, currentIdNeeded: false, blocked: false });
        expect(row.result.reverify).toEqual([{ customer: tooOld, role: "main" }]);
    });

    it("C7: any sale with the ID-sighted box not ticked is blocked", () => {
        const row = atCounter(draft({ idSighted: false }));
        expect(row.blocked).toBe(true);
        expect(row.result.errors.idSighted).toBe(
            "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first."
        );
    });

    it("C8: a joint sale with the box not ticked is blocked, with the joint wording", () => {
        const row = atCounter(draft({ idSighted: false }), caseA({ jointCustomer: priya }));
        expect(row.blocked).toBe(true);
        expect(row.result.errors.idSighted).toMatch(/^Both people's IDs must be sighted today/);
    });

    it("C9: completing a reportable sale whose ID was expired or too old when bought is blocked", () => {
        const sale = scrapCash({ erp_invoice_no: "INV-1" });
        expect(validateCompletion(sale, { id: "t1", id_expired_at_time: true }, { mainCustomer: jane }).blocked).toBe(
            true
        );
        expect(
            validateCompletion(sale, { id: "t1", id_outside_window_at_time: true }, { mainCustomer: jane }).blocked
        ).toBe(true);
    });

    it("C10: completing a non-reportable sale with an expired or too-old ID at the time is allowed, invoice needed", () => {
        const flags = { id: "t1", id_expired_at_time: true, id_outside_window_at_time: true };
        expect(validateCompletion(draft({ erp_invoice_no: "INV-1" }), flags, { mainCustomer: jane }).blocked).toBe(
            false
        );
        expect(validateCompletion(draft(), flags, { mainCustomer: jane }).errors.erp_invoice_no).toBe(
            "Enter the ERP invoice number for this purchase."
        );
    });

    it("C11: completing a sale whose ID was fine at the time is allowed, even if it has expired since", () => {
        const sale = { id: "t1", ttr_self_conducted: true, ttr_details_confirmed: true };
        const result = validateCompletion(scrapCash({ erp_invoice_no: "INV-1" }), sale, {
            mainCustomer: expired,
            readiness: [],
        });
        expect(result.blocked).toBe(false);
        expect(result.errors).toEqual({});
        expect(validateCompletion(scrapCash(), sale, { mainCustomer: expired, readiness: [] }).errors).toHaveProperty(
            "erp_invoice_no"
        );
    });
});

describe("D. Case A or case B", () => {
    it("D1: not reportable has no case and no invoice requirement", () => {
        expect(atCounter(draft())).toMatchObject({ reported: false, case: null, invoiceNow: false });
    });

    it("D2: one seller, all details on file, both answers Yes is case A, invoice optional", () => {
        expect(atCounter(scrapCash())).toMatchObject({ reported: true, case: "A", invoiceNow: false, blocked: false });
    });

    it("D3: 'acting on their own behalf?' No is case B, invoice required", () => {
        expect(
            atCounter(scrapCash(), caseA({ answers: { selfConducted: false, detailsConfirmed: true } }))
        ).toMatchObject({ case: "B", invoiceNow: true });
    });

    it("D4: 'details still correct?' No is case B, invoice required", () => {
        expect(
            atCounter(scrapCash(), caseA({ answers: { selfConducted: true, detailsConfirmed: false } }))
        ).toMatchObject({ case: "B", invoiceNow: true });
    });

    it("D5: an unanswered question is case B, invoice required", () => {
        expect(atCounter(scrapCash(), caseA({ answers: { selfConducted: true } }))).toMatchObject({
            case: "B",
            invoiceNow: true,
        });
    });

    it("D6: a joint sale is case B even with everything on file and both answers Yes", () => {
        expect(atCounter(scrapCash(), caseA({ jointCustomer: priya }))).toMatchObject({ case: "B", invoiceNow: true });
    });

    it("D7: AUSTRAC details missing on file is case B, with the incomplete-details message", () => {
        const row = atCounter(scrapCash(), caseA({ readiness: ["date_of_birth"] }));
        expect(row).toMatchObject({ case: "B", invoiceNow: true });
        expect(row.result.errors.erp_invoice_no).toBe(
            "Enter the ERP invoice number. Jane Citizen's AUSTRAC details are incomplete, so the report must be started now."
        );
    });

    it("D8: case B with the invoice entered is not blocked", () => {
        expect(
            atCounter(scrapCash({ erp_invoice_no: "INV-7" }), caseA({ readiness: ["date_of_birth"] }))
        ).toMatchObject({ case: "B", blocked: false });
    });
});

describe("E. Invoice numbers", () => {
    it("E1: a reportable sale with an invoice used on another purchase is blocked", () => {
        const row = atCounter(
            scrapCash({ erp_invoice_no: "INV-1" }),
            caseA({ sameInvoice: [{ id: "someone-elses" }] })
        );
        expect(row.blocked).toBe(true);
        expect(row.result.errors.erp_invoice_no).toBe(
            "The ERP invoice number INV-1 is already used by another purchase. A reportable purchase needs its own invoice number."
        );
    });

    it("E2: a non-reportable sale with an invoice used elsewhere only warns", () => {
        const row = atCounter(draft({ erp_invoice_no: "INV-1" }), caseA({ sameInvoice: [{ id: "someone-elses" }] }));
        expect(row.blocked).toBe(false);
        expect(row.result.warnings.duplicateInvoice).toBe(
            "The ERP invoice number INV-1 is already recorded on another purchase."
        );
    });

    it("E3: an invoice used only by an earlier part of the same sale is not blocked", () => {
        const row = atCounter(
            scrapCash({ erp_invoice_no: "INV-1", partAmount: "6000" }),
            caseA({ linked: [part({ id: "p1" })], sameInvoice: [{ id: "p1" }] })
        );
        expect(row).toMatchObject({ reported: true, blocked: false });
        expect(row.result.warnings).toEqual({});
    });

    it("E4: completing a saved sale with the invoice left blank is blocked", () => {
        expect(validateCompletion(draft(), { id: "t1" }, { mainCustomer: jane }).errors.erp_invoice_no).toBe(
            "Enter the ERP invoice number for this purchase."
        );
    });

    it("E5: completing a saved sale finds its own invoice number on itself, which is not a duplicate", () => {
        const result = validateCompletion(
            scrapCash({ erp_invoice_no: "INV-1" }),
            { id: "t1" },
            {
                mainCustomer: jane,
                sameInvoice: [{ id: "t1" }],
            }
        );
        expect(result.errors).toEqual({});
    });

    it("E6: photo only, no invoice, not reportable saves as Incomplete with no report", () => {
        expect(atCounter(draft())).toMatchObject({ reported: false, blocked: false, case: null, invoiceNow: false });
        expect(isIncomplete({ erp_invoice_no: "" })).toBe(true);
    });
});

describe("F. Report deadline", () => {
    it("F1: a sale on Friday 6 Nov 2026 is due Friday 20 Nov 2026", () => {
        expect(dueDate("2026-11-06T03:00:00Z")).toBe("2026-11-20");
    });

    it("F2: a sale on Saturday 7 Nov 2026 is due Friday 20 Nov 2026", () => {
        expect(dueDate("2026-11-07T01:00:00Z")).toBe("2026-11-20");
    });

    it("F3: a sale on Sunday 8 Nov 2026 is due Friday 20 Nov 2026", () => {
        expect(dueDate("2026-11-08T01:00:00Z")).toBe("2026-11-20");
    });

    it("F4: a sale on Monday 30 Nov 2026 is due Monday 14 Dec 2026", () => {
        expect(dueDate("2026-11-30T03:00:00Z")).toBe("2026-12-14");
    });

    it("F5: a sale on Thursday 29 Oct 2026 is due Thursday 12 Nov 2026", () => {
        expect(dueDate("2026-10-29T03:00:00Z")).toBe("2026-11-12");
    });

    it("F6: a sale at 9:30 am Friday 6 Nov in Melbourne (Thursday in UTC) is due Friday 20 Nov", () => {
        expect(dueDate("2026-11-05T22:30:00Z")).toBe("2026-11-20");
    });

    it("F7: Melbourne Cup day (Tuesday 3 Nov 2026) still counts as a business day", () => {
        // Monday 2 Nov + 10 business days, counting Tue 3 Nov: Monday 16 Nov
        expect(dueDate("2026-11-02T01:00:00Z")).toBe("2026-11-16");
        expect(addBusinessDays("2026-11-02T01:00:00Z", 1).toISOString().slice(0, 10)).toBe("2026-11-03");
    });
});

describe("the sign-off sheet and these tests match", () => {
    it("has exactly one test for every row of docs/uat-gold-04-rules.md", () => {
        // Paths are relative to app/, where Vitest runs.
        const sheet = readFileSync("../docs/uat-gold-04-rules.md", "utf8");
        const rows = [...sheet.matchAll(/^\| ([A-F]\d+) \|/gm)].map((m) => m[1]);
        const self = readFileSync("src/lib/goldRules.signoff.test.js", "utf8");
        const tests = [...self.matchAll(/it\("([A-F]\d+):/g)].map((m) => m[1]);
        expect(rows.length).toBeGreaterThan(0);
        expect(tests).toEqual(rows);
    });
});
