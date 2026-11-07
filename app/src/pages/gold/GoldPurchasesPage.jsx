import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import FormField from "../../components/ui/FormField.jsx";
import TextInput from "../../components/ui/TextInput.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import {
    getPurchaseStaffNames,
    listPurchaseIds,
    listRecordedBy,
    recordDownload,
    searchTransactions,
} from "../../lib/goldApi.js";
import {
    GOLD_ROUTES,
    MAX_EXPORT_PURCHASES,
    PurchaseTags,
    buildPurchasesZip,
    formatDateTime,
    goldPath,
    saveBlob,
} from "./shared/index.js";
import styles from "./GoldPurchasesPage.module.css";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;
const FILTER_KEYS = { type: "type", status: "status", cash: "cash", from: "from", to: "to", recordedBy: "by" };
const STATUS_OPTIONS = [
    ["", "All"],
    ["incomplete", "Incomplete"],
    ["complete", "Completed"],
    ["austrac_pending", "AUSTRAC pending"],
    ["austrac", "AUSTRAC"],
];
const sellerName = (first, last) => [first, last].filter(Boolean).join(" ");

// Every purchase, with filters and server paging (spec 5.2, Purchases row). The filters and the page are in the
// URL, so a reload or a shared link shows the same list; the search text is not, because it can be a customer's
// name, phone or ID number. Managers and admins can download the matching purchases as a zip (spec 6.2); the
// server (gold-export) is the real gate, hiding the button for staff is a courtesy.
const GoldPurchasesPage = () => {
    const { staffMember } = useAuth();
    const canDownload = ["manager", "admin"].includes(staffMember?.role);
    const [params, setParams] = useSearchParams();
    const filters = Object.fromEntries(Object.entries(FILTER_KEYS).map(([name, key]) => [name, params.get(key) ?? ""]));
    const page = Math.max(1, Number(params.get("page")) || 1);
    const [query, setQuery] = useState("");
    const [recorders, setRecorders] = useState([]);
    // The last search finished: { key, rows, total, staff } or { key, hasFailed }.
    const [loaded, setLoaded] = useState(null);
    const key = JSON.stringify([query.trim(), filters, page]);

    useEffect(() => {
        listRecordedBy()
            .then(setRecorders)
            .catch(() => {});
    }, []);

    useEffect(() => {
        let isCancelled = false;
        const timer = setTimeout(async () => {
            try {
                const [{ rows, total }, staff] = await Promise.all([
                    searchTransactions({ q: query.trim(), ...filters }, { page, pageSize: PAGE_SIZE }),
                    getPurchaseStaffNames().catch(() => ({})),
                ]);
                if (!isCancelled) setLoaded({ key, rows, total, staff });
            } catch {
                if (!isCancelled) setLoaded({ key, hasFailed: true });
            }
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
        // key stands for query, filters and page.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const updateParams = (changes) => {
        const next = new URLSearchParams(params);
        Object.entries(changes).forEach(([name, value]) => (value ? next.set(name, value) : next.delete(name)));
        setParams(next);
    };
    const setFilter = (name) => (e) => updateParams({ [FILTER_KEYS[name]]: e.target.value, page: "" });
    const setPage = (next) => updateParams({ page: next > 1 ? String(next) : "" });
    const clearFilters = () => {
        setQuery("");
        setParams(new URLSearchParams());
    };

    const hasFilters = Boolean(query.trim()) || Object.values(filters).some(Boolean);
    const isCurrent = loaded?.key === key;

    // The download: the ids of everything the filters match, then gold-export (audit row, then signed URLs), then
    // the zip is built here and saved.
    const [progress, setProgress] = useState(null);
    const [downloadMessage, setDownloadMessage] = useState({ text: "", isError: false });
    const total = isCurrent && !loaded.hasFailed ? loaded.total : null;
    const download = async () => {
        setDownloadMessage({ text: "", isError: false });
        setProgress({ done: 0, total });
        try {
            const sent = { q: query.trim(), ...filters };
            const purchaseIds = await listPurchaseIds(sent);
            const { purchases } = await recordDownload({ kind: "zip", filters: sent, purchaseIds });
            const { blob, filename } = await buildPurchasesZip(purchases, (done, all) =>
                setProgress({ done, total: all })
            );
            saveBlob(blob, filename);
            const text = `Downloaded ${purchases.length} purchase${purchases.length === 1 ? "" : "s"}`;
            setDownloadMessage({ text, isError: false });
        } catch (err) {
            setDownloadMessage({ text: err.message || "Could not prepare the download. Try again.", isError: true });
        } finally {
            setProgress(null);
        }
    };
    const isTooMany = total != null && total > MAX_EXPORT_PURCHASES;

    const renderResults = () => {
        if (!isCurrent) return null;
        if (loaded.hasFailed) return <p className={styles.error}>Could not load the purchases. Try again.</p>;
        if (loaded.rows.length === 0) return <p className={styles.empty}>No purchases match these filters.</p>;
        const lastPage = Math.ceil(loaded.total / PAGE_SIZE);
        return (
            <>
                <ul className={styles.list}>
                    {loaded.rows.map((purchase) => {
                        const creator = loaded.staff[purchase.created_by_staff_id];
                        const completer = loaded.staff[purchase.completed_by_staff_id];
                        return (
                            <li key={purchase.id}>
                                <Link
                                    className={styles.row}
                                    to={goldPath(GOLD_ROUTES.purchase, { purchaseId: purchase.id })}
                                >
                                    <span className={styles.rowBody}>
                                        <span className={styles.rowTitle}>
                                            {sellerName(purchase.customer_first_name, purchase.customer_last_name)}
                                            {purchase.joint_customer_id
                                                ? ` and ${sellerName(purchase.joint_customer_first_name, purchase.joint_customer_last_name)}`
                                                : ""}
                                            <PurchaseTags purchase={purchase} />
                                        </span>
                                        <span className={styles.hint}>
                                            {purchase.erp_invoice_no || "No invoice number yet"} |{" "}
                                            {formatDateTime(purchase.created_at)}
                                            {creator ? ` by ${creator}` : ""}
                                        </span>
                                        {purchase.completed_at ? (
                                            <span className={styles.hint}>
                                                Completed {formatDateTime(purchase.completed_at)}
                                                {completer ? ` by ${completer}` : ""}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className={styles.view}>View</span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
                {lastPage > 1 ? (
                    <nav className={styles.pager} aria-label="Pages">
                        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                            Previous
                        </Button>
                        <span className={styles.hint}>
                            Page {page} of {lastPage}
                        </span>
                        <Button variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
                            Next
                        </Button>
                    </nav>
                ) : null}
            </>
        );
    };

    return (
        <section className={styles.card}>
            <div className={styles.titleRow}>
                <div>
                    <h1 className={styles.title}>Purchases</h1>
                    <p className={styles.hint}>Find previous purchases.</p>
                </div>
                {canDownload ? (
                    <Button onClick={download} disabled={!total || isTooMany || Boolean(progress)}>
                        {progress ? `Preparing… ${progress.done}/${progress.total}` : `Download (${total ?? 0})`}
                    </Button>
                ) : null}
            </div>
            {isTooMany ? (
                <p className={styles.error} role="alert">
                    Too many purchases to download ({total}). Narrow the filters to {MAX_EXPORT_PURCHASES} or fewer.
                </p>
            ) : null}
            {downloadMessage.text ? (
                <p className={downloadMessage.isError ? styles.error : styles.notice} role="status">
                    {downloadMessage.text}
                </p>
            ) : null}

            <div className={styles.filters}>
                <div className={styles.wide}>
                    <FormField label="Search" labelFor="purchaseSearch">
                        <TextInput
                            id="purchaseSearch"
                            placeholder="Name, phone, licence or ID number, or invoice number"
                            autoComplete="off"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                if (page > 1) setPage(1);
                            }}
                        />
                    </FormField>
                </div>
                <FormField label="Type" labelFor="purchaseType">
                    <select
                        id="purchaseType"
                        className={styles.select}
                        value={filters.type}
                        onChange={setFilter("type")}
                    >
                        <option value="">All</option>
                        <option value="scrap">Scrap jewellery</option>
                        <option value="bullion">Bullion</option>
                    </select>
                </FormField>
                <FormField label="Status" labelFor="purchaseStatus">
                    <select
                        id="purchaseStatus"
                        className={styles.select}
                        value={filters.status}
                        onChange={setFilter("status")}
                    >
                        {STATUS_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                                {label}
                            </option>
                        ))}
                    </select>
                </FormField>
                <FormField label="Cash" labelFor="purchaseCash">
                    <select
                        id="purchaseCash"
                        className={styles.select}
                        value={filters.cash}
                        onChange={setFilter("cash")}
                    >
                        <option value="">All</option>
                        <option value="yes">Cash $10k+ (AUSTRAC)</option>
                        <option value="no">Other</option>
                    </select>
                </FormField>
                <FormField label="From" labelFor="purchaseFrom">
                    <TextInput
                        id="purchaseFrom"
                        type="date"
                        value={filters.from}
                        max={filters.to || undefined}
                        onChange={setFilter("from")}
                    />
                </FormField>
                <FormField label="To" labelFor="purchaseTo">
                    <TextInput
                        id="purchaseTo"
                        type="date"
                        value={filters.to}
                        min={filters.from || undefined}
                        onChange={setFilter("to")}
                    />
                </FormField>
                <FormField label="Recorded by" labelFor="purchaseBy">
                    <select
                        id="purchaseBy"
                        className={styles.select}
                        value={filters.recordedBy}
                        onChange={setFilter("recordedBy")}
                    >
                        <option value="">Everyone</option>
                        {recorders.map((staff) => (
                            <option key={staff.id} value={staff.id}>
                                {staff.name}
                            </option>
                        ))}
                    </select>
                </FormField>
            </div>

            <div className={styles.summary}>
                <span role="status">
                    {isCurrent && !loaded.hasFailed
                        ? `${loaded.total} purchase${loaded.total === 1 ? "" : "s"}`
                        : "Loading…"}
                </span>
                {hasFilters ? (
                    <Button variant="secondary" onClick={clearFilters}>
                        Clear filters
                    </Button>
                ) : null}
            </div>

            {renderResults()}
        </section>
    );
};

export default GoldPurchasesPage;
