import { bandLabel, typeLabel, validateCompletion } from "@gold-rules";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import FormField from "../../components/ui/FormField.jsx";
import TextInput from "../../components/ui/TextInput.jsx";
import {
    findInvoicePurchases,
    findSameDayInvoicePurchases,
    getCustomer,
    getGoldPhotoUrls,
    getPurchaseStaffNames,
    getTransaction,
    getTtrReadiness,
    goToAustracForm,
    updateTransaction,
} from "../../lib/goldApi.js";
import {
    DueLine,
    GOLD_ROUTES,
    IdStatusBadge,
    Lightbox,
    LinkedInvoice,
    PurchaseTags,
    formatAud,
    formatDateTime,
    goldPath,
} from "./shared/index.js";
import styles from "./GoldCompletePurchasePage.module.css";

const EMPTY_CONTEXT = { linked: [], sameInvoice: [] };

// Finish a purchase that was saved without an ERP invoice number (spec 5.2, CompletePurchase row). The sellers,
// capture time and ID flags are read only. A reportable purchase starts its TTR when the invoice is added, and
// the TTR opens (spec 3.3).
const GoldCompletePurchasePage = () => {
    const { purchaseId } = useParams();
    const navigate = useNavigate();

    // The last purchase loaded: { id, purchase, main, joint, photos, staff, readiness } or { id, message }.
    const [loaded, setLoaded] = useState(null);
    const [invoice, setInvoice] = useState("");
    const [partAmount, setPartAmount] = useState("");
    const [linkedAmounts, setLinkedAmounts] = useState({});
    const [invoiceContext, setInvoiceContext] = useState({ invoice: "", linked: [], sameInvoice: [] });
    const [hasTried, setHasTried] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [serverErrors, setServerErrors] = useState({});
    const [submitError, setSubmitError] = useState("");
    const [zoom, setZoom] = useState(null);

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            try {
                const purchase = await getTransaction(purchaseId);
                const [main, joint, photos, staff, readiness] = await Promise.all([
                    getCustomer(purchase.customer_id),
                    purchase.joint_customer_id ? getCustomer(purchase.joint_customer_id) : null,
                    getGoldPhotoUrls(purchaseId).catch(() => []),
                    getPurchaseStaffNames().catch(() => ({})),
                    getTtrReadiness(purchase.customer_id),
                ]);
                if (!isCancelled) setLoaded({ id: purchaseId, purchase, main, joint, photos, staff, readiness });
            } catch (err) {
                const message = err.code === "purchase_not_found" ? "Purchase not found." : err.message;
                if (!isCancelled) setLoaded({ id: purchaseId, message });
            }
        };
        load();
        return () => {
            isCancelled = true;
        };
    }, [purchaseId]);

    const purchase = loaded?.purchase;
    const trimmedInvoice = invoice.trim();

    // The same-day invoice rule (spec 3.4) and the duplicate-invoice rule (3.3) both start from the invoice number.
    useEffect(() => {
        if (!purchase || !trimmedInvoice) return;
        let isCancelled = false;
        const timer = setTimeout(async () => {
            try {
                const [linked, sameInvoice] = await Promise.all([
                    findSameDayInvoicePurchases({
                        customerId: purchase.customer_id,
                        invoice: trimmedInvoice,
                        date: purchase.sale_date,
                        excludeId: purchase.id,
                    }),
                    findInvoicePurchases(trimmedInvoice, purchase.id),
                ]);
                if (!isCancelled) setInvoiceContext({ invoice: trimmedInvoice, linked, sameInvoice });
            } catch {
                // The server checks both rules again when the invoice is saved.
            }
        }, 300);
        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [purchase, trimmedInvoice]);

    if (loaded?.id !== purchaseId) return <p className={styles.message}>Loading…</p>;
    if (loaded.message) {
        return (
            <section className={styles.card}>
                <p className={styles.error}>{loaded.message}</p>
                <Link to={GOLD_ROUTES.toComplete}>Back to To complete</Link>
            </section>
        );
    }

    const { main, joint, photos, staff, readiness } = loaded;
    const recordedBy = staff[purchase.created_by_staff_id];
    const sellers = [{ customer: main, role: "main" }, ...(joint ? [{ customer: joint, role: "joint" }] : [])];
    const tagged = { ...purchase, ttr_status: purchase.ttr?.status ?? null };

    if (purchase.erp_invoice_no) {
        return (
            <section className={styles.card}>
                <h1 className={styles.title}>Purchase already completed</h1>
                <p className={styles.hint}>
                    Invoice {purchase.erp_invoice_no}
                    {purchase.completed_at ? `, completed ${formatDateTime(purchase.completed_at)}` : ""}
                    {staff[purchase.completed_by_staff_id] ? ` by ${staff[purchase.completed_by_staff_id]}` : ""}.
                </p>
                <div className={styles.actions}>
                    <Button variant="secondary" onClick={() => navigate(GOLD_ROUTES.toComplete)}>
                        Back
                    </Button>
                </div>
            </section>
        );
    }

    // The saved answers stand in for the cash questions, the same way the server reads them.
    const hasSavedAmount = purchase.cash_amount != null;
    const cashDraft = {
        type: purchase.purchase_type,
        cash10k: purchase.cash_band === "10k_plus",
        bullionBand: purchase.cash_band,
        cashAmount: hasSavedAmount ? String(purchase.cash_amount) : "",
        partAmount: hasSavedAmount ? String(purchase.cash_amount) : partAmount,
        linkedAmounts,
    };
    const { linked, sameInvoice } =
        trimmedInvoice && invoiceContext.invoice === trimmedInvoice ? invoiceContext : EMPTY_CONTEXT;
    const result = validateCompletion({ erp_invoice_no: invoice, ...cashDraft }, purchase, {
        mainCustomer: main,
        readiness,
        linked,
        sameInvoice,
    });
    const { warnings, blocked, cash } = result;
    const shown = { ...(hasTried ? result.errors : {}), ...serverErrors };
    const isHandOff = cash.reportable && !cash.alreadyReported;
    // Reportable only because of this invoice, and the customer was never asked the counter questions (spec 3.3).
    const isUnconfirmed =
        cash.reportable &&
        !purchase.cash_10k_or_more &&
        purchase.ttr_self_conducted === null &&
        purchase.ttr_details_confirmed === null;

    const change = (patch) => {
        if ("partAmount" in patch) setPartAmount(patch.partAmount);
        if ("linkedAmounts" in patch) setLinkedAmounts(patch.linkedAmounts);
        setServerErrors({});
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setHasTried(true);
        if (blocked) return;
        const found = result.errors;
        if (Object.keys(found).length > 0) {
            const linkedKey = Object.keys(found).find((key) => key.startsWith("linked_"));
            const fieldId = found.erp_invoice_no
                ? "completeInvoice"
                : found.cashAmount
                  ? "complete-amount"
                  : linkedKey
                    ? `complete-linked-${linkedKey.slice("linked_".length)}`
                    : "complete-part";
            document.getElementById(fieldId)?.focus();
            return;
        }
        setIsBusy(true);
        setSubmitError("");
        let saved;
        try {
            saved = await updateTransaction(purchaseId, {
                erpInvoiceNo: trimmedInvoice,
                partAmount: cash.linked && !hasSavedAmount ? partAmount : undefined,
                linkedAmounts: cash.linked ? linkedAmounts : {},
            });
        } catch (err) {
            setServerErrors(err.code === "validation_failed" ? (err.body.errors ?? {}) : {});
            setSubmitError(err.message);
            setIsBusy(false);
            return;
        }
        if (saved.ttr && isHandOff) {
            try {
                const { path } = await goToAustracForm(purchaseId);
                navigate(path);
                return;
            } catch (err) {
                navigate(GOLD_ROUTES.toComplete, {
                    state: {
                        notice: `Purchase completed, but the AUSTRAC report could not be started. ${err.message}`,
                    },
                });
                return;
            }
        }
        navigate(GOLD_ROUTES.toComplete, {
            state: {
                notice: cash.alreadyReported
                    ? "Purchase completed. It joins the AUSTRAC report already started for this invoice."
                    : "Purchase completed",
            },
        });
    };

    return (
        <form className={styles.card} onSubmit={handleSubmit} noValidate>
            <Link className={styles.back} to={GOLD_ROUTES.toComplete}>
                Back to To complete
            </Link>
            <div className={styles.heading}>
                <h1 className={styles.title}>Complete purchase</h1>
                <PurchaseTags purchase={tagged} />
            </div>
            <p className={styles.hint}>
                {typeLabel(purchase.purchase_type)}, recorded {formatDateTime(purchase.created_at)}
                {recordedBy ? ` by ${recordedBy}` : ""}. Add the ERP invoice number to complete it.
            </p>
            {cash.reportable || purchase.cash_10k_or_more ? <DueLine purchase={purchase} /> : null}

            <ul className={styles.sellers}>
                {sellers.map(({ customer, role }) => (
                    <li key={customer.id} className={styles.seller}>
                        <span>
                            <span className={styles.role}>{role === "main" ? "Main seller" : "Joint seller"}</span>
                            <Link to={goldPath(GOLD_ROUTES.customer, { customerId: customer.id })}>
                                {customer.full_name}
                            </Link>
                            <span className={styles.hint}>
                                {customer.current_id?.document_type} {customer.current_id?.document_number}
                            </span>
                        </span>
                        <IdStatusBadge currentId={customer.current_id} />
                    </li>
                ))}
            </ul>
            {purchase.id_expired_at_time ? (
                <p className={styles.error}>An ID on file had expired when this purchase was recorded.</p>
            ) : null}

            <div className={styles.photos}>
                <span className={styles.label}>Photos taken at the counter</span>
                <ul className={styles.photoList}>
                    {photos.map((photo, index) => (
                        <li key={photo.id}>
                            <button
                                type="button"
                                className={styles.photoButton}
                                onClick={() => setZoom({ src: photo.url, alt: `Goods photo ${index + 1}` })}
                            >
                                <img src={photo.url} alt={`Goods photo ${index + 1}`} className={styles.photo} />
                            </button>
                        </li>
                    ))}
                </ul>
            </div>

            <FormField
                label="ERP invoice number"
                labelFor="completeInvoice"
                helperText={shown.erp_invoice_no ? undefined : "Required to complete the purchase."}
                error={shown.erp_invoice_no || undefined}
            >
                <TextInput
                    id="completeInvoice"
                    placeholder="e.g. INV-10483"
                    autoComplete="off"
                    value={invoice}
                    aria-invalid={Boolean(shown.erp_invoice_no)}
                    onChange={(e) => {
                        setInvoice(e.target.value);
                        setServerErrors({});
                    }}
                />
                {warnings.duplicateInvoice && !cash.linked ? (
                    <p className={styles.warning} role="status">
                        This invoice number is already recorded. Check it’s not a duplicate.
                    </p>
                ) : null}
            </FormField>

            {cash.linked ? (
                <LinkedInvoice
                    idPrefix="complete"
                    invoice={invoice}
                    linked={linked}
                    partAmount={cashDraft.partAmount}
                    linkedAmounts={linkedAmounts}
                    cash={cash}
                    errors={shown}
                    isPartFixed={hasSavedAmount}
                    onChange={change}
                />
            ) : (
                <div className={styles.cash}>
                    <p className={styles.hint}>
                        Cash paid: {bandLabel(purchase.cash_band)}
                        {hasSavedAmount ? ` (${formatAud(purchase.cash_amount)})` : ""}
                    </p>
                    {shown.cashAmount ? <p className={styles.error}>{shown.cashAmount}</p> : null}
                </div>
            )}

            {blocked ? (
                <div className={`${styles.banner} ${styles.bannerBlocking}`} role="alert">
                    <p className={styles.bannerTitle}>This purchase can’t go into an AUSTRAC report.</p>
                    <p>
                        An ID had expired or was out of date when it was recorded. Talk to your compliance officer about
                        how to report it.
                    </p>
                </div>
            ) : null}
            {isUnconfirmed && !blocked ? (
                <div className={`${styles.banner} ${styles.bannerAttention}`} role="status">
                    <p>
                        The customer wasn’t asked to confirm their details at the counter. Contact them to confirm
                        before completing the TTR.
                    </p>
                </div>
            ) : null}
            {isHandOff && !blocked ? (
                <div className={`${styles.banner} ${styles.bannerAttention}`} role="status">
                    <p>
                        After you save, the AUSTRAC form will open with{" "}
                        {sellers.length > 1 ? "these customers" : "this customer"} loaded.
                    </p>
                </div>
            ) : null}
            {submitError ? (
                <p className={styles.error} role="alert">
                    {submitError}
                </p>
            ) : null}

            <div className={styles.actions}>
                <Button variant="secondary" onClick={() => navigate(GOLD_ROUTES.toComplete)}>
                    Cancel
                </Button>
                <Button type="submit" disabled={isBusy || blocked}>
                    {isBusy ? "Saving…" : isHandOff ? "Save and continue to AUSTRAC" : "Save and complete"}
                </Button>
            </div>

            {zoom ? <Lightbox {...zoom} onClose={() => setZoom(null)} /> : null}
        </form>
    );
};

export default GoldCompletePurchasePage;
