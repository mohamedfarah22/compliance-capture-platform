import { AUSTRAC_REPORT_BUSINESS_DAYS, businessDate, idStatus, validatePurchase } from "@gold-rules";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import FormField from "../../components/ui/FormField.jsx";
import TextInput from "../../components/ui/TextInput.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import {
    createTransaction,
    findInvoicePurchases,
    findSameDayInvoicePurchases,
    getCustomer,
    getCustomerIdImages,
    getCustomerNames,
    getTtrReadiness,
    goToAustracForm,
    listTransactions,
    phoneDigitCount,
    updateCustomerPhone,
} from "../../lib/goldApi.js";
import {
    CashQuestion,
    GOLD_ROUTES,
    GoodsPhotos,
    IdStatusBadge,
    JointSellerPanel,
    LinkedInvoice,
    Lightbox,
    PurchaseTags,
    Segmented,
    YesNo,
    formatDate,
    formatDateTime,
    goldPath,
    useGoldDraft,
} from "./shared/index.js";
import { DEV_FILL, sampleImage, sampleInvoice } from "./shared/devFill.js";
import {
    areCounterQuestionsShown,
    firstErrorFieldId,
    initialDraft,
    isPhoneChanged,
    savedNotice,
    toSaveRequest,
} from "./shared/purchaseForm.js";
import styles from "./GoldCustomerPage.module.css";

const NOTICE_MS = 4000;
const EMPTY_CONTEXT = { linked: [], sameInvoice: [] };
const PURCHASE_TYPE_OPTIONS = [
    ["scrap", "Scrap jewellery"],
    ["bullion", "Bullion"],
];

const formatAddress = (c) =>
    [c.res_street, [c.res_suburb, c.res_state, c.res_postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// The Record purchase form (spec 5.2, CustomerDetail row). The unsaved form lives in GoldDraftContext, keyed by the
// main seller, so it survives leaving the page (Update ID now, the joint seller's New customer, Purchases).
// customer is the loaded main seller. onRecorded(notice) runs after a save that stays on this page.
const PurchaseForm = ({ customer, onRecorded }) => {
    const navigate = useNavigate();
    const { reportingEntity } = useAuth();
    const { drafts, setDraft, clearDraft } = useGoldDraft();
    const addJointRef = useRef(null);
    const jointRowRef = useRef(null);
    const focusAfterRef = useRef(null); // "joint" | "add": where the focus goes once the joint seller changes

    const draft = { ...initialDraft(customer), ...drafts[customer.id] };
    const invoice = draft.erp_invoice_no.trim();

    const [jointLoaded, setJointLoaded] = useState(null); // the last joint seller loaded
    const [readiness, setReadiness] = useState(undefined); // customer_ttr_ready: missing fields, or null
    const [invoiceContext, setInvoiceContext] = useState({ invoice: "", linked: [], sameInvoice: [] });
    const [isPanelOpen, setIsPanelOpen] = useState(false);
    const [hasTried, setHasTried] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [serverErrors, setServerErrors] = useState({});
    const [submitError, setSubmitError] = useState("");
    const [zoom, setZoom] = useState(null);

    const change = (patch) => {
        setDraft(customer.id, patch);
        setServerErrors({});
    };

    useEffect(() => {
        if (!draft.jointId) return;
        let isCancelled = false;
        getCustomer(draft.jointId)
            .then((found) => !isCancelled && setJointLoaded(found))
            .catch(() => !isCancelled && setDraft(customer.id, { jointId: null }));
        return () => {
            isCancelled = true;
        };
    }, [draft.jointId, customer.id, setDraft]);

    useEffect(() => {
        let isCancelled = false;
        getTtrReadiness(customer.id).then((missing) => !isCancelled && setReadiness(missing));
        return () => {
            isCancelled = true;
        };
    }, [customer.id]);

    // The same-day invoice rule (spec 3.4) and the duplicate-invoice rule (3.3) both start from the invoice number.
    useEffect(() => {
        if (!invoice) return;
        let isCancelled = false;
        const timer = setTimeout(async () => {
            try {
                const [linked, sameInvoice] = await Promise.all([
                    findSameDayInvoicePurchases({ customerId: customer.id, invoice, date: businessDate() }),
                    findInvoicePurchases(invoice),
                ]);
                if (!isCancelled) setInvoiceContext({ invoice, linked, sameInvoice });
            } catch {
                // The server checks both rules again when the purchase is saved.
            }
        }, 300);
        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [invoice, customer.id]);

    useEffect(() => {
        if (focusAfterRef.current === "joint" && jointLoaded) jointRowRef.current?.focus();
        if (focusAfterRef.current === "add" && !draft.jointId) addJointRef.current?.focus();
        focusAfterRef.current = null;
    }, [jointLoaded, draft.jointId]);

    const jointCustomer = draft.jointId && jointLoaded?.id === draft.jointId ? jointLoaded : null;
    const isJointLoading = Boolean(draft.jointId) && !jointCustomer;
    const { linked, sameInvoice } = invoice && invoiceContext.invoice === invoice ? invoiceContext : EMPTY_CONTEXT;
    const hasJoint = Boolean(draft.jointId);

    const result = validatePurchase(draft, {
        mainCustomer: customer,
        jointCustomer,
        linked,
        sameInvoice,
        readiness,
        answers: { selfConducted: draft.selfConducted, detailsConfirmed: draft.detailsConfirmed },
        idvMaxRelianceDays: reportingEntity?.idv_max_reliance_days,
    });
    const { warnings, blocked, expired, reverify, cash, ttr } = result;
    const areQuestionsShown = areCounterQuestionsShown({ isReportable: cash.reportable, hasJoint, readiness });
    const errors = { ...result.errors };
    // Until both questions are answered the case is not known, so the invoice is not asked for yet.
    const isAwaitingAnswers = areQuestionsShown && (draft.selfConducted === null || draft.detailsConfirmed === null);
    if (isAwaitingAnswers) {
        errors.ttrAnswers = "Answer both questions.";
        if (!invoice) delete errors.erp_invoice_no;
    }
    const shown = { ...(hasTried ? errors : {}), ...serverErrors };
    const hasInvoice = Boolean(invoice);
    const isHandOff = cash.reportable && hasInvoice && !cash.alreadyReported;
    // Case A only starts the report (it stays in gold); case B opens it.
    const recordLabel = !isHandOff
        ? "Record purchase"
        : ttr.case === "A"
          ? "Record purchase and start AUSTRAC report"
          : "Record purchase and continue to AUSTRAC";
    // The main seller's re-verify notice is the banner above the form; only the joint seller's is added here.
    const jointReverify = reverify.filter((seller) => seller.role === "joint");
    const names = (rows) => rows.map(({ customer: c }) => c.full_name).join(" and ");

    const closePanel = () => {
        setIsPanelOpen(false);
        addJointRef.current?.focus();
    };
    const pickJoint = (picked) => {
        if (picked.id === customer.id) return;
        focusAfterRef.current = "joint";
        change({ jointId: picked.id });
        setIsPanelOpen(false);
    };
    const removeJoint = () => {
        focusAfterRef.current = "add";
        change({ jointId: null });
    };
    const updateIdOf = (customerId) =>
        navigate(goldPath(GOLD_ROUTES.updateId, { customerId }), { state: { returnTo: customer.id } });
    const addNewJoint = () => navigate(GOLD_ROUTES.newCustomer, { state: { jointFor: customer.id } });

    const viewJointId = async () => {
        const images = await getCustomerIdImages(jointCustomer.current_id);
        setZoom({
            images: [
                { src: images.front, alt: `${jointCustomer.full_name} — ID front` },
                { src: images.back, alt: `${jointCustomer.full_name} — ID back` },
            ],
        });
    };

    const fillWithTestData = async () => {
        const photos = [await sampleImage("Goods 1"), await sampleImage("Goods 2")];
        change({ erp_invoice_no: sampleInvoice(), photos, idSighted: true });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setHasTried(true);
        if (isJointLoading || blocked.length > 0) return;
        if (Object.keys(errors).length > 0) {
            document.getElementById(firstErrorFieldId(errors))?.focus();
            return;
        }
        setIsBusy(true);
        setSubmitError("");
        let saved;
        try {
            saved = await createTransaction(
                toSaveRequest({ customerId: customer.id, draft, cash, hasJoint, areQuestionsShown })
            );
        } catch (err) {
            setServerErrors(err.code === "validation_failed" ? (err.body.errors ?? {}) : {});
            setSubmitError(err.message);
            setIsBusy(false);
            return;
        }
        clearDraft(customer.id);
        setHasTried(false);
        // The purchase is saved first; a changed phone number then updates the customer record too.
        if (isPhoneChanged(draft.phone, customer.phone))
            await updateCustomerPhone(customer.id, draft.phone).catch(() => {});
        if (!isHandOff) {
            onRecorded(
                savedNotice({ isReportable: cash.reportable, hasInvoice, isAlreadyReported: cash.alreadyReported })
            );
            setIsBusy(false);
            return;
        }
        try {
            const { path } = await goToAustracForm(saved.purchaseId);
            // Case A started at the counter is finished later from To complete, so the wizard is not opened.
            if (saved.ttr === "A") {
                onRecorded("AUSTRAC report started. Finish it from To complete.");
                setIsBusy(false);
                return;
            }
            navigate(path);
        } catch (err) {
            onRecorded(
                `Purchase recorded, but the AUSTRAC report could not be started. ${err.message} Start it from To complete.`
            );
            setIsBusy(false);
        }
    };

    const renderJoint = () => {
        if (!draft.jointId) {
            return (
                <Button ref={addJointRef} variant="secondary" onClick={() => setIsPanelOpen(true)}>
                    Add second person (joint sale)
                </Button>
            );
        }
        if (!jointCustomer) return <p className={styles.jointLoading}>Loading second person…</p>;
        const jointId = jointCustomer.current_id;
        return (
            <div ref={jointRowRef} tabIndex={-1} className={styles.jointRow}>
                <p className={styles.jointRole}>Joint seller</p>
                <div className={styles.jointSummary}>
                    <div>
                        <p className={styles.jointName}>{jointCustomer.full_name}</p>
                        <p className={styles.jointId}>
                            {jointId?.document_type} {jointId?.document_number}
                        </p>
                    </div>
                    <IdStatusBadge currentId={jointId} />
                </div>
                <div className={styles.actions}>
                    <Button variant="secondary" onClick={viewJointId}>
                        View ID
                    </Button>
                    <Button variant="secondary" onClick={removeJoint}>
                        Remove
                    </Button>
                </div>
            </div>
        );
    };

    return (
        <>
            <form className={styles.card} onSubmit={handleSubmit} noValidate aria-labelledby="purchaseHeading">
                <div>
                    <h2 id="purchaseHeading" className={styles.sectionTitle}>
                        Record purchase
                    </h2>
                    <p className={styles.hint}>
                        Use the invoice number from the ERP so AUSTRAC reporting can match this purchase.
                    </p>
                </div>
                {DEV_FILL ? (
                    <Button variant="secondary" onClick={fillWithTestData}>
                        Fill with test data
                    </Button>
                ) : null}

                <div className={styles.group}>
                    <span id="purchaseTypeLabel" className={styles.groupLabel}>
                        What are you buying?
                    </span>
                    <Segmented
                        options={PURCHASE_TYPE_OPTIONS}
                        value={draft.type}
                        onChange={(type) => change({ type })}
                        labelledBy="purchaseTypeLabel"
                    />
                </div>

                <div className={styles.fieldRow}>
                    <FormField
                        label="ERP invoice number"
                        labelFor="purchaseInvoice"
                        helperText={
                            shown.erp_invoice_no ? undefined : "Optional now. You can add it later from To complete."
                        }
                        error={shown.erp_invoice_no || undefined}
                    >
                        <TextInput
                            id="purchaseInvoice"
                            placeholder="e.g. INV-10483"
                            autoComplete="off"
                            value={draft.erp_invoice_no}
                            aria-invalid={Boolean(shown.erp_invoice_no)}
                            onChange={(e) => change({ erp_invoice_no: e.target.value })}
                        />
                        {warnings.duplicateInvoice && !cash.linked ? (
                            <p className={styles.warning} role="status">
                                This invoice number is already recorded. Check it’s not a duplicate.
                            </p>
                        ) : null}
                    </FormField>
                    <FormField
                        label="Phone for this purchase"
                        labelFor="purchasePhone"
                        helperText={
                            isPhoneChanged(draft.phone, customer.phone)
                                ? "Different from the customer record. Saving the purchase also updates the customer’s phone number."
                                : "Pre-filled from the customer record."
                        }
                        error={shown.phone || undefined}
                    >
                        <TextInput
                            id="purchasePhone"
                            type="tel"
                            inputMode="tel"
                            value={draft.phone}
                            aria-invalid={Boolean(shown.phone)}
                            onChange={(e) => change({ phone: e.target.value })}
                        />
                    </FormField>
                </div>

                {cash.linked ? (
                    <LinkedInvoice
                        idPrefix="purchase"
                        invoice={invoice}
                        linked={linked}
                        partAmount={draft.partAmount}
                        linkedAmounts={draft.linkedAmounts}
                        cash={cash}
                        errors={shown}
                        onChange={change}
                    />
                ) : (
                    <CashQuestion
                        idPrefix="purchase"
                        type={draft.type}
                        cash10k={draft.cash10k}
                        bullionBand={draft.bullionBand}
                        cashAmount={draft.cashAmount}
                        onChange={change}
                        error={shown.cashAmount}
                    />
                )}

                <div id="purchasePhotos" tabIndex={-1} className={styles.photosField}>
                    <GoodsPhotos
                        label="Photos of items purchased (required)"
                        value={draft.photos}
                        onChange={(photos) => change({ photos })}
                        error={shown.photos}
                    />
                    <p className={styles.hint}>
                        Lay the items out together on a plain surface. Add as many photos as you need.
                    </p>
                </div>

                <div>
                    {renderJoint()}
                    {shown.joint ? (
                        <p className={styles.error} role="alert">
                            {shown.joint}
                        </p>
                    ) : null}
                </div>

                {areQuestionsShown ? (
                    <fieldset className={styles.questions}>
                        <legend className={styles.groupLabel}>Counter questions</legend>
                        <div className={styles.group}>
                            <span id="selfConductedLabel" className={styles.groupLabel}>
                                Is {customer.full_name} acting on their own behalf?
                            </span>
                            <YesNo
                                value={draft.selfConducted}
                                onChange={(value) => change({ selfConducted: value })}
                                labelledBy="selfConductedLabel"
                            />
                        </div>
                        <div className={styles.group}>
                            <span id="confirmedLabel" className={styles.groupLabel}>
                                Are these details still correct?
                            </span>
                            <dl className={styles.onFile}>
                                <div>
                                    <dt>Residential address</dt>
                                    <dd>{formatAddress(customer) || "—"}</dd>
                                </div>
                                <div>
                                    <dt>Occupation</dt>
                                    <dd>{customer.occupation || "—"}</dd>
                                </div>
                                <div>
                                    <dt>Citizenship</dt>
                                    <dd>{customer.citizenship_country_code || "—"}</dd>
                                </div>
                                <div>
                                    <dt>Tax residency</dt>
                                    <dd>{customer.tax_residency_country_code || "—"}</dd>
                                </div>
                            </dl>
                            <YesNo
                                value={draft.detailsConfirmed}
                                onChange={(value) => change({ detailsConfirmed: value })}
                                labelledBy="confirmedLabel"
                            />
                        </div>
                        {shown.ttrAnswers || shown.ttrSelfConducted || shown.ttrDetailsConfirmed ? (
                            <p className={styles.error} role="alert">
                                {shown.ttrAnswers || shown.ttrSelfConducted || shown.ttrDetailsConfirmed}
                            </p>
                        ) : null}
                    </fieldset>
                ) : null}

                <div>
                    <label className={styles.sighted}>
                        <input
                            id="purchaseSighted"
                            type="checkbox"
                            checked={draft.idSighted}
                            aria-invalid={Boolean(shown.idSighted)}
                            onChange={(e) => change({ idSighted: e.target.checked })}
                        />
                        <span>
                            <span className={styles.sightedTitle}>
                                {hasJoint
                                    ? "Both people and their IDs sighted in person today"
                                    : "Customer and ID sighted in person today"}
                            </span>
                            <span className={styles.hint}>Recorded against your login with today’s date and time.</span>
                            <span className={styles.hint}>{"Doesn't match the record? Update ID first."}</span>
                        </span>
                    </label>
                    {shown.idSighted ? (
                        <p className={styles.error} role="alert">
                            {shown.idSighted}
                        </p>
                    ) : null}
                </div>

                {blocked.length > 0 ? (
                    <div className={`${styles.banner} ${styles.bannerBlocking}`} role="alert">
                        <p className={styles.bannerTitle}>
                            {cash.reportable
                                ? "Update the ID before recording this cash purchase. An expired ID cannot go into an AUSTRAC report."
                                : "Update the ID before recording this purchase. Bullion bought with $5,000 or more in cash needs a current ID."}
                        </p>
                        <ul className={styles.blockedList}>
                            {blocked.map(({ customer: seller, role, status }) => (
                                <li key={seller.id}>
                                    <span>
                                        <strong>{seller.full_name}</strong> (
                                        {role === "main" ? "main seller" : "joint seller"}):{" "}
                                        {status === "expired"
                                            ? `ID expired on ${formatDate(seller.current_id.expiry_date)}`
                                            : `ID photographed on ${formatDate(seller.current_id.captured_at)}, more than ${reportingEntity?.idv_max_reliance_days} days ago`}
                                    </span>
                                    <Button onClick={() => updateIdOf(seller.id)}>Update ID now</Button>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}
                {cash.reportable && !cash.alreadyReported && blocked.length === 0 ? (
                    <div className={`${styles.banner} ${styles.bannerAttention}`} role="status">
                        <p>
                            {hasInvoice && ttr.case === "A"
                                ? "After you record this purchase, the AUSTRAC report will be started. Finish it from To complete."
                                : hasInvoice
                                  ? `After you record this purchase, the AUSTRAC form will open with ${hasJoint ? "these customers" : "this customer"} loaded.`
                                  : ttr.invoiceRequired && !isAwaitingAnswers
                                    ? "This sale needs the ERP invoice number now. The AUSTRAC form opens straight after you record it."
                                    : `No invoice number yet, so this purchase will be saved as AUSTRAC pending. Add the invoice number within ${AUSTRAC_REPORT_BUSINESS_DAYS} business days from To complete.`}
                        </p>
                    </div>
                ) : null}
                {blocked.length === 0 && expired.length > 0 ? (
                    <p className={styles.error}>
                        ID on file has expired for {names(expired)}. This purchase will be saved with an expired-ID
                        flag.
                    </p>
                ) : null}
                {blocked.length === 0 && jointReverify.length > 0 ? (
                    <div className={`${styles.banner} ${styles.bannerAttention}`} role="status">
                        <p className={styles.bannerTitle}>{names(jointReverify)}’s ID needs re-verifying</p>
                        <p>
                            It was photographed more than {reportingEntity?.idv_max_reliance_days} days ago. Update it
                            before a purchase that needs a current ID.
                        </p>
                    </div>
                ) : null}
                {submitError ? (
                    <p className={styles.error} role="alert">
                        {submitError}
                    </p>
                ) : null}

                <Button type="submit" disabled={isBusy || isJointLoading || blocked.length > 0}>
                    {isBusy ? "Saving…" : recordLabel}
                </Button>
            </form>

            {isPanelOpen ? (
                <JointSellerPanel mainCustomer={customer} onPick={pickJoint} onNew={addNewJoint} onClose={closePanel} />
            ) : null}
            {zoom ? <Lightbox {...zoom} onClose={() => setZoom(null)} /> : null}
        </>
    );
};

// Every purchase where this customer is the main or joint seller, newest first. version changes after a save, to
// load the list again.
const PurchaseHistory = ({ customerId, version }) => {
    // The last list loaded: { key, purchases, names }. It is stale when its key is not the current one.
    const [loaded, setLoaded] = useState(null);
    const key = `${customerId}:${version}`;

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            try {
                const purchases = await listTransactions(customerId);
                const others = purchases.map((p) =>
                    p.customer_id === customerId ? p.joint_customer_id : p.customer_id
                );
                const names = await getCustomerNames(others);
                if (!isCancelled) setLoaded({ key, purchases, names });
            } catch {
                if (!isCancelled) setLoaded({ key, purchases: [], names: {}, hasFailed: true });
            }
        };
        load();
        return () => {
            isCancelled = true;
        };
    }, [customerId, key]);

    const renderBody = () => {
        if (loaded?.key !== key) return <p className={styles.hint}>Loading…</p>;
        if (loaded.hasFailed) return <p className={styles.error}>Could not load the purchases. Try again.</p>;
        if (loaded.purchases.length === 0) {
            return <p className={styles.hint}>No purchases recorded for this customer yet.</p>;
        }
        return (
            <ul className={styles.history}>
                {loaded.purchases.map((purchase) => {
                    const otherId =
                        purchase.customer_id === customerId ? purchase.joint_customer_id : purchase.customer_id;
                    return (
                        <li key={purchase.id} className={styles.historyRow}>
                            <p className={styles.historyTitle}>
                                <Link
                                    to={goldPath(GOLD_ROUTES.purchase, { purchaseId: purchase.id })}
                                    aria-label={`View purchase ${purchase.erp_invoice_no || "with no invoice number"}`}
                                >
                                    {purchase.erp_invoice_no || "No invoice number yet"}
                                </Link>
                                <PurchaseTags purchase={purchase} />
                            </p>
                            <p className={styles.hint}>
                                {formatDateTime(purchase.created_at)} | {purchase.photo_count} photo
                                {purchase.photo_count === 1 ? "" : "s"}
                            </p>
                            {otherId ? (
                                <p className={styles.hint}>
                                    Joint sale with{" "}
                                    <Link to={goldPath(GOLD_ROUTES.customer, { customerId: otherId })}>
                                        {loaded.names[otherId] || "another customer"}
                                    </Link>
                                </p>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        );
    };

    return (
        <section className={styles.card} aria-labelledby="historyHeading">
            <h2 id="historyHeading" className={styles.sectionTitle}>
                Purchase history
            </h2>
            {renderBody()}
        </section>
    );
};

const GoldCustomerPage = () => {
    const { customerId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { staffMember, reportingEntity } = useAuth();
    const { setDraft } = useGoldDraft();
    const refreshToComplete = useOutletContext()?.refreshToComplete;
    const changePhoneRef = useRef(null);
    const wasEditingPhoneRef = useRef(false);

    // The last customer loaded: { id, customer, images }. customer is null when that id was not found.
    const [loaded, setLoaded] = useState(null);
    const [zoom, setZoom] = useState(null);
    const [notice, setNotice] = useState(location.state?.notice ?? "");
    const [isEditingPhone, setIsEditingPhone] = useState(false);
    const [phoneValue, setPhoneValue] = useState("");
    const [phoneError, setPhoneError] = useState("");
    const [isPhoneBusy, setIsPhoneBusy] = useState(false);
    // Changes after a purchase is recorded, to load the customer and the history again.
    const [savedCount, setSavedCount] = useState(0);

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            try {
                const found = await getCustomer(customerId);
                if (isCancelled) return;
                setLoaded({ id: customerId, customer: found, images: { front: null, back: null } });
                const images = await getCustomerIdImages(found.current_id);
                if (!isCancelled) setLoaded((prev) => ({ ...prev, images }));
            } catch {
                if (!isCancelled) setLoaded({ id: customerId, customer: null });
            }
        };
        load();
        return () => {
            isCancelled = true;
        };
    }, [customerId, savedCount]);

    // A notice from the screen that sent us here ("Customer created") shows once: it is cleared from the history
    // entry, so a reload does not show it again. The same goes for the joint seller just created for this sale.
    useEffect(() => {
        if (!location.state?.notice && !location.state?.jointId) return;
        if (location.state.jointId) setDraft(customerId, { jointId: location.state.jointId });
        navigate(location.pathname, { replace: true, state: null });
    }, [location.state, location.pathname, customerId, setDraft, navigate]);

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(""), NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);

    // When the phone editor closes, the Change button is back in the DOM: put the focus on it. Not on first mount.
    useEffect(() => {
        if (wasEditingPhoneRef.current && !isEditingPhone) changePhoneRef.current?.focus();
        wasEditingPhoneRef.current = isEditingPhone;
    }, [isEditingPhone]);

    if (loaded?.id !== customerId) return <p className={styles.message}>Loading…</p>;
    const { customer, images } = loaded;
    if (!customer) {
        return (
            <p className={styles.message}>
                Customer not found. <Link to={GOLD_ROUTES.search}>Back to Find customer</Link>
            </p>
        );
    }

    const currentId = customer.current_id;
    const status = currentId ? idStatus(currentId, reportingEntity?.idv_max_reliance_days) : "none";
    const canEdit = ["manager", "admin"].includes(staffMember?.role);
    const updateIdRoute = goldPath(GOLD_ROUTES.updateId, { customerId });
    const hasIdBanner = ["expired", "reverify", "none"].includes(status);

    const closePhoneEditor = () => {
        setIsEditingPhone(false);
        setPhoneError("");
    };

    const handleSavePhone = async () => {
        if (phoneDigitCount(phoneValue) < 8) {
            setPhoneError("Phone number looks too short.");
            return;
        }
        setIsPhoneBusy(true);
        try {
            await updateCustomerPhone(customerId, phoneValue);
            setLoaded((prev) => ({ ...prev, customer: { ...prev.customer, phone: phoneValue.trim() } }));
            setNotice("Phone number updated");
            closePhoneEditor();
        } catch (err) {
            setPhoneError(err.message);
        } finally {
            setIsPhoneBusy(false);
        }
    };

    const handlePhoneEnter = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        handleSavePhone();
    };

    const renderBanner = () => {
        if (status === "none") {
            return (
                <div className={`${styles.banner} ${styles.bannerBlocking}`}>
                    <p className={styles.bannerTitle}>No ID on file</p>
                    <p>Capture the customer’s ID before recording a purchase.</p>
                    <Button onClick={() => navigate(updateIdRoute)}>Add ID</Button>
                </div>
            );
        }
        if (status === "expired") {
            return (
                <div className={`${styles.banner} ${styles.bannerBlocking}`}>
                    <p className={styles.bannerTitle}>ID expired on {formatDate(currentId.expiry_date)}</p>
                    <p>Capture the customer’s current ID before recording a purchase.</p>
                    <Button onClick={() => navigate(updateIdRoute)}>Update ID now</Button>
                </div>
            );
        }
        if (status === "reverify") {
            return (
                <div className={`${styles.banner} ${styles.bannerAttention}`}>
                    <p className={styles.bannerTitle}>ID needs re-verifying</p>
                    <p>
                        This ID was photographed on {formatDate(currentId.captured_at)}, more than{" "}
                        {reportingEntity?.idv_max_reliance_days} days ago. Update it before a purchase that needs a
                        current ID.
                    </p>
                    <Button onClick={() => navigate(updateIdRoute)}>Update ID now</Button>
                </div>
            );
        }
        if (status === "expiring") {
            return (
                <div className={`${styles.banner} ${styles.bannerAttention}`}>
                    <p>ID expires soon. Ask whether the customer has a renewed ID with them today.</p>
                </div>
            );
        }
        return null;
    };

    const renderPhoto = (label, src, id) => {
        if (!src) {
            return (
                <div>
                    <span className={styles.photoLabel}>{label}</span>
                    <span className={styles.photoEmpty}>{id ? "Photo unavailable" : "Not on file"}</span>
                </div>
            );
        }
        return (
            <button type="button" className={styles.photo} onClick={() => setZoom({ src, alt: label })}>
                <span className={styles.photoLabel}>{label}</span>
                <img src={src} alt={label} className={styles.photoImage} />
            </button>
        );
    };

    return (
        <div className={styles.layout}>
            {notice ? (
                <p className={styles.toast} role="status">
                    {notice}
                </p>
            ) : null}

            <section className={styles.card}>
                <Link className={styles.back} to={GOLD_ROUTES.search}>
                    Back to search
                </Link>
                <div className={styles.heading}>
                    <h1 className={styles.title}>{customer.full_name}</h1>
                    <IdStatusBadge currentId={currentId} />
                </div>
                {customer.aliases.length > 0 ? (
                    <p className={styles.aliases}>Also known as {customer.aliases.join(", ")}</p>
                ) : null}

                {renderBanner()}

                <dl className={styles.details}>
                    {isEditingPhone ? (
                        <div className={styles.wide}>
                            <dt>
                                <label htmlFor="customerPhone">Phone</label>
                            </dt>
                            {/* Escape closes the editor from the field or either button; Enter saves from the field. */}
                            <dd
                                className={styles.phoneEditor}
                                onKeyDown={(e) => e.key === "Escape" && closePhoneEditor()}
                            >
                                <TextInput
                                    id="customerPhone"
                                    type="tel"
                                    inputMode="tel"
                                    autoFocus
                                    value={phoneValue}
                                    aria-invalid={Boolean(phoneError)}
                                    onChange={(e) => {
                                        setPhoneValue(e.target.value);
                                        setPhoneError("");
                                    }}
                                    onKeyDown={handlePhoneEnter}
                                />
                                <Button onClick={handleSavePhone} disabled={isPhoneBusy}>
                                    {isPhoneBusy ? "Saving…" : "Save"}
                                </Button>
                                <Button variant="secondary" onClick={closePhoneEditor}>
                                    Cancel
                                </Button>
                            </dd>
                            {phoneError ? (
                                <p className={styles.error} role="alert">
                                    {phoneError}
                                </p>
                            ) : null}
                        </div>
                    ) : (
                        <div>
                            <dt>Phone</dt>
                            <dd>
                                {customer.phone}{" "}
                                <button
                                    ref={changePhoneRef}
                                    type="button"
                                    className={styles.linkButton}
                                    onClick={() => {
                                        setPhoneValue(customer.phone ?? "");
                                        setIsEditingPhone(true);
                                    }}
                                >
                                    Change
                                </button>
                            </dd>
                        </div>
                    )}
                    <div>
                        <dt>Date of birth</dt>
                        <dd>{formatDate(customer.date_of_birth)}</dd>
                    </div>
                    <div className={styles.wide}>
                        <dt>Address</dt>
                        <dd>{formatAddress(customer) || "—"}</dd>
                    </div>
                    <div>
                        <dt>ID type</dt>
                        <dd>{currentId?.document_type ?? "—"}</dd>
                    </div>
                    <div>
                        <dt>ID number</dt>
                        <dd>{currentId?.document_number ?? "—"}</dd>
                    </div>
                    <div>
                        <dt>Issuer</dt>
                        <dd>{currentId?.issuer || "—"}</dd>
                    </div>
                    <div>
                        <dt>Expiry</dt>
                        <dd>
                            {currentId ? (currentId.has_expiry ? formatDate(currentId.expiry_date) : "No expiry") : "—"}
                        </dd>
                    </div>
                    <div>
                        <dt>Customer since</dt>
                        <dd>{formatDate(customer.created_at)}</dd>
                    </div>
                    <div>
                        <dt>ID last updated</dt>
                        <dd>{currentId ? formatDate(currentId.captured_at) : "—"}</dd>
                    </div>
                    {currentId?.captured_by_name ? (
                        <div>
                            <dt>ID captured by</dt>
                            <dd>{currentId.captured_by_name}</dd>
                        </div>
                    ) : null}
                </dl>

                {currentId ? (
                    <div className={styles.photos}>
                        {renderPhoto("ID front", images.front, currentId.front_image_id)}
                        {renderPhoto("ID back", images.back, currentId.back_image_id)}
                    </div>
                ) : null}

                <div className={styles.actions}>
                    {hasIdBanner ? null : (
                        <Button variant="secondary" onClick={() => navigate(updateIdRoute)}>
                            Update ID
                        </Button>
                    )}
                    {canEdit ? (
                        <Button
                            variant="secondary"
                            onClick={() => navigate(goldPath(GOLD_ROUTES.editCustomer, { customerId }))}
                        >
                            Edit details
                        </Button>
                    ) : null}
                </div>
            </section>

            <div className={styles.column}>
                {currentId ? (
                    <PurchaseForm
                        customer={customer}
                        onRecorded={(message) => {
                            setNotice(message);
                            setSavedCount((count) => count + 1);
                            refreshToComplete?.();
                        }}
                    />
                ) : (
                    <section className={styles.card} aria-labelledby="purchaseHeading">
                        <h2 id="purchaseHeading" className={styles.sectionTitle}>
                            Record purchase
                        </h2>
                        <p className={styles.hint}>Add the customer’s ID before recording a purchase.</p>
                    </section>
                )}
                <PurchaseHistory customerId={customerId} version={savedCount} />
            </div>

            {zoom ? <Lightbox {...zoom} onClose={() => setZoom(null)} /> : null}
        </div>
    );
};

export default GoldCustomerPage;
