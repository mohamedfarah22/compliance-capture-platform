import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    changesFrom,
    documentFor,
    formFromCustomer,
    formKeyFor,
    idPayload,
    validateDocument,
    validatePerson,
} from "./customerForm.js";

// 2 Nov 2026, 12:00 in Melbourne.
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T01:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const person = {
    firstName: "Jane",
    middleName: "",
    lastName: "Citizen",
    dateOfBirth: "1985-06-15",
    phone: "0412 345 678",
    street: "1 Test St",
    suburb: "Coburg",
    state: "VIC",
    postcode: "3058",
    email: "",
    citizenshipCountryCode: "",
    taxResidencyCountryCode: "",
};
const document = {
    documentType: "Driver licence",
    documentTypeOther: "",
    documentNumber: "012345678",
    issuer: "VIC",
    idCountryCode: "AU",
    hasExpiry: true,
    expiryDate: "2030-01-01",
};
const photo = { blob: new Blob(["x"]), preview: "data:" };

describe("validatePerson", () => {
    it("accepts a complete person", () => {
        expect(validatePerson(person, { isEdit: false })).toEqual({});
    });

    it("asks for every required field", () => {
        const errors = validatePerson(
            {
                ...person,
                firstName: " ",
                lastName: "",
                dateOfBirth: "",
                phone: "",
                street: "",
                suburb: "",
                state: "",
                postcode: "",
            },
            { isEdit: false }
        );

        expect(Object.keys(errors).sort()).toEqual([
            "dateOfBirth",
            "firstName",
            "lastName",
            "phone",
            "postcode",
            "state",
            "street",
            "suburb",
        ]);
    });

    it("date of birth: 1900-01-01 up to today", () => {
        const dob = (dateOfBirth) => validatePerson({ ...person, dateOfBirth }, { isEdit: false }).dateOfBirth;

        expect(dob("1899-12-31")).toMatch(/1900/);
        expect(dob("1900-01-01")).toBeUndefined();
        expect(dob("2026-11-02")).toBeUndefined();
        expect(dob("2026-11-03")).toMatch(/future/);
    });

    it("phone needs 8 digits however it is written", () => {
        const phone = (value) => validatePerson({ ...person, phone: value }, { isEdit: false }).phone;

        expect(phone("1234567")).toBe("Phone number looks too short.");
        expect(phone("12345678")).toBeUndefined();
        expect(phone("+61 412 345 678")).toBeUndefined();
        expect(phone("04-12")).toBe("Phone number looks too short.");
    });

    it("postcode is 4 digits and state is an Australian one", () => {
        expect(validatePerson({ ...person, postcode: "123" }, { isEdit: false }).postcode).toBeTruthy();
        expect(validatePerson({ ...person, postcode: "12345" }, { isEdit: false }).postcode).toBeTruthy();
        expect(validatePerson({ ...person, state: "XX" }, { isEdit: false }).state).toBeTruthy();
    });

    it("names are limited to 100 characters", () => {
        expect(validatePerson({ ...person, firstName: "x".repeat(101) }, { isEdit: false }).firstName).toMatch(/100/);
    });

    it("checks email and country codes only when editing, and only if given", () => {
        expect(validatePerson({ ...person, email: "nope" }, { isEdit: false }).email).toBeUndefined();
        expect(validatePerson({ ...person, email: "nope" }, { isEdit: true }).email).toBeTruthy();
        expect(validatePerson({ ...person, email: "a@b.co" }, { isEdit: true }).email).toBeUndefined();
        expect(
            validatePerson({ ...person, citizenshipCountryCode: "AUS" }, { isEdit: true }).citizenshipCountryCode
        ).toBeTruthy();
        expect(
            validatePerson({ ...person, taxResidencyCountryCode: "nz" }, { isEdit: true }).taxResidencyCountryCode
        ).toBeUndefined();
    });
});

describe("validateDocument", () => {
    const check = (overrides = {}, extras = {}) =>
        validateDocument({ ...document, ...overrides }, { front: photo, back: photo, isSighted: true, ...extras });

    it("accepts a complete document", () => {
        expect(check()).toEqual({});
    });

    it("needs a type from CCP's list, and a description for Other", () => {
        expect(check({ documentType: "" }).documentType).toBeTruthy();
        expect(check({ documentType: "Birth certificate" }).documentType).toBeTruthy();
        expect(check({ documentType: "Other" }).documentTypeOther).toBeTruthy();
        expect(check({ documentType: "Other", documentTypeOther: "Student card" }, { back: null })).toEqual({});
    });

    it("needs number, issuer and a 2-letter country", () => {
        const errors = check({ documentNumber: " ", issuer: "", idCountryCode: "A" });

        expect(Object.keys(errors).sort()).toEqual(["documentNumber", "idCountryCode", "issuer"]);
        expect(check({ idCountryCode: "AUS" }).idCountryCode).toBeTruthy();
    });

    it("expiry: must be answered, dated when Yes, and not in the past", () => {
        expect(check({ hasExpiry: null }).hasExpiry).toBeTruthy();
        expect(check({ expiryDate: "" }).expiryDate).toMatch(/Enter the expiry/);
        expect(check({ expiryDate: "2026-11-01" }).expiryDate).toMatch(/has expired/);
        expect(check({ expiryDate: "2026-11-02" })).toEqual({});
        expect(check({ hasExpiry: false, expiryDate: "" })).toEqual({});
    });

    it("front photo is always required; back only for a driver licence", () => {
        expect(check({}, { front: null }).front).toBeTruthy();
        expect(check({}, { back: null }).back).toBeTruthy();
        expect(check({ documentType: "Passport" }, { back: null })).toEqual({});
    });

    it("the sighted box must be ticked", () => {
        expect(check({}, { isSighted: false }).isSighted).toBeTruthy();
    });
});

describe("payloads", () => {
    it("idPayload trims, upper-cases the country, and sends the expiry only when there is one", () => {
        expect(idPayload({ ...document, documentNumber: " 012 ", idCountryCode: "au" })).toEqual({
            documentType: "Driver licence",
            documentNumber: "012",
            issuer: "VIC",
            idCountryCode: "AU",
            hasExpiry: true,
            expiryDate: "2030-01-01",
        });
        expect(idPayload({ ...document, hasExpiry: false, expiryDate: "" })).not.toHaveProperty("expiryDate");
        expect(idPayload({ ...document, documentType: "Other", documentTypeOther: " Student card " })).toMatchObject({
            documentTypeOther: "Student card",
        });
    });

    it("changesFrom lists only changed fields, and the whole address when any part changed", () => {
        const initial = formFromCustomer({
            first_name: "Jane",
            last_name: "Citizen",
            date_of_birth: "1985-06-15",
            phone: "0412",
            res_street: "1 Test St",
            res_suburb: "Coburg",
            res_state: "VIC",
            res_postcode: "3058",
        });

        expect(changesFrom(initial, initial)).toEqual({});
        expect(changesFrom({ ...initial, lastName: " Smith ", suburb: "Brunswick" }, initial)).toEqual({
            lastName: "Smith",
            residentialAddress: { street: "1 Test St", suburb: "Brunswick", state: "VIC", postcode: "3058" },
        });
        expect(changesFrom({ ...initial, citizenshipCountryCode: "au" }, initial)).toEqual({
            citizenshipCountryCode: "AU",
        });
    });

    it("formFromCustomer turns nulls into empty strings", () => {
        expect(formFromCustomer({ first_name: "Jane", middle_name: null, gender: null }).middleName).toBe("");
        expect(formFromCustomer({ first_name: "Jane", gender: "F" }).gender).toBe("F");
    });
});

describe("documentFor (Update ID prefill)", () => {
    const current = {
        document_type: "Passport",
        document_number: "PA1",
        issuer: "AU",
        id_country_code: "AU",
        has_expiry: true,
        expiry_date: "2027-01-01",
    };

    it("renewed: the same document, but a new expiry is needed", () => {
        expect(documentFor("renewed", current)).toMatchObject({
            documentType: "Passport",
            documentNumber: "PA1",
            expiryDate: "",
        });
    });

    it("photo unclear: the same document and expiry", () => {
        expect(documentFor("photo_unclear", current)).toMatchObject({
            documentNumber: "PA1",
            expiryDate: "2027-01-01",
        });
    });

    it("different document, or no ID on file: blank", () => {
        expect(documentFor("different_document", current).documentNumber).toBe("");
        expect(documentFor("renewed", null).documentNumber).toBe("");
    });

    it("an ID type gold cannot photograph is left to choose again", () => {
        expect(documentFor("renewed", { ...current, document_type: "Birth certificate" }).documentType).toBe("");
    });
});

describe("formKeyFor", () => {
    it.each([
        ["residentialAddress.street", "street"],
        ["id.documentType", "documentType"],
        ["documentNumber", "documentNumber"],
        ["frontImage", "front"],
        ["backImage", "back"],
        ["changes", "form"],
    ])("%s -> %s", (server, local) => {
        expect(formKeyFor(server)).toBe(local);
    });
});
