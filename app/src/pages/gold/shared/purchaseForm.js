import { claimsCash10k } from "@gold-rules";

// The logic behind the purchase form on GoldCustomerPage, kept out of the component so it can be tested alone.

/** A fresh purchase form for a customer. The sighted box starts unticked (spec C3). */
export const initialDraft = (customer) => ({
    type: "scrap",
    cash10k: false,
    bullionBand: "under_5k",
    cashAmount: "",
    partAmount: "",
    linkedAmounts: {},
    erp_invoice_no: "",
    phone: customer.phone ?? "",
    photos: [],
    jointId: null,
    idSighted: false,
    selfConducted: null,
    detailsConfirmed: null,
});

const digits = (phone) => (phone ?? "").replace(/\D/g, "");

/** True when the phone on the form is a real number that differs from the customer's. */
export const isPhoneChanged = (formPhone, customerPhone) =>
    digits(formPhone).length > 0 && digits(formPhone) !== digits(customerPhone);

/** The two counter questions (spec 3.3a) are shown for a reportable sale with one seller who is ready for case A. */
export const areCounterQuestionsShown = ({ isReportable, hasJoint, readiness }) =>
    isReportable && !hasJoint && Array.isArray(readiness) && readiness.length === 0;

/** The form as the `createTransaction` request. The server works out everything else again. */
export const toSaveRequest = ({ customerId, draft, cash, hasJoint, areQuestionsShown }) => ({
    customerId,
    jointCustomerId: hasJoint ? draft.jointId : null,
    purchaseType: draft.type,
    cash10k: draft.cash10k,
    bullionBand: draft.bullionBand,
    cashAmount: claimsCash10k(draft) && !cash.linked ? draft.cashAmount : "",
    partAmount: cash.linked ? draft.partAmount : "",
    linkedAmounts: cash.linked ? draft.linkedAmounts : {},
    phone: draft.phone,
    idSighted: draft.idSighted,
    erpInvoiceNo: draft.erp_invoice_no.trim(),
    ttrSelfConducted: areQuestionsShown ? draft.selfConducted : null,
    ttrDetailsConfirmed: areQuestionsShown ? draft.detailsConfirmed : null,
    photos: draft.photos.map((photo) => photo.blob),
});

/** The toast after a purchase is saved and no report is started from here. */
export const savedNotice = ({ isReportable, hasInvoice, isAlreadyReported }) => {
    if (isAlreadyReported) return "Purchase recorded. It joins the AUSTRAC report already started for this invoice.";
    if (isReportable && !hasInvoice) {
        return "Purchase recorded as AUSTRAC pending. Add the invoice number from To complete.";
    }
    return hasInvoice ? "Purchase recorded" : "Purchase recorded. Add the invoice number later from To complete.";
};

/** The id of the first field with an error, so the form can put the focus there. */
export const firstErrorFieldId = (errors) => {
    const linkedKey = Object.keys(errors).find((key) => key.startsWith("linked_"));
    if (errors.phone) return "purchasePhone";
    if (errors.cashAmount) return "purchase-amount";
    if (linkedKey) return `purchase-linked-${linkedKey.slice("linked_".length)}`;
    if (errors.partAmount) return "purchase-part";
    if (errors.erp_invoice_no) return "purchaseInvoice";
    if (errors.photos) return "purchasePhotos";
    return "purchaseSighted";
};
