import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import DatePicker from "../../components/ui/DatePicker.jsx";
import FormField from "../../components/ui/FormField.jsx";
import TextInput from "../../components/ui/TextInput.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import {
    createCustomer,
    findIdOwner,
    findPossibleDuplicates,
    getCustomer,
    phoneDigitCount,
    updateCustomerDetails,
    updateCustomerId,
} from "../../lib/goldApi.js";
import {
    ADDRESS_FIELDS,
    AU_STATES,
    BACK_REQUIRED_TYPES,
    EMPTY_FORM,
    ID_DOCUMENT_TYPES,
    changesFrom,
    documentFor,
    formFromCustomer,
    formKeyFor,
    idPayload,
    validateDocument,
    validatePerson,
} from "./shared/customerForm.js";
import { DEV_FILL, sampleIdDetails, sampleImage, samplePerson } from "./shared/devFill.js";
import { GOLD_ROUTES, IdStatusBadge, ImageField, YesNo, formatDate, goldPath } from "./shared/index.js";
import styles from "./GoldCustomerFormPage.module.css";

const UPDATE_REASONS = [
    ["renewed", "Renewed: same document, new expiry date"],
    ["different_document", "The customer presented a different document"],
    ["photo_unclear", "The stored photo is unclear"],
];
const GENDER_OPTIONS = [
    ["", "Select gender"],
    ["M", "Male"],
    ["F", "Female"],
    ["U", "Unknown / not stated"],
];
const STATE_OPTIONS = [["", "Select state"], ...AU_STATES.map((state) => [state, state])];
const DOCUMENT_TYPE_OPTIONS = [["", "Select ID type"], ...ID_DOCUMENT_TYPES.map((type) => [type, type])];
const COUNTRY_HINT = "2-letter country code, for example AU";
const SUBMIT_LABELS = { create: "Create customer", update: "Save new ID", edit: "Save changes" };

// Editing a field named here makes an earlier "different person" answer stale.
const DUPLICATE_KEYS = ["firstName", "lastName", "dateOfBirth", "phone"];
const ID_KEYS = ["documentType", "documentNumber"];
const TITLES = {
    create: ["New customer", "Enter the details exactly as they appear on the customer’s ID. All fields are required."],
    update: ["Update ID", "Record the customer’s current ID. Their previous ID stays on file."],
    edit: ["Edit details", "Correct the customer’s details. ID details change through Update ID."],
};

const describeOwner = (owner) => {
    const name = owner.name || "another customer";
    return owner.dateOfBirth ? `${name} (born ${formatDate(owner.dateOfBirth)})` : name;
};

const GoldCustomerFormPage = ({ mode = "create" }) => {
    const { customerId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { staffMember } = useAuth();
    const formRef = useRef(null);

    const isCreate = mode === "create";
    const isUpdate = mode === "update";
    const isEdit = mode === "edit";
    const isUnauthorised = isEdit && !["manager", "admin"].includes(staffMember?.role);
    const [title, subtitle] = TITLES[mode];

    const [loadState, setLoadState] = useState(isCreate || isUnauthorised ? "ready" : "loading");
    const [customer, setCustomer] = useState(null);
    const [initialForm, setInitialForm] = useState(EMPTY_FORM);
    const [form, setForm] = useState(EMPTY_FORM);
    const [front, setFront] = useState(null);
    const [back, setBack] = useState(null);
    const [isSighted, setIsSighted] = useState(false);
    const [errors, setErrors] = useState({});
    const [isBusy, setIsBusy] = useState(false);
    const [duplicates, setDuplicates] = useState([]);
    const [isDuplicateConfirmed, setIsDuplicateConfirmed] = useState(false);
    const [idOwner, setIdOwner] = useState(null);
    const [isIdOwnerConfirmed, setIsIdOwnerConfirmed] = useState(false);

    useEffect(() => {
        if (isCreate || isUnauthorised) return;
        let isCancelled = false;
        getCustomer(customerId)
            .then((loaded) => {
                if (isCancelled) return;
                const loadedForm = formFromCustomer(loaded);
                setCustomer(loaded);
                setForm(loadedForm);
                setInitialForm(loadedForm);
                setLoadState("ready");
            })
            .catch(() => !isCancelled && setLoadState("notFound"));
        return () => {
            isCancelled = true;
        };
    }, [customerId, isCreate, isUnauthorised]);

    const currentId = customer?.current_id ?? null;
    // With no ID on file there is nothing to renew or re-photograph: the new ID is a different document.
    const reason = currentId ? form.reason : "different_document";
    const backIsRequired = BACK_REQUIRED_TYPES.has(form.documentType);
    // A purchase form sent staff here: creating the joint seller (jointFor) or renewing a seller's ID (returnTo).
    // Both go back to that purchase's customer page, where the unsaved form is still waiting.
    const { jointFor, returnTo } = location.state ?? {};
    const purchaseCustomerId = jointFor ?? returnTo;
    // Create has no customer yet; Cancel goes back to Find customer.
    const customerRoute = purchaseCustomerId
        ? goldPath(GOLD_ROUTES.customer, { customerId: purchaseCustomerId })
        : isCreate
          ? GOLD_ROUTES.search
          : goldPath(GOLD_ROUTES.customer, { customerId });

    const setField = (key, value) => {
        setForm((prev) => ({ ...prev, [key]: value }));
        setErrors((prev) => ({ ...prev, [key]: "", form: "" }));
        if (DUPLICATE_KEYS.includes(key)) {
            setDuplicates([]);
            setIsDuplicateConfirmed(false);
        }
        if (ID_KEYS.includes(key)) {
            setIdOwner(null);
            setIsIdOwnerConfirmed(false);
        }
    };
    const handleText = (key) => (e) => setField(key, e.target.value);

    const handleReasonChange = (value) => {
        setForm((prev) => ({ ...prev, reason: value, ...documentFor(value, currentId) }));
        setErrors({});
        setIdOwner(null);
    };

    const setPhoto = (setPhotoState, key) => (value) => {
        setPhotoState(value);
        setErrors((prev) => ({ ...prev, [key]: "" }));
    };

    const checkDuplicates = async () => {
        if (!isCreate) return;
        const hasName = form.firstName.trim() && form.lastName.trim() && form.dateOfBirth;
        if (!hasName && phoneDigitCount(form.phone) < 8) return;
        setDuplicates(await findPossibleDuplicates(form));
    };

    const checkIdOwner = async () => {
        if (!isCreate || !form.documentNumber.trim() || !form.documentType) return;
        setIdOwner(await findIdOwner({ documentType: form.documentType, documentNumber: form.documentNumber.trim() }));
    };

    const handleFillTestData = async () => {
        const sample = isUpdate ? sampleIdDetails() : samplePerson();
        setForm((prev) => ({ ...prev, ...sample, reason: isUpdate ? reason || "renewed" : prev.reason }));
        setFront(await sampleImage("ID front"));
        setBack(await sampleImage("ID back"));
        setIsSighted(true);
        setErrors({});
        setDuplicates([]);
        setIdOwner(null);
    };

    const showErrors = (found) => {
        setErrors(found);
        // Let the messages render, then put the focus on the first field with a problem.
        setTimeout(() => formRef.current?.querySelector("[aria-invalid='true']")?.focus());
    };

    const handleFailure = (err) => {
        if (err.code === "possible_duplicates") setDuplicates(err.body.duplicates ?? []);
        else if (err.code === "id_on_file" && isCreate) setIdOwner(err.body.owner ?? { name: null });
        else if (err.code === "validation_failed") {
            const fields = Object.fromEntries(
                Object.entries(err.body.fields ?? {}).map(([key, message]) => [formKeyFor(key), message])
            );
            showErrors({ ...fields, form: err.message });
        } else if (err.code === "id_on_file") {
            const owner = err.body.owner;
            showErrors({
                form: `This ID number is already on file for ${owner ? describeOwner(owner) : "another customer"}. Check the number.`,
            });
        } else showErrors({ form: err.message });
    };

    const submit = async () => {
        if (isCreate) {
            const created = await createCustomer({
                firstName: form.firstName.trim(),
                middleName: form.middleName.trim(),
                lastName: form.lastName.trim(),
                dateOfBirth: form.dateOfBirth,
                phone: form.phone.trim(),
                residentialAddress: Object.fromEntries(ADDRESS_FIELDS.map((key) => [key, form[key].trim()])),
                id: idPayload(form),
                confirmNew: isDuplicateConfirmed,
                differentPerson: isIdOwnerConfirmed,
                front: front.blob,
                back: back?.blob,
            });
            return jointFor
                ? [customerRoute, "Customer created", { jointId: created.customerId }]
                : [goldPath(GOLD_ROUTES.customer, { customerId: created.customerId }), "Customer created"];
        }
        if (isUpdate) {
            await updateCustomerId(customerId, { reason, ...idPayload(form), front: front.blob, back: back?.blob });
            return [customerRoute, "ID updated"];
        }
        await updateCustomerDetails(customerId, changesFrom(form, initialForm));
        return [customerRoute, "Details updated"];
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const found = isEdit
            ? validatePerson(form, { isEdit })
            : {
                  ...(isCreate ? validatePerson(form, { isEdit }) : {}),
                  ...validateDocument(form, { front, back, isSighted }),
                  ...(isUpdate && !reason ? { reason: "Choose why you are updating the ID." } : {}),
              };
        if (isEdit && Object.keys(found).length === 0 && Object.keys(changesFrom(form, initialForm)).length === 0) {
            found.form = "Change at least one field.";
        }
        if (Object.keys(found).length > 0) return showErrors(found);

        const isPromptOpen = (duplicates.length > 0 && !isDuplicateConfirmed) || (idOwner && !isIdOwnerConfirmed);
        if (isPromptOpen) return;

        setIsBusy(true);
        try {
            const [path, notice, extraState] = await submit();
            navigate(path, { state: { notice, ...extraState } });
        } catch (err) {
            handleFailure(err);
            setIsBusy(false);
        }
    };

    if (isUnauthorised) {
        return <p className={styles.notice}>You are not authorised to view this page.</p>;
    }
    if (loadState === "loading") return <p className={styles.notice}>Loading…</p>;
    if (loadState === "notFound") {
        return (
            <p className={styles.notice}>
                Customer not found. <Link to={GOLD_ROUTES.search}>Back to Find customer</Link>
            </p>
        );
    }

    const hasErrors = Object.values(errors).some(Boolean);
    const showDuplicates = duplicates.length > 0 && !isDuplicateConfirmed;
    const showIdOwner = idOwner && !isIdOwnerConfirmed;

    const renderText = (key, label, { helperText, onBlur, ...inputProps } = {}) => (
        <FormField label={label} labelFor={key} helperText={helperText} error={errors[key] ?? ""}>
            <TextInput
                id={key}
                value={form[key]}
                onChange={handleText(key)}
                onBlur={onBlur}
                aria-invalid={Boolean(errors[key])}
                autoComplete="off"
                {...inputProps}
            />
        </FormField>
    );

    const renderSelect = (key, label, options, { onBlur } = {}) => (
        <FormField label={label} labelFor={key} error={errors[key] ?? ""}>
            <select
                id={key}
                className={styles.select}
                value={form[key]}
                onChange={handleText(key)}
                onBlur={onBlur}
                aria-invalid={Boolean(errors[key])}
            >
                {options.map(([value, optionLabel]) => (
                    <option key={value} value={value}>
                        {optionLabel}
                    </option>
                ))}
            </select>
        </FormField>
    );

    const renderDate = (key, label, onBlur) => (
        <FormField label={label} labelFor={key} error={errors[key] ?? ""}>
            <div onBlur={onBlur}>
                <DatePicker id={key} value={form[key]} onChange={(value) => setField(key, value)} />
            </div>
        </FormField>
    );

    const renderPersonFields = () => (
        <>
            <div className={styles.grid}>
                {renderText("firstName", "First name", { onBlur: checkDuplicates })}
                {renderText("middleName", "Middle name (optional)")}
                {renderText("lastName", "Last name", { onBlur: checkDuplicates })}
                {renderDate("dateOfBirth", "Date of birth", checkDuplicates)}
                {renderText("phone", "Phone", {
                    type: "tel",
                    inputMode: "tel",
                    placeholder: "04xx xxx xxx",
                    onBlur: checkDuplicates,
                })}
                {isEdit ? renderSelect("gender", "Gender", GENDER_OPTIONS) : null}
                {isEdit ? renderText("email", "Email (optional)", { type: "email" }) : null}
                {isEdit ? renderText("occupation", "Occupation (optional)") : null}
            </div>

            <h2 className={styles.sectionTitle}>Residential address</h2>
            <div className={styles.grid}>
                <div className={styles.wide}>{renderText("street", "Street address")}</div>
                {renderText("suburb", "Suburb")}
                {renderSelect("state", "State", STATE_OPTIONS)}
                {renderText("postcode", "Postcode", { inputMode: "numeric", maxLength: 4 })}
            </div>

            {isEdit ? (
                <div className={styles.grid}>
                    {renderText("citizenshipCountryCode", "Citizenship country (optional)", {
                        helperText: COUNTRY_HINT,
                        maxLength: 2,
                    })}
                    {renderText("taxResidencyCountryCode", "Tax residency country (optional)", {
                        helperText: COUNTRY_HINT,
                        maxLength: 2,
                    })}
                </div>
            ) : null}
        </>
    );

    const renderReason = () => (
        <fieldset className={styles.reasons}>
            <legend className={styles.legend}>Why are you updating the ID?</legend>
            {UPDATE_REASONS.map(([value, label]) => (
                <label key={value} className={styles.radio}>
                    <input
                        type="radio"
                        name="reason"
                        value={value}
                        checked={form.reason === value}
                        onChange={() => handleReasonChange(value)}
                    />
                    {label}
                </label>
            ))}
            {["renewed", "photo_unclear"].includes(form.reason) ? (
                <p className={styles.hint}>The old photos of this document are replaced when the new ones are saved.</p>
            ) : null}
            {errors.reason ? <p className={styles.error}>{errors.reason}</p> : null}
        </fieldset>
    );

    const renderIdFields = () => (
        <>
            <h2 className={styles.sectionTitle}>ID document</h2>
            <div className={styles.grid}>
                {renderSelect("documentType", "ID type", DOCUMENT_TYPE_OPTIONS, { onBlur: checkIdOwner })}
                {form.documentType === "Other" ? renderText("documentTypeOther", "Describe the document") : null}
                {renderText("documentNumber", "ID number", {
                    helperText: "The licence number, not the card number.",
                    onBlur: checkIdOwner,
                })}
                {renderText("issuer", "Issuer", {
                    helperText: "The state or authority that issued it, for example VIC for a Victorian licence.",
                })}
                {renderText("idCountryCode", "Country of issue", { helperText: COUNTRY_HINT, maxLength: 2 })}
                <FormField error={errors.hasExpiry ?? ""}>
                    <span id="hasExpiryLabel" className={styles.groupLabel}>
                        Does the ID have an expiry date?
                    </span>
                    <YesNo
                        value={form.hasExpiry}
                        labelledBy="hasExpiryLabel"
                        onChange={(value) => {
                            setField("hasExpiry", value);
                            if (!value) setField("expiryDate", "");
                        }}
                    />
                </FormField>
                {form.hasExpiry ? renderDate("expiryDate", "ID expiry date") : null}
            </div>

            <div className={styles.photos}>
                <ImageField
                    label="ID front"
                    value={front}
                    onChange={setPhoto(setFront, "front")}
                    error={errors.front}
                />
                <ImageField
                    label={backIsRequired ? "ID back" : "ID back (optional)"}
                    value={back}
                    onChange={setPhoto(setBack, "back")}
                    error={errors.back}
                />
            </div>

            <label className={`${styles.sighted} ${errors.isSighted ? styles.sightedError : ""}`}>
                <input
                    type="checkbox"
                    checked={isSighted}
                    onChange={(e) => {
                        setIsSighted(e.target.checked);
                        setErrors((prev) => ({ ...prev, isSighted: "" }));
                    }}
                />
                <span>
                    <strong>I have sighted the original ID in person</strong>
                    <span className={styles.hint}>
                        The photo matches the customer, and the ID is current and shows no sign of tampering.
                    </span>
                </span>
            </label>
            {errors.isSighted ? <p className={styles.error}>{errors.isSighted}</p> : null}
        </>
    );

    const openCustomer = (id) => navigate(goldPath(GOLD_ROUTES.customer, { customerId: id }));

    return (
        <form ref={formRef} className={styles.card} onSubmit={handleSubmit} noValidate>
            <div className={styles.heading}>
                <div>
                    <h1 className={styles.title}>{title}</h1>
                    <p className={styles.subtitle}>
                        {isEdit
                            ? `Correct the details for ${customer.full_name}. ID details change through Update ID.`
                            : subtitle}
                    </p>
                </div>
                {isUpdate ? <IdStatusBadge currentId={currentId} /> : null}
            </div>

            {DEV_FILL && !isEdit ? (
                <Button variant="secondary" onClick={handleFillTestData}>
                    Fill with test data
                </Button>
            ) : null}

            {isUpdate ? (
                <p className={styles.onFile}>
                    {customer.full_name} |{" "}
                    {currentId
                        ? `On file: ${currentId.document_type} ${currentId.document_number}`
                        : "No ID is on file for this customer yet."}
                </p>
            ) : null}
            {isUpdate && currentId ? renderReason() : null}

            {!isUpdate ? renderPersonFields() : null}
            {showDuplicates ? (
                <div className={styles.prompt} role="alert">
                    <p className={styles.promptTitle}>This may be an existing customer</p>
                    <ul className={styles.promptList}>
                        {duplicates.map((match) => (
                            <li key={match.customerId}>
                                <span>
                                    {match.firstName} {match.lastName} | Born {formatDate(match.dateOfBirth)} |{" "}
                                    {match.phone}{" "}
                                    <em>
                                        ({match.matchReason === "phone" ? "same phone" : "same name and date of birth"})
                                    </em>
                                </span>
                                <Button variant="secondary" onClick={() => openCustomer(match.customerId)}>
                                    Open this customer
                                </Button>
                            </li>
                        ))}
                    </ul>
                    <Button variant="secondary" onClick={() => setIsDuplicateConfirmed(true)}>
                        It’s a different person, continue
                    </Button>
                </div>
            ) : null}

            {!isEdit && (!isUpdate || reason) ? renderIdFields() : null}
            {showIdOwner ? (
                <div className={styles.prompt} role="alert">
                    <p className={styles.promptTitle}>This ID is already on file</p>
                    <p className={styles.promptText}>
                        This {form.documentType} number belongs to {describeOwner(idOwner)}.
                    </p>
                    <div className={styles.promptActions}>
                        {idOwner.customerId ? (
                            <Button variant="secondary" onClick={() => openCustomer(idOwner.customerId)}>
                                Open that customer
                            </Button>
                        ) : null}
                        <Button variant="secondary" onClick={() => setIsIdOwnerConfirmed(true)}>
                            It’s a different person, continue
                        </Button>
                    </div>
                </div>
            ) : null}

            {hasErrors ? (
                <p className={styles.formError} role="alert">
                    {errors.form || "Check the highlighted fields."}
                </p>
            ) : null}

            <div className={styles.actions}>
                <Button variant="secondary" onClick={() => navigate(customerRoute)}>
                    Cancel
                </Button>
                <Button type="submit" disabled={isBusy}>
                    {isBusy ? "Saving…" : SUBMIT_LABELS[mode]}
                </Button>
            </div>
        </form>
    );
};

export default GoldCustomerFormPage;
