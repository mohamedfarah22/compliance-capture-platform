import { CASH_REPORT_THRESHOLD } from "@gold-rules";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import { getPurchaseStaffNames, goToAustracForm, listIncompleteTransactions } from "../../lib/goldApi.js";
import { DueLine, GOLD_ROUTES, PurchaseTags, formatDateTime, goldPath, isAustracReportable } from "./shared/index.js";
import styles from "./GoldToCompletePage.module.css";

const NOTICE_MS = 4000;
const sellerName = (first, last) => [first, last].filter(Boolean).join(" ");

// Purchases still waiting on something (spec 5.2, ToComplete row): no ERP invoice number yet, or reportable with a
// TTR that is not complete. AUSTRAC pending first. A purchase with an invoice number and a draft TTR is
// "Resume TTR"; one whose draft was deleted is "Start TTR"; one with no invoice number is "Complete".
const GoldToCompletePage = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [loaded, setLoaded] = useState(null); // { rows, staff } or { hasFailed }
    const [notice, setNotice] = useState(location.state?.notice ?? "");
    const [busyId, setBusyId] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            try {
                const [rows, staff] = await Promise.all([listIncompleteTransactions(), getPurchaseStaffNames()]);
                if (!isCancelled) setLoaded({ rows, staff });
            } catch {
                if (!isCancelled) setLoaded({ hasFailed: true });
            }
        };
        load();
        return () => {
            isCancelled = true;
        };
    }, []);

    // A notice from the screen that sent us here ("Purchase completed") shows once.
    useEffect(() => {
        if (location.state?.notice) navigate(location.pathname, { replace: true, state: null });
    }, [location.state, location.pathname, navigate]);

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(""), NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);

    const handleOpenTtr = async (purchaseId) => {
        setBusyId(purchaseId);
        setError("");
        try {
            const { path } = await goToAustracForm(purchaseId);
            navigate(path);
        } catch (err) {
            setError(err.message);
            setBusyId("");
        }
    };

    const renderAction = (purchase) => {
        if (!purchase.erp_invoice_no) {
            return (
                <Button onClick={() => navigate(goldPath(GOLD_ROUTES.completePurchase, { purchaseId: purchase.id }))}>
                    Complete
                </Button>
            );
        }
        return (
            <Button disabled={busyId === purchase.id} onClick={() => handleOpenTtr(purchase.id)}>
                {purchase.ttr_transaction_id ? "Resume TTR" : "Start TTR"}
            </Button>
        );
    };

    const renderRow = (purchase, staff) => {
        const customerLink = (id, name) => <Link to={goldPath(GOLD_ROUTES.customer, { customerId: id })}>{name}</Link>;
        return (
            <li key={purchase.id} className={styles.row}>
                <div className={styles.rowBody}>
                    <p className={styles.rowTitle}>
                        <span>
                            {customerLink(
                                purchase.customer_id,
                                sellerName(purchase.customer_first_name, purchase.customer_last_name)
                            )}
                            {purchase.joint_customer_id ? (
                                <>
                                    {" "}
                                    and{" "}
                                    {customerLink(
                                        purchase.joint_customer_id,
                                        sellerName(
                                            purchase.joint_customer_first_name,
                                            purchase.joint_customer_last_name
                                        )
                                    )}
                                </>
                            ) : null}
                        </span>
                        <PurchaseTags purchase={purchase} />
                    </p>
                    <p className={styles.hint}>
                        {purchase.erp_invoice_no ? `Invoice ${purchase.erp_invoice_no} | ` : ""}Recorded{" "}
                        {formatDateTime(purchase.created_at)}
                        {staff[purchase.created_by_staff_id] ? ` by ${staff[purchase.created_by_staff_id]}` : ""} |{" "}
                        {purchase.photo_count} photo{purchase.photo_count === 1 ? "" : "s"}
                    </p>
                    {isAustracReportable(purchase) ? <DueLine purchase={purchase} /> : null}
                </div>
                {renderAction(purchase)}
            </li>
        );
    };

    const renderBody = () => {
        if (!loaded) return <p className={styles.hint}>Loading…</p>;
        if (loaded.hasFailed) return <p className={styles.error}>Could not load the purchases. Try again.</p>;
        const { rows, staff } = loaded;
        const pending = rows.filter(isAustracReportable);
        const other = rows.filter((row) => !isAustracReportable(row));
        return (
            <>
                {rows.length === 0 ? (
                    <p className={styles.empty}>Nothing to complete. Every purchase has an invoice number.</p>
                ) : null}
                {pending.length > 0 ? (
                    <section className={styles.section} aria-labelledby="pendingHeading">
                        <h2 id="pendingHeading" className={styles.sectionTitle}>
                            AUSTRAC pending ({pending.length})
                        </h2>
                        <p className={styles.hint}>
                            Cash of ${CASH_REPORT_THRESHOLD.toLocaleString("en-AU")} or more. The AUSTRAC form opens
                            when you complete each one.
                        </p>
                        <ul className={styles.list}>{pending.map((row) => renderRow(row, staff))}</ul>
                    </section>
                ) : null}
                {other.length > 0 ? (
                    <section className={styles.section} aria-labelledby="otherHeading">
                        <h2 id="otherHeading" className={styles.sectionTitle}>
                            Other purchases ({other.length})
                        </h2>
                        <ul className={styles.list}>{other.map((row) => renderRow(row, staff))}</ul>
                    </section>
                ) : null}
            </>
        );
    };

    return (
        <div className={styles.page}>
            {notice ? (
                <p className={styles.toast} role="status">
                    {notice}
                </p>
            ) : null}
            <section className={styles.card}>
                <h1 className={styles.title}>To complete</h1>
                <p className={styles.hint}>
                    Purchases saved without an ERP invoice number, and AUSTRAC reports still to finish. Add the invoice
                    number, or open the report.
                </p>
                {error ? (
                    <p className={styles.error} role="alert">
                        {error}
                    </p>
                ) : null}
                {renderBody()}
            </section>
        </div>
    );
};

export default GoldToCompletePage;
