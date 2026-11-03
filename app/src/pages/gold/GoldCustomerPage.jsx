import { idStatus } from "@gold-rules";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import TextInput from "../../components/ui/TextInput.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { getCustomer, getCustomerIdImages, phoneDigitCount, updateCustomerPhone } from "../../lib/goldApi.js";
import { GOLD_ROUTES, IdStatusBadge, Lightbox, formatDate, goldPath } from "./shared/index.js";
import styles from "./GoldCustomerPage.module.css";

const NOTICE_MS = 4000;

const formatAddress = (c) =>
    [c.res_street, [c.res_suburb, c.res_state, c.res_postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

const GoldCustomerPage = () => {
    const { customerId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { staffMember, reportingEntity } = useAuth();
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
    }, [customerId]);

    // A notice from the screen that sent us here ("Customer created") shows once: it is cleared from the history
    // entry, so a reload does not show it again.
    useEffect(() => {
        if (location.state?.notice) navigate(location.pathname, { replace: true, state: null });
    }, [location.state, location.pathname, navigate]);

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

            {/* TODO(8b): the purchase form and purchase history go here (spec 5.2, CustomerDetail row). */}
            <section className={styles.card} aria-labelledby="purchaseHeading" data-testid="purchase-form-placeholder">
                <h2 id="purchaseHeading" className={styles.sectionTitle}>
                    Record a purchase
                </h2>
                <p className={styles.placeholder}>Recording purchases is coming in the next release.</p>
            </section>

            {zoom ? <Lightbox {...zoom} onClose={() => setZoom(null)} /> : null}
        </div>
    );
};

export default GoldCustomerPage;
