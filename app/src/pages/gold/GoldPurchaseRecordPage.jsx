import { bandLabel, typeLabel } from "@gold-rules";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import { openTtrPath } from "../../lib/ttrRoutes.js";
import {
    getCustomerIdImages,
    getCustomerNames,
    getGoldPhotoUrls,
    getPurchaseIdUsed,
    getPurchaseStaffNames,
    getTransaction,
} from "../../lib/goldApi.js";
import {
    DueLine,
    GOLD_ROUTES,
    Lightbox,
    PurchaseTags,
    isAustracReportable,
    formatAud,
    formatDate,
    formatDateTime,
    goldPath,
} from "./shared/index.js";
import styles from "./GoldPurchaseRecordPage.module.css";

const Item = ({ label, children }) => (
    <div>
        <dt>{label}</dt>
        <dd>{children}</dd>
    </div>
);

// The full record of one purchase (spec 5.2, PurchaseRecord row): its details, the ID details used for each seller
// (C1: if the photos were replaced, the newer copy, labelled), the goods photos, and the AUSTRAC report with a link
// to it. Download record is Phase 9b.
const GoldPurchaseRecordPage = () => {
    const { purchaseId } = useParams();
    const navigate = useNavigate();
    // The last purchase loaded: { id, purchase, names, staff, idUsed, idImages, photos } or { id, message }.
    const [loaded, setLoaded] = useState(null);
    const [zoom, setZoom] = useState(null);

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            try {
                const purchase = await getTransaction(purchaseId);
                const [names, staff, idUsed, photos] = await Promise.all([
                    getCustomerNames([purchase.customer_id, purchase.joint_customer_id]),
                    getPurchaseStaffNames().catch(() => ({})),
                    getPurchaseIdUsed(purchaseId),
                    getGoldPhotoUrls(purchaseId).catch(() => []),
                ]);
                const images = await Promise.all(idUsed.map((used) => getCustomerIdImages(used)));
                if (!isCancelled) {
                    setLoaded({
                        id: purchaseId,
                        purchase,
                        names,
                        staff,
                        idUsed,
                        idImages: Object.fromEntries(idUsed.map((used, index) => [used.role, images[index]])),
                        photos,
                    });
                }
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

    if (loaded?.id !== purchaseId) return <p className={styles.message}>Loading…</p>;
    if (loaded.message) {
        return (
            <section className={styles.card}>
                <p className={styles.error}>{loaded.message}</p>
                <Link to={GOLD_ROUTES.purchases}>Back to Purchases</Link>
            </section>
        );
    }

    const { purchase, names, staff, idUsed, idImages, photos } = loaded;
    const isIncomplete = !purchase.erp_invoice_no;
    const tagged = { ...purchase, ttr_status: purchase.ttr?.status ?? null };

    const renderAustrac = () => {
        if (!purchase.cash_10k_or_more && !purchase.ttr) return null;
        if (!purchase.ttr) return <p className={styles.austrac}>AUSTRAC report: not started</p>;
        if (purchase.ttr.status === "complete") {
            const { transaction_ref: reference, completed_at: completedAt } = purchase.ttr;
            return (
                <p className={styles.austrac}>
                    AUSTRAC report: complete. Reference {reference}, completed {formatDate(completedAt)}.
                </p>
            );
        }
        return (
            <p className={styles.austrac}>
                AUSTRAC report: draft in progress. <Link to={openTtrPath(purchase.ttr.id)}>Open AUSTRAC report</Link>
            </p>
        );
    };

    const renderSeller = (used) => {
        const customerId = used.role === "main" ? purchase.customer_id : purchase.joint_customer_id;
        const images = idImages[used.role];
        const renderPhoto = (label, src) => (
            <figure className={styles.figure}>
                <figcaption>{label}</figcaption>
                {src ? (
                    <button
                        type="button"
                        className={styles.photoButton}
                        onClick={() => setZoom({ src, alt: `${names[customerId]} — ${label}` })}
                    >
                        <img src={src} alt={`${names[customerId]} — ${label}`} className={styles.idPhoto} />
                    </button>
                ) : (
                    <span className={styles.photoEmpty}>Not on file</span>
                )}
            </figure>
        );
        return (
            <section key={used.role} className={styles.section}>
                <p className={styles.role}>{used.role === "main" ? "Main seller" : "Joint seller"}</p>
                <h2 className={styles.sellerName}>
                    <Link to={goldPath(GOLD_ROUTES.customer, { customerId })}>{names[customerId] || "Customer"}</Link>
                </h2>
                <dl className={styles.details}>
                    <Item label="ID type">{used.document_type}</Item>
                    <Item label="ID number">{used.document_number}</Item>
                    <Item label="Issuer">{used.issuer || "—"}</Item>
                    <Item label="ID expiry">{used.expiry_date ? formatDate(used.expiry_date) : "No expiry"}</Item>
                    <Item label="ID captured">
                        {used.captured_by_name ? `Captured by ${used.captured_by_name} on ` : "Captured on "}
                        {formatDate(used.captured_at)}
                    </Item>
                </dl>
                {used.photos_replaced ? (
                    <p className={styles.newer}>
                        Newer copy of this ID, taken{" "}
                        {used.current_copy_captured_at ? formatDate(used.current_copy_captured_at) : "later"}
                    </p>
                ) : null}
                <div className={styles.idPhotos}>
                    {renderPhoto("ID front", images?.front)}
                    {renderPhoto("ID back", images?.back)}
                </div>
            </section>
        );
    };

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <Link className={styles.back} to={GOLD_ROUTES.purchases}>
                    Back to Purchases
                </Link>
                {isIncomplete ? (
                    <Button
                        variant="secondary"
                        onClick={() => navigate(goldPath(GOLD_ROUTES.completePurchase, { purchaseId }))}
                    >
                        Complete
                    </Button>
                ) : null}
            </div>

            <article className={styles.card}>
                <div className={styles.heading}>
                    <h1 className={styles.title}>{typeLabel(purchase.purchase_type)} purchase</h1>
                    <PurchaseTags purchase={tagged} />
                </div>
                <p className={styles.hint}>
                    {purchase.erp_invoice_no ? `ERP invoice ${purchase.erp_invoice_no}` : "No ERP invoice number yet"}
                </p>
                {renderAustrac()}
                {isIncomplete && isAustracReportable(tagged) ? <DueLine purchase={purchase} /> : null}

                <dl className={styles.details}>
                    <Item label="Recorded">{formatDateTime(purchase.created_at)}</Item>
                    <Item label="Recorded by">{staff[purchase.created_by_staff_id] || "—"}</Item>
                    <Item label="Completed">
                        {purchase.completed_at
                            ? `${formatDateTime(purchase.completed_at)}${staff[purchase.completed_by_staff_id] ? ` by ${staff[purchase.completed_by_staff_id]}` : ""}`
                            : isIncomplete
                              ? "Not yet"
                              : "At capture"}
                    </Item>
                    <Item label="Type">{typeLabel(purchase.purchase_type)}</Item>
                    <Item label="Cash paid">{bandLabel(purchase.cash_band)}</Item>
                    <Item label="AUSTRAC report (cash $10,000 or more)">
                        {purchase.cash_10k_or_more ? "Yes" : "No"}
                    </Item>
                    {purchase.cash_10k_or_more || purchase.cash_amount != null ? (
                        <Item label="Cash amount">
                            {purchase.cash_amount != null ? formatAud(purchase.cash_amount) : "Not entered"}
                        </Item>
                    ) : null}
                    <Item label="Phone at purchase">{purchase.phone || "—"}</Item>
                    <Item label="Sighted in person">{purchase.id_sighted ? "Yes" : "No"}</Item>
                    <Item label="ID expired at time of purchase">{purchase.id_expired_at_time ? "Yes" : "No"}</Item>
                    <Item label="ID needed re-verifying at time of purchase">
                        {purchase.id_outside_window_at_time ? "Yes" : "No"}
                    </Item>
                    <Item label="Purchase ID">{purchase.id}</Item>
                </dl>

                {idUsed.map(renderSeller)}

                <section className={styles.section}>
                    <h2 className={styles.sectionTitle}>Goods photos ({purchase.goods_photos.length})</h2>
                    <ul className={styles.photoList}>
                        {photos.map((photo, index) => (
                            <li key={photo.id}>
                                <button
                                    type="button"
                                    className={styles.photoButton}
                                    onClick={() => setZoom({ src: photo.url, alt: `Goods photo ${index + 1}` })}
                                >
                                    <img
                                        src={photo.url}
                                        alt={`Goods photo ${index + 1}`}
                                        className={styles.goodsPhoto}
                                    />
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            </article>

            {zoom ? <Lightbox {...zoom} onClose={() => setZoom(null)} /> : null}
        </div>
    );
};

export default GoldPurchaseRecordPage;
