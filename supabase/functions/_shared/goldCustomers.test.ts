import { assert, assertEquals } from "std/assert";
import { businessDate } from "./goldRules.js";
import {
  isCalendarDate,
  validateChanges,
  validateDocument,
  validateNewCustomer,
  validatePhotos,
} from "./goldCustomers.ts";
import type { Fields } from "./goldCustomers.ts";

const ID = {
  documentType: "Passport",
  documentNumber: "PA1234567",
  issuer: "Australia",
  idCountryCode: "AU",
  hasExpiry: true,
  expiryDate: "2031-05-01",
};

const NEW = {
  firstName: "Jane",
  lastName: "Citizen",
  dateOfBirth: "1990-04-02",
  phone: "0412 345 678",
  residentialAddress: { street: "1 Test St", suburb: "Coburg", state: "VIC", postcode: "3058" },
  id: ID,
};

const fieldsOf = (raw: unknown) => {
  const fields: Fields = {};
  validateNewCustomer(raw, fields);
  return fields;
};

const photo = (type = "image/jpeg", size = 4) => new File([new Uint8Array(size)], "p", { type });

Deno.test("a complete new customer has no field errors", () => {
  assertEquals(fieldsOf(NEW), {});
});

Deno.test("phone: 7 digits is refused, 8 is accepted, punctuation does not count", () => {
  assertEquals(fieldsOf({ ...NEW, phone: "1234567" }).phone, "Phone number needs at least 8 digits.");
  assertEquals(fieldsOf({ ...NEW, phone: "+61 (3) 9123-4567" }), {});
  assertEquals(fieldsOf({ ...NEW, phone: "12345678" }), {});
  assertEquals(fieldsOf({ ...NEW, phone: "12-34-56-7" }).phone, "Phone number needs at least 8 digits.");
  assert(fieldsOf({ ...NEW, phone: "" }).phone);
});

Deno.test("names: required, trimmed, 100 characters at most", () => {
  assert(fieldsOf({ ...NEW, firstName: "  " }).firstName);
  assert(fieldsOf({ ...NEW, lastName: "" }).lastName);
  assertEquals(fieldsOf({ ...NEW, firstName: "a".repeat(100) }), {});
  assert(fieldsOf({ ...NEW, firstName: "a".repeat(101) }).firstName);
  assert(fieldsOf({ ...NEW, middleName: "a".repeat(101) }).middleName);
});

Deno.test("date of birth: real date, 1900-01-01 to today in Melbourne", () => {
  const today = businessDate();
  assertEquals(fieldsOf({ ...NEW, dateOfBirth: today }), {});
  assertEquals(fieldsOf({ ...NEW, dateOfBirth: "1900-01-01" }), {});
  assert(fieldsOf({ ...NEW, dateOfBirth: "1899-12-31" }).dateOfBirth);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  assertEquals(fieldsOf({ ...NEW, dateOfBirth: tomorrow }).dateOfBirth, "Date of birth can't be in the future.");
  assert(fieldsOf({ ...NEW, dateOfBirth: "1990-02-30" }).dateOfBirth);
  assert(fieldsOf({ ...NEW, dateOfBirth: "02/04/1990" }).dateOfBirth);
  assert(isCalendarDate("2024-02-29"));
  assert(!isCalendarDate("2023-02-29"));
});

Deno.test("residential address: street, suburb, a real state, 4-digit postcode", () => {
  const addr = NEW.residentialAddress;
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, street: "" } })["residentialAddress.street"]);
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, suburb: "" } })["residentialAddress.suburb"]);
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, state: "XX" } })["residentialAddress.state"]);
  assertEquals(fieldsOf({ ...NEW, residentialAddress: { ...addr, state: "nt" } }), {});
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, postcode: "305" } })["residentialAddress.postcode"]);
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, postcode: "30580" } })["residentialAddress.postcode"]);
  assert(fieldsOf({ ...NEW, residentialAddress: { ...addr, postcode: "30A8" } })["residentialAddress.postcode"]);
  assert(fieldsOf({ ...NEW, residentialAddress: undefined })["residentialAddress.street"]);
});

Deno.test("email is optional but must look like an address when given", () => {
  assertEquals(fieldsOf({ ...NEW, email: "" }), {});
  assertEquals(fieldsOf({ ...NEW, email: "jane@example.test" }), {});
  assert(fieldsOf({ ...NEW, email: "jane@" }).email);
});

Deno.test("aliases: blanks are dropped", () => {
  const fields: Fields = {};
  const out = validateNewCustomer({ ...NEW, aliases: ["Janey", " ", "J. Citizen"] }, fields);
  assertEquals(fields, {});
  assertEquals(out.aliases, ["Janey", "J. Citizen"]);
  assert(fieldsOf({ ...NEW, aliases: "Janey" }).aliases);
});

Deno.test("ID: type, number (100 max), issuer, 2-letter country, expiry follows hasExpiry", () => {
  const f = (id: Record<string, unknown>) => {
    const fields: Fields = {};
    validateDocument(fields, id);
    return fields;
  };
  assertEquals(f(ID), {});
  assert(f({ ...ID, documentType: "Birth certificate" })["id.documentType"]);
  assert(f({ ...ID, documentType: "Electronic verification source" })["id.documentType"]);
  assert(f({ ...ID, documentType: "Other" })["id.documentTypeOther"]);
  assertEquals(f({ ...ID, documentType: "Other", documentTypeOther: "Student card" }), {});
  assert(f({ ...ID, documentNumber: " " })["id.documentNumber"]);
  assertEquals(f({ ...ID, documentNumber: "9".repeat(100) }), {});
  assert(f({ ...ID, documentNumber: "9".repeat(101) })["id.documentNumber"]);
  assert(f({ ...ID, issuer: "" })["id.issuer"]);
  assert(f({ ...ID, idCountryCode: "" })["id.idCountryCode"]);
  assert(f({ ...ID, idCountryCode: "AUS" })["id.idCountryCode"]);
  assertEquals(f({ ...ID, idCountryCode: "au" }), {});
  assert(f({ ...ID, hasExpiry: undefined })["id.hasExpiry"]);
  assert(f({ ...ID, hasExpiry: true, expiryDate: "" })["id.expiryDate"]);
  assert(f({ ...ID, hasExpiry: true, expiryDate: "2031-13-01" })["id.expiryDate"]);
  assertEquals(f({ ...ID, hasExpiry: false, expiryDate: undefined }), {});
});

Deno.test("hasExpiry false stores no expiry date even if one is sent", () => {
  const fields: Fields = {};
  const doc = validateDocument(fields, { ...ID, hasExpiry: false, expiryDate: "2031-05-01" });
  assertEquals(doc.has_expiry, false);
  assertEquals(doc.expiry_date, null);
});

Deno.test("photos: front always, back only for a driver licence, type and size limits", () => {
  const check = (type: string, front: File | null, back: File | null) => {
    const fields: Fields = {};
    validatePhotos(fields, type, { front, back });
    return fields;
  };
  assertEquals(check("Passport", photo(), null), {});
  assert(check("Passport", null, null).frontImage);
  assert(check("Driver licence", photo(), null).backImage);
  assertEquals(check("Driver licence", photo(), photo("image/png")), {});
  assertEquals(check("Medicare card", photo(), photo("image/webp")), {});
  assert(check("Passport", photo("application/pdf"), null).frontImage);
  assert(check("Passport", photo("image/jpeg", 0), null).frontImage);
  assertEquals(check("Passport", photo("image/jpeg", 10 * 1024 * 1024), null), {});
  assert(check("Passport", photo("image/jpeg", 10 * 1024 * 1024 + 1), null).frontImage);
  assert(check("Passport", photo(), photo("text/plain")).backImage);
});

Deno.test("edit: only profile fields; ID details and ownership are refused", () => {
  const fields: Fields = {};
  validateChanges({ documentNumber: "X1", reportingEntityId: "e", source: "ttr", firstName: "Jo" }, fields);
  assertEquals(Object.keys(fields).sort(), ["documentNumber", "reportingEntityId", "source"]);
});

Deno.test("edit: maps to columns, clears optional fields, never clears required ones", () => {
  const fields: Fields = {};
  const out = validateChanges(
    { firstName: "Jo", middleName: "", email: "", gender: "f", citizenshipCountryCode: "nz", phone: "0412 345 678" },
    fields,
  );
  assertEquals(fields, {});
  assertEquals(out, {
    first_name: "Jo",
    middle_name: null,
    email: null,
    gender: "F",
    citizenship_country_code: "NZ",
    phone: "0412 345 678",
  });
  const bad: Fields = {};
  validateChanges({ firstName: "", lastName: " ", phone: "1234567", dateOfBirth: "2999-01-01", gender: "X" }, bad);
  assertEquals(Object.keys(bad).sort(), ["dateOfBirth", "firstName", "gender", "lastName", "phone"]);
});

Deno.test("edit: an address replaces the whole address and needs every part", () => {
  const fields: Fields = {};
  const out = validateChanges({ residentialAddress: { street: "2 New St", suburb: "Brunswick", state: "VIC", postcode: "3056" } }, fields);
  assertEquals(fields, {});
  assertEquals(out, {
    res_street: "2 New St",
    res_suburb: "Brunswick",
    res_state: "VIC",
    res_postcode: "3056",
    res_country: "Australia",
  });
  const bad: Fields = {};
  validateChanges({ residentialAddress: { street: "2 New St" } }, bad);
  assertEquals(Object.keys(bad).sort(), ["residentialAddress.postcode", "residentialAddress.state", "residentialAddress.suburb"]);
});

Deno.test("edit: inherited object keys are not editable fields", () => {
  const fields: Fields = {};
  validateChanges(JSON.parse('{"constructor": "x", "toString": "x", "__proto__": "x"}'), fields);
  assertEquals(Object.keys(fields).sort(), ["__proto__", "constructor", "toString"]);
});

Deno.test("edit: an empty change set is refused", () => {
  for (const raw of [undefined, {}, []]) {
    const fields: Fields = {};
    validateChanges(raw, fields);
    assert(fields.changes);
  }
});
