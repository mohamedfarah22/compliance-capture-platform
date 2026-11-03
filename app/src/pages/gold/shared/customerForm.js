import { businessDate } from "@gold-rules";
import { phoneDigitCount } from "../../../lib/goldApi.js";

// CCP's ID types for a photographed document. Mirrors DOCUMENT_TYPES in _shared/goldCustomers.ts.
export const ID_DOCUMENT_TYPES = [
    "Driver licence",
    "Passport",
    "Proof of age card",
    "National identity card",
    "Medicare card",
    "Other government document",
    "Other",
];
export const BACK_REQUIRED_TYPES = new Set(["Driver licence"]);
export const AU_STATES = ["VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
const EARLIEST_DOB = "1900-01-01";
const MAX_TEXT_LENGTH = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ID_FIELDS = {
    documentType: "Driver licence",
    documentTypeOther: "",
    documentNumber: "",
    issuer: "",
    idCountryCode: "AU",
    hasExpiry: null,
    expiryDate: "",
};
export const EMPTY_FORM = {
    firstName: "",
    middleName: "",
    lastName: "",
    dateOfBirth: "",
    gender: "",
    phone: "",
    email: "",
    occupation: "",
    street: "",
    suburb: "",
    state: "",
    postcode: "",
    citizenshipCountryCode: "",
    taxResidencyCountryCode: "",
    reason: "",
    ...ID_FIELDS,
};
// What gold-update-customer takes: form field -> the key in `changes`.
export const EDIT_FIELDS = [
    "firstName",
    "middleName",
    "lastName",
    "dateOfBirth",
    "gender",
    "phone",
    "email",
    "occupation",
    "citizenshipCountryCode",
    "taxResidencyCountryCode",
];
export const ADDRESS_FIELDS = ["street", "suburb", "state", "postcode"];

const text = (value) => value ?? "";

export const formFromCustomer = (customer) => ({
    ...EMPTY_FORM,
    firstName: text(customer.first_name),
    middleName: text(customer.middle_name),
    lastName: text(customer.last_name),
    dateOfBirth: text(customer.date_of_birth),
    gender: text(customer.gender),
    phone: text(customer.phone),
    email: text(customer.email),
    occupation: text(customer.occupation),
    street: text(customer.res_street),
    suburb: text(customer.res_suburb),
    state: text(customer.res_state),
    postcode: text(customer.res_postcode),
    citizenshipCountryCode: text(customer.citizenship_country_code),
    taxResidencyCountryCode: text(customer.tax_residency_country_code),
});

// Update ID: the same document (renewed, photo unclear) starts from what is on file; a different one starts blank.
export const documentFor = (reason, currentId) => {
    if (reason === "different_document" || !currentId) return ID_FIELDS;
    return {
        ...ID_FIELDS,
        documentType: ID_DOCUMENT_TYPES.includes(currentId.document_type) ? currentId.document_type : "",
        documentNumber: text(currentId.document_number),
        issuer: text(currentId.issuer),
        idCountryCode: text(currentId.id_country_code) || ID_FIELDS.idCountryCode,
        hasExpiry: currentId.has_expiry,
        expiryDate: reason === "photo_unclear" ? text(currentId.expiry_date) : "",
    };
};

export const validatePerson = (form, { isEdit }) => {
    const errors = {};
    const today = businessDate();
    if (!form.firstName.trim()) errors.firstName = "Enter the first name.";
    if (!form.lastName.trim()) errors.lastName = "Enter the last name.";
    for (const key of ["firstName", "middleName", "lastName"]) {
        if (form[key].trim().length > MAX_TEXT_LENGTH) errors[key] = `Use ${MAX_TEXT_LENGTH} characters or fewer.`;
    }
    if (!form.dateOfBirth) errors.dateOfBirth = "Enter the date of birth as DD/MM/YYYY.";
    else if (form.dateOfBirth < EARLIEST_DOB) errors.dateOfBirth = "Enter a date of birth from 1900 onwards.";
    else if (form.dateOfBirth > today) errors.dateOfBirth = "The date of birth cannot be in the future.";
    if (!form.phone.trim()) errors.phone = "Enter a contact phone number.";
    else if (phoneDigitCount(form.phone) < 8) errors.phone = "Phone number looks too short.";
    if (!form.street.trim()) errors.street = "Enter the street address.";
    if (!form.suburb.trim()) errors.suburb = "Enter the suburb.";
    if (!AU_STATES.includes(form.state)) errors.state = "Choose the state or territory.";
    if (!/^\d{4}$/.test(form.postcode.trim())) errors.postcode = "Postcode must be 4 digits.";
    if (isEdit) {
        if (form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) errors.email = "Enter a valid email address.";
        for (const key of ["citizenshipCountryCode", "taxResidencyCountryCode"]) {
            if (form[key].trim() && !/^[A-Za-z]{2}$/.test(form[key].trim())) {
                errors[key] = "Use a 2-letter country code, for example AU.";
            }
        }
    }
    return errors;
};

export const validateDocument = (form, { front, back, isSighted }) => {
    const errors = {};
    const today = businessDate();
    if (!ID_DOCUMENT_TYPES.includes(form.documentType)) errors.documentType = "Choose the type of ID.";
    if (form.documentType === "Other" && !form.documentTypeOther.trim()) {
        errors.documentTypeOther = "Describe the document.";
    }
    if (!form.documentNumber.trim()) errors.documentNumber = "Enter the ID number.";
    if (!form.issuer.trim()) errors.issuer = "Enter the state or authority that issued the ID.";
    if (!/^[A-Za-z]{2}$/.test(form.idCountryCode.trim())) {
        errors.idCountryCode = "Use a 2-letter country code, for example AU.";
    }
    if (form.hasExpiry === null) errors.hasExpiry = "Say whether the ID has an expiry date.";
    else if (form.hasExpiry && !form.expiryDate) errors.expiryDate = "Enter the expiry date shown on the ID.";
    else if (form.hasExpiry && form.expiryDate < today) {
        errors.expiryDate = "This ID has expired. Ask the customer for a current ID.";
    }
    if (!front) errors.front = "Take or upload a photo of the front of the ID.";
    if (!back && BACK_REQUIRED_TYPES.has(form.documentType))
        errors.back = "Take or upload a photo of the back of the ID.";
    if (!isSighted) errors.isSighted = "Confirm you have checked the original ID in person.";
    return errors;
};

export const idPayload = (form) => ({
    documentType: form.documentType,
    ...(form.documentType === "Other" ? { documentTypeOther: form.documentTypeOther.trim() } : {}),
    documentNumber: form.documentNumber.trim(),
    issuer: form.issuer.trim(),
    idCountryCode: form.idCountryCode.trim().toUpperCase(),
    hasExpiry: form.hasExpiry,
    ...(form.hasExpiry ? { expiryDate: form.expiryDate } : {}),
});

// Only the fields that differ from what was loaded, as gold-update-customer takes them.
export const changesFrom = (form, initial) => {
    const changes = {};
    for (const key of EDIT_FIELDS) {
        const value = form[key].trim();
        if (value !== initial[key]) {
            changes[key] = key.endsWith("CountryCode") ? value.toUpperCase() : value;
        }
    }
    if (ADDRESS_FIELDS.some((key) => form[key].trim() !== initial[key])) {
        changes.residentialAddress = Object.fromEntries(ADDRESS_FIELDS.map((key) => [key, form[key].trim()]));
    }
    return changes;
};

// The server names fields as it takes them ("residentialAddress.street", "id.documentType", "frontImage").
export const formKeyFor = (serverKey) =>
    serverKey
        .replace(/^(residentialAddress|id)\./, "")
        .replace("frontImage", "front")
        .replace("backImage", "back")
        .replace("changes", "form");
