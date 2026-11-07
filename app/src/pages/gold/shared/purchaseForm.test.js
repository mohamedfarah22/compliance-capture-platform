import { describe, expect, it } from "vitest";
import {
    areCounterQuestionsShown,
    firstErrorFieldId,
    initialDraft,
    isPhoneChanged,
    savedNotice,
    toSaveRequest,
} from "./purchaseForm.js";

describe("initialDraft", () => {
    it("starts with the sighted box unticked and the customer's phone", () => {
        const draft = initialDraft({ phone: "0412 345 678" });

        expect(draft.idSighted).toBe(false);
        expect(draft.phone).toBe("0412 345 678");
        expect(draft).toMatchObject({ type: "scrap", photos: [], jointId: null, selfConducted: null });
    });
});

describe("isPhoneChanged", () => {
    it("compares digits only, and a blank form phone is not a change", () => {
        expect(isPhoneChanged("0412345678", "0412 345 678")).toBe(false);
        expect(isPhoneChanged("0499 111 222", "0412 345 678")).toBe(true);
        expect(isPhoneChanged("", "0412 345 678")).toBe(false);
    });
});

describe("areCounterQuestionsShown", () => {
    it("needs a reportable sale, one seller, and a customer with nothing missing", () => {
        const base = { isReportable: true, hasJoint: false, readiness: [] };

        expect(areCounterQuestionsShown(base)).toBe(true);
        expect(areCounterQuestionsShown({ ...base, isReportable: false })).toBe(false);
        expect(areCounterQuestionsShown({ ...base, hasJoint: true })).toBe(false);
        expect(areCounterQuestionsShown({ ...base, readiness: ["occupation"] })).toBe(false);
        expect(areCounterQuestionsShown({ ...base, readiness: null })).toBe(false);
        expect(areCounterQuestionsShown({ ...base, readiness: undefined })).toBe(false);
    });
});

describe("toSaveRequest", () => {
    const photo = { blob: new Blob(["j"], { type: "image/jpeg" }), preview: "data:" };
    const draft = {
        ...initialDraft({ phone: "0412 345 678" }),
        type: "bullion",
        bullionBand: "10k_plus",
        cashAmount: "12,000",
        erp_invoice_no: " INV-1 ",
        idSighted: true,
        jointId: "c2",
        selfConducted: true,
        detailsConfirmed: true,
        photos: [photo],
    };

    it("sends the form as the API names it, with the invoice trimmed and the photos as blobs", () => {
        const request = toSaveRequest({
            customerId: "c1",
            draft,
            cash: { linked: false },
            hasJoint: true,
            areQuestionsShown: false,
        });

        expect(request).toMatchObject({
            customerId: "c1",
            jointCustomerId: "c2",
            purchaseType: "bullion",
            bullionBand: "10k_plus",
            cashAmount: "12,000",
            erpInvoiceNo: "INV-1",
            idSighted: true,
            ttrSelfConducted: null,
            ttrDetailsConfirmed: null,
        });
        expect(request.photos).toEqual([photo.blob]);
    });

    it("sends the counter answers only when they were asked, and the part amounts only for a linked invoice", () => {
        const asked = toSaveRequest({
            customerId: "c1",
            draft: { ...draft, jointId: null, partAmount: "6000", linkedAmounts: { p0: "6000" } },
            cash: { linked: true },
            hasJoint: false,
            areQuestionsShown: true,
        });

        expect(asked).toMatchObject({
            jointCustomerId: null,
            ttrSelfConducted: true,
            ttrDetailsConfirmed: true,
            cashAmount: "",
            partAmount: "6000",
            linkedAmounts: { p0: "6000" },
        });
    });
});

describe("savedNotice", () => {
    it("says what happens next", () => {
        expect(savedNotice({ isReportable: true, hasInvoice: false })).toBe(
            "Purchase recorded as AUSTRAC pending. Add the invoice number from To complete."
        );
        expect(savedNotice({ isReportable: false, hasInvoice: false })).toBe(
            "Purchase recorded. Add the invoice number later from To complete."
        );
        expect(savedNotice({ isReportable: false, hasInvoice: true })).toBe("Purchase recorded");
        expect(savedNotice({ isReportable: true, hasInvoice: true, isAlreadyReported: true })).toMatch(
            /joins the AUSTRAC report already started/
        );
    });
});

describe("firstErrorFieldId", () => {
    it("points at the first field with a problem, top of the form first", () => {
        expect(firstErrorFieldId({ phone: "x", photos: "y" })).toBe("purchasePhone");
        expect(firstErrorFieldId({ cashAmount: "x" })).toBe("purchase-amount");
        expect(firstErrorFieldId({ linked_p1: "x", partAmount: "y" })).toBe("purchase-linked-p1");
        expect(firstErrorFieldId({ partAmount: "y" })).toBe("purchase-part");
        expect(firstErrorFieldId({ erp_invoice_no: "x" })).toBe("purchaseInvoice");
        expect(firstErrorFieldId({ photos: "x" })).toBe("purchasePhotos");
        expect(firstErrorFieldId({ idSighted: "x" })).toBe("purchaseSighted");
    });
});
