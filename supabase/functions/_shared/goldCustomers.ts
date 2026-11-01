// Shared by gold-create-customer, gold-update-customer-id and gold-update-customer:
// input validation, multipart reading, and the customer ID photos. No client lookups happen
// here except the photo upload, so everything but storePhotos is pure.
//
// Nothing in this file logs. The inputs are names, phone numbers, dates of birth and ID numbers.

import { businessDate } from "./goldRules.js";

export const STORAGE_BUCKET = "compliance-media";
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // the bucket's own limit
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** CCP's ID types for a photographed document (the electronic-source type has no photo). */
export const DOCUMENT_TYPES = [
  "Driver licence",
  "Passport",
  "Proof of age card",
  "National identity card",
  "Medicare card",
  "Other government document",
  "Other",
];
/** Mirrors BACK_REQUIRED_TYPES in IdVerificationPage.jsx. */
export const BACK_REQUIRED_TYPES = new Set(["Driver licence"]);
export const AU_STATES = ["VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

const MAX_TEXT = 100; // names, address lines, issuer
const MAX_DOCUMENT_NUMBER = 100; // AUSTRAC IdNumber maxLength, as complete-transaction enforces
const EARLIEST_DOB = "1900-01-01";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS = ["M", "F", "U"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS_HEADERS });

export type Fields = Record<string, string>;

export const validationFailed = (fields: Fields): Response => json({ error: "validation_failed", fields }, 400);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Small readers: each returns the cleaned value and records a message when it is wrong ────

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** A trimmed string, or "" when absent or not a string. */
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function required(fields: Fields, key: string, v: unknown, label: string, max = MAX_TEXT): string {
  const s = text(v);
  if (!s) fields[key] = `Enter ${label}.`;
  else if (s.length > max) fields[key] = `${label[0].toUpperCase()}${label.slice(1)} must be ${max} characters or fewer.`;
  return s;
}

function optional(fields: Fields, key: string, v: unknown, label: string, max = MAX_TEXT): string | null {
  const s = text(v);
  if (!s) return null;
  if (s.length > max) fields[key] = `${label[0].toUpperCase()}${label.slice(1)} must be ${max} characters or fewer.`;
  return s;
}

/** A real calendar date written YYYY-MM-DD. */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function dateOfBirth(fields: Fields, key: string, v: unknown): string {
  const s = text(v);
  if (!isCalendarDate(s)) fields[key] = "Enter the date of birth as a real date.";
  else if (s < EARLIEST_DOB) fields[key] = "Date of birth looks too early. Check the year.";
  else if (s > businessDate()) fields[key] = "Date of birth can't be in the future.";
  return s;
}

/** 8 or more digits, as gold.purchases.phone and the update_customer_phone RPC require. */
export function phoneDigits(s: string): number {
  return s.replace(/\D/g, "").length;
}

function phone(fields: Fields, key: string, v: unknown): string {
  const s = required(fields, key, v, "a phone number", 30);
  if (s && !fields[key] && phoneDigits(s) < 8) fields[key] = "Phone number needs at least 8 digits.";
  return s;
}

function email(fields: Fields, key: string, v: unknown): string | null {
  const s = optional(fields, key, v, "email", 200);
  if (s && !fields[key] && !EMAIL_RE.test(s)) fields[key] = "Enter a valid email address.";
  return s;
}

export interface Address {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
}

function address(fields: Fields, key: string, v: unknown): Address {
  const a = isObject(v) ? v : {};
  const sub: Fields = {};
  const street = required(sub, "street", a.street, "the street address");
  const suburb = required(sub, "suburb", a.suburb, "the suburb");
  const state = text(a.state).toUpperCase();
  if (!AU_STATES.includes(state)) sub.state = "Choose the state or territory.";
  const postcode = text(a.postcode);
  if (!/^\d{4}$/.test(postcode)) sub.postcode = "Postcode must be 4 digits.";
  for (const [k, msg] of Object.entries(sub)) fields[`${key}.${k}`] = msg;
  return { street, suburb, state, postcode };
}

const countryCode = (fields: Fields, key: string, v: unknown, mandatory: boolean): string | null => {
  const s = text(v).toUpperCase();
  if (!s) {
    if (mandatory) fields[key] = "Choose the country that issued the ID.";
    return null;
  }
  if (!/^[A-Z]{2}$/.test(s)) fields[key] = "Use a 2-letter country code, for example AU.";
  return s;
};

// ─── The ID document ────────────────────────────────────────────────────────────────────────

export interface DocumentInput {
  document_type: string;
  document_type_other: string | null;
  document_number: string;
  issuer: string;
  id_country_code: string;
  has_expiry: boolean;
  expiry_date: string | null;
}

/** Validates the `id` object of gold-create-customer and the document fields of gold-update-customer-id. */
export function validateDocument(fields: Fields, v: unknown, prefix = "id."): DocumentInput {
  const d = isObject(v) ? v : {};
  const k = (name: string) => `${prefix}${name}`;

  const documentType = text(d.documentType);
  if (!DOCUMENT_TYPES.includes(documentType)) fields[k("documentType")] = "Choose the type of ID.";
  let other: string | null = null;
  if (documentType === "Other") other = required(fields, k("documentTypeOther"), d.documentTypeOther, "a description of the document");

  const documentNumber = required(fields, k("documentNumber"), d.documentNumber, "the ID number", MAX_DOCUMENT_NUMBER);
  const issuer = required(fields, k("issuer"), d.issuer, "the issuer (state or authority)");
  const idCountry = countryCode(fields, k("idCountryCode"), d.idCountryCode, true);

  let hasExpiry = false;
  let expiry: string | null = null;
  if (typeof d.hasExpiry !== "boolean") fields[k("hasExpiry")] = "Say whether the ID has an expiry date.";
  else {
    hasExpiry = d.hasExpiry;
    if (hasExpiry) {
      expiry = text(d.expiryDate);
      if (!isCalendarDate(expiry)) fields[k("expiryDate")] = "Enter the expiry date as a real date.";
    }
  }

  return {
    document_type: documentType,
    document_type_other: other,
    document_number: documentNumber,
    issuer,
    id_country_code: idCountry ?? "",
    has_expiry: hasExpiry,
    expiry_date: expiry,
  };
}

// ─── gold-create-customer input ─────────────────────────────────────────────────────────────

export interface NewCustomerInput {
  customer: Record<string, string | null>;
  aliases: string[];
  document: DocumentInput;
  confirmNew: boolean;
  differentPerson: boolean;
}

export function validateNewCustomer(raw: unknown, fields: Fields): NewCustomerInput {
  const p = isObject(raw) ? raw : {};
  const first = required(fields, "firstName", p.firstName, "the first name");
  const middle = optional(fields, "middleName", p.middleName, "middle name");
  const last = required(fields, "lastName", p.lastName, "the last name");
  const dob = dateOfBirth(fields, "dateOfBirth", p.dateOfBirth);
  const phoneValue = phone(fields, "phone", p.phone);
  const emailValue = email(fields, "email", p.email);
  const res = address(fields, "residentialAddress", p.residentialAddress);

  const aliases: string[] = [];
  if (p.aliases !== undefined && !Array.isArray(p.aliases)) fields.aliases = "Aliases must be a list.";
  else {
    for (const a of (p.aliases ?? []) as unknown[]) {
      const s = text(a);
      if (s.length > MAX_TEXT) fields.aliases = `Each alias must be ${MAX_TEXT} characters or fewer.`;
      else if (s) aliases.push(s);
    }
  }

  return {
    customer: {
      first_name: first,
      middle_name: middle,
      last_name: last,
      date_of_birth: dob,
      phone: phoneValue,
      email: emailValue,
      res_street: res.street,
      res_suburb: res.suburb,
      res_state: res.state,
      res_postcode: res.postcode,
      res_country: "Australia",
    },
    aliases,
    document: validateDocument(fields, p.id),
    confirmNew: p.confirmNew === true,
    differentPerson: p.differentPerson === true,
  };
}

// ─── gold-update-customer input ─────────────────────────────────────────────────────────────

/**
 * Profile fields a manager may correct, as the API names them, with the column each sets.
 * ID details are not here: they change only through gold-update-customer-id.
 */
export const EDITABLE: Record<string, string> = {
  firstName: "first_name",
  middleName: "middle_name",
  lastName: "last_name",
  dateOfBirth: "date_of_birth",
  gender: "gender",
  phone: "phone",
  email: "email",
  occupation: "occupation",
  residentialAddress: "res_*",
  citizenshipCountryCode: "citizenship_country_code",
  taxResidencyCountryCode: "tax_residency_country_code",
};

/** Returns the column -> new value map for the SQL function. Required fields cannot be cleared. */
export function validateChanges(raw: unknown, fields: Fields): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    fields.changes = "Change at least one field.";
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(EDITABLE, key)) fields[key] = "This field can't be changed here.";
  }
  const c = raw as Raw;
  if ("firstName" in c) out.first_name = required(fields, "firstName", c.firstName, "the first name");
  if ("middleName" in c) out.middle_name = optional(fields, "middleName", c.middleName, "middle name");
  if ("lastName" in c) out.last_name = required(fields, "lastName", c.lastName, "the last name");
  if ("dateOfBirth" in c) out.date_of_birth = dateOfBirth(fields, "dateOfBirth", c.dateOfBirth);
  if ("gender" in c) {
    const g = text(c.gender).toUpperCase();
    if (g && !GENDERS.includes(g)) fields.gender = "Choose M, F or U.";
    out.gender = g || null;
  }
  if ("phone" in c) out.phone = phone(fields, "phone", c.phone);
  if ("email" in c) out.email = email(fields, "email", c.email);
  if ("occupation" in c) out.occupation = optional(fields, "occupation", c.occupation, "occupation");
  if ("residentialAddress" in c) {
    const a = address(fields, "residentialAddress", c.residentialAddress);
    Object.assign(out, {
      res_street: a.street,
      res_suburb: a.suburb,
      res_state: a.state,
      res_postcode: a.postcode,
      res_country: "Australia",
    });
  }
  if ("citizenshipCountryCode" in c) out.citizenship_country_code = countryCode(fields, "citizenshipCountryCode", c.citizenshipCountryCode, false);
  if ("taxResidencyCountryCode" in c) out.tax_residency_country_code = countryCode(fields, "taxResidencyCountryCode", c.taxResidencyCountryCode, false);
  return out;
}

// ─── Reading the request ────────────────────────────────────────────────────────────────────

export interface Photos {
  front: File | null;
  back: File | null;
}

/** The multipart body: a JSON `payload` field plus optional `front` and `back` image files. */
export async function readMultipart(req: Request): Promise<{ payload: unknown; photos: Photos } | null> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    const raw = form.get("payload");
    payload = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  const file = (name: string) => {
    const f = form.get(name);
    return f instanceof File ? f : null;
  };
  return { payload, photos: { front: file("front"), back: file("back") } };
}

/** Checks the photos against the document type: front always, back for a driver licence. */
export function validatePhotos(fields: Fields, documentType: string, photos: Photos): void {
  const check = (key: string, f: File | null, mandatory: boolean) => {
    if (!f) {
      if (mandatory) fields[key] = key === "frontImage" ? "Add a photo of the front of the ID." : "Add a photo of the back of the ID.";
      return;
    }
    if (!(f.type in PHOTO_TYPES)) fields[key] = "Photo must be a JPEG, PNG or WebP image.";
    else if (f.size === 0) fields[key] = "Photo is empty. Take it again.";
    else if (f.size > MAX_PHOTO_BYTES) fields[key] = "Photo must be 10 MB or smaller.";
  };
  check("frontImage", photos.front, true);
  check("backImage", photos.back, BACK_REQUIRED_TYPES.has(documentType));
}

// ─── Photos ─────────────────────────────────────────────────────────────────────────────────

export interface StoredPhoto {
  side: "front" | "back";
  object_path: string;
  content_hash_sha256: string;
  content_type: string;
  byte_size: number;
}

// Loosely typed, like upload-id-image: only storage.from().upload/remove is used.
// deno-lint-ignore no-explicit-any
type StorageClient = any;

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Hashes (SHA-256) and uploads the photos under customers/{customerId}/{verificationId}/.
 * Every path is new, so nothing is ever overwritten. Returns null if an upload failed, after
 * removing the ones already stored.
 */
export async function storePhotos(
  admin: StorageClient,
  customerId: string,
  verificationId: string,
  photos: Photos,
): Promise<StoredPhoto[] | null> {
  const stored: StoredPhoto[] = [];
  for (const side of ["front", "back"] as const) {
    const file = photos[side];
    if (!file) continue;
    const bytes = await file.arrayBuffer();
    const path = `customers/${customerId}/${verificationId}/${side}-${crypto.randomUUID()}.${PHOTO_TYPES[file.type]}`;
    const { error } = await admin.storage.from(STORAGE_BUCKET).upload(path, bytes, {
      contentType: file.type,
      upsert: false,
    });
    if (error) {
      console.error("photo upload failed", { code: (error as { statusCode?: string }).statusCode ?? "unknown" });
      await removePhotos(admin, stored);
      return null;
    }
    stored.push({
      side,
      object_path: path,
      content_hash_sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
      content_type: file.type,
      byte_size: file.size,
    });
  }
  return stored;
}

/**
 * Best-effort removal of photos uploaded for a save that then failed. If the removal itself
 * fails the object stays: it has no stored_images row, so reconcile-stored-images deletes it
 * as an orphan once it is older than its one-hour grace period.
 */
export async function removePhotos(admin: StorageClient, photos: StoredPhoto[]): Promise<void> {
  if (photos.length === 0) return;
  const { error } = await admin.storage.from(STORAGE_BUCKET).remove(photos.map((p) => p.object_path));
  if (error) console.error("orphan photo removal failed; left for reconcile-stored-images");
}

// ─── Collision owner ────────────────────────────────────────────────────────────────────────

/** A row of get_verification_for_document, as the 409 id_on_file response shows its owner. */
export function ownerOf(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  return {
    customerId: (row.customer_id as string | null) ?? null,
    kind: row.owner_kind,
    name: row.owner_name ?? null,
    dateOfBirth: row.owner_dob ?? null,
    documentType: row.document_type,
    capturedAt: row.created_at,
    transactionRef: row.transaction_ref ?? null,
  };
}
