import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supersedeImages } from "../_shared/supersede.ts";
import type { StorageOwner, SupabaseSchema } from "../_shared/supersede.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TTR_THRESHOLD_AUD = 10_000;
const AUSTRAC_MIN_DATE = new Date("2000-01-01T00:00:00Z");
const STORAGE_BUCKET = "compliance-media";
const MAX_DOCUMENT_NUMBER_LENGTH = 100; // AUSTRAC IdNumber type maxLength
const MAX_NAME_LENGTH = 140; // AUSTRAC Name type maxLength
const MAX_SUBURB_LENGTH = 35; // AUSTRAC Address.suburb maxLength
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface ValidationError {
  field: string;
  message: string;
  partyId?: string;
}

// Structural types covering only what supersedePriorImages calls, so the Deno tests can
// pass plain fakes rather than constructing a real Supabase client. Written as a
// self-referential thenable because that is the shape PostgrestFilterBuilder has —
// every method returns the builder, and awaiting it yields { data, error }.
// StorageOwner / SupabaseSchema / FilterBuilder now live in _shared/supersede.ts,
// re-exported here so existing importers and tests keep working unchanged.
export type { FilterBuilder, StorageOwner, SupabaseSchema } from "../_shared/supersede.ts";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const ttr = serviceClient.schema("ttr");
  const anonTtr = anonClient.schema("ttr");

  // 1. Verify JWT and get the caller's staff_member_id
  const { data: { user }, error: userError } = await anonClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid or expired token" }, 401);
  const staffMemberId = user.id;

  // 2. Verify the staff member is active
  const { data: staff, error: staffError } = await serviceClient
    .from("staff_members")
    .select("is_active, reporting_entity_id")
    .eq("id", staffMemberId)
    .single();

  if (staffError || !staff || !staff.is_active) {
    return json({ error: "Staff member is not active" }, 401);
  }

  // 3. Parse request body
  let transactionId: string;
  try {
    const body = await req.json();
    transactionId = body.transactionId;
    if (!transactionId) throw new Error("missing transactionId");
  } catch {
    return json({ error: "Request body must contain transactionId" }, 400);
  }

  // 4. Load transaction — RLS on anonClient enforces entity ownership
  const { data: tx, error: txError } = await anonTtr
    .from("transactions")
    .select("id, status, scenario, aud_value, transaction_datetime, transaction_ref, designated_service, reporting_entity_id, lpp_flag, is_other_ds_provider_involved")
    .eq("id", transactionId)
    .single();

  if (txError || !tx) return json({ error: "Transaction not found" }, 404);
  if (tx.status === "complete") return json({ error: "Transaction is already complete" }, 409);

  // 4b. Load reporting entity (needed for AAN validation)
  const { data: entity } = await serviceClient
    .from("reporting_entities")
    .select("austrac_account_number")
    .eq("id", tx.reporting_entity_id as string)
    .single();

  // 5. Load all child records via service client to avoid RLS permission gaps during validation
  const [
    { data: parties },
    { data: conductingPersons },
    { data: idVerifications },
    { data: recipientDeliveries },
    { data: bullionItems },
    { data: preciousMetalItems },
  ] = await Promise.all([
    ttr.from("parties").select("*").eq("transaction_id", transactionId),
    ttr.from("conducting_persons").select("*").eq("transaction_id", transactionId),
    ttr.from("id_verifications").select("*").eq("transaction_id", transactionId),
    ttr.from("recipient_deliveries").select("*").eq("transaction_id", transactionId),
    ttr.from("bullion_items").select("*").eq("transaction_id", transactionId),
    ttr.from("precious_metal_items").select("*").eq("transaction_id", transactionId),
  ]);

  // 6. Validate — collect all errors before returning
  const errors: ValidationError[] = [];

  validateTransaction(tx, entity, errors);
  validateParties(parties ?? [], errors);
  validateConductingPersons(conductingPersons ?? [], errors);
  await validateIdVerifications(
    idVerifications ?? [],
    parties ?? [],
    conductingPersons ?? [],
    errors,
    ttr,
    tx.reporting_entity_id as string,
  );
  validateRecipientDelivery(recipientDeliveries ?? [], errors);
  if ((tx.scenario as string)?.startsWith("precious_metal")) {
    validatePreciousMetalItems(preciousMetalItems ?? [], errors);
  } else {
    validateBullionItems(bullionItems ?? [], errors);
  }

  if (errors.length > 0) return json({ errors }, 422);

  // 7. Call atomic RPC — inserts audit log + updates status in one DB transaction
  const { error: rpcError } = await ttr.rpc("complete_transaction", {
    p_transaction_id: transactionId,
    p_staff_member_id: staffMemberId,
  });

  if (rpcError) {
    // The RPC raises a specific exception text for race conditions (already complete)
    if (rpcError.message?.includes("is not a draft")) {
      return json({ error: "Transaction is already complete (concurrent request)" }, 409);
    }
    if (rpcError.message?.includes("not authorised")) {
      return json({ error: "Staff member is not authorised for this transaction" }, 403);
    }
    console.error("complete_transaction RPC error:", rpcError);
    return json({ error: "Unexpected database error" }, 500);
  }

  // 8. Enforce "one copy of your identification on file" (privacy policy §3).
  // Deliberately after the RPC and deliberately non-fatal — see supersedePriorImages.
  // Cast: supersedePriorImages is typed against a minimal structural interface so the
  // Deno tests can pass fakes. Postgrest's generics are too deep for TS to prove the
  // real client satisfies it, though it does at runtime.
  await supersedePriorImages(
    serviceClient as unknown as StorageOwner,
    ttr as unknown as SupabaseSchema,
    idVerifications ?? [],
    tx.reporting_entity_id as string,
  );

  // 9. Return completed_at from the freshly updated row
  const { data: completed } = await ttr
    .from("transactions")
    .select("completed_at")
    .eq("id", transactionId)
    .single();

  return json({ completed: true, completedAt: completed?.completed_at }, 200);
}

// ─── One copy of ID on file ───────────────────────────────────────────────────

// A linked re-capture ('stored_copy_unclear' or 'id_changed') photographs a document
// already held. uq_idv_doc_new_capture keeps that honest at the ROW level, but nothing
// stopped the images accumulating — UAT finding #9 found one licence carrying four
// stored pairs, while the UI told staff each re-capture "replaces" the copy on file and
// privacy policy §3 told customers we do not take "a new copy for every visit".
//
// So once the transaction is real, delete the superseded OBJECTS and leave their
// metadata rows behind carrying superseded_at / superseded_by_image_id. AML/CTF requires
// identification records be retained for seven years; the retained row still proves a
// document was sighted, by whom, when, and what it hashed to. The image itself is gone,
// which is what §3 actually promises.
//
// Runs after complete_transaction and never fails the request. A storage hiccup must not
// undo a completed legal record — the transaction is the thing that matters, and an
// un-superseded image is a tidiness problem that a later run resolves.
export async function supersedePriorImages(
  serviceClient: StorageOwner,
  ttr: SupabaseSchema,
  idVerifications: Record<string, unknown>[],
  reportingEntityId: string,
): Promise<void> {
  const linkedRecaptures = idVerifications.filter(
    (v) =>
      v.verification_basis === "new_capture" &&
      v.prior_verification_id &&
      (v.front_image_id || v.back_image_id),
  );
  if (linkedRecaptures.length === 0) return;

  for (const recapture of linkedRecaptures) {
    try {
      const docType = recapture.document_type as string;
      const docNumber = ((recapture.document_number as string) ?? "").trim().toUpperCase();
      const keepIds = [recapture.front_image_id, recapture.back_image_id].filter(Boolean);
      // The chain root: every linked re-capture points at the UNLINKED row for its
      // document, because that is the only row get_verification_for_document returns.
      const rootId = recapture.prior_verification_id as string;

      const { data: siblings, error: siblingError } = await ttr
        .from("id_verifications")
        .select("id, front_image_id, back_image_id, document_number, prior_verification_id")
        .eq("reporting_entity_id", reportingEntityId)
        .eq("document_type", docType);

      if (siblingError) {
        console.error("supersede: sibling lookup failed", siblingError);
        continue;
      }

      // Group by CHAIN ROOT, not by document number alone.
      //
      // Document numbers are unique per state, not nationally, so two unrelated people can
      // hold the same one — which is exactly what the 'different_person' reason records.
      // Grouping on the number alone (the key uq_idv_doc_new_capture uses) swept those in,
      // so completing one customer's renewal deleted a DIFFERENT customer's ID images.
      // That key answers "may a second unlinked row exist"; it must not decide "may this
      // image be destroyed", because the index deliberately exempts 'different_person'.
      //
      // The root is person-safe by construction: a 'different_person' capture is always
      // unlinked, so it is its own root and can never share one with somebody else's
      // chain — and check_idv_recapture_link() rejects any link whose target belongs to a
      // different person, so a chain cannot span two people either.
      //
      // Note this cannot be chain-FOLLOWING from the new row instead. Two re-captures of
      // one document both link to the same root rather than to each other, so following
      // only this row's link would leave the other's images live — two copies on file,
      // which is the thing §3 forbids.
      //
      // The document-number check below is now redundant (the trigger guarantees a link
      // targets the same document) and kept as a cheap backstop.
      const staleIds = (siblings ?? [])
        .filter((s) => ((s.prior_verification_id as string | null) ?? s.id) === rootId)
        .filter((s) => ((s.document_number as string) ?? "").trim().toUpperCase() === docNumber)
        .flatMap((s) => [s.front_image_id, s.back_image_id])
        .filter((id): id is string => Boolean(id) && !keepIds.includes(id));

      if (staleIds.length === 0) continue;

      // The delete-then-stamp step is shared with reconcile-stored-images, so a swept
      // duplicate is handled identically to one caught at completion time. Only the
      // selection above differs — and selection is where the danger is.
      const replacement = (recapture.front_image_id ?? recapture.back_image_id) as string;
      await supersedeImages(serviceClient, ttr, staleIds, replacement);
    } catch (err) {
      console.error("supersede: unexpected error, continuing", err);
    }
  }
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export function validateTransaction(
  tx: Record<string, unknown>,
  entity: Record<string, unknown> | null,
  errors: ValidationError[],
) {
  if (typeof tx.aud_value !== "number" || tx.aud_value < TTR_THRESHOLD_AUD) {
    errors.push({ field: "aud_value", message: `AUD value must be at least $${TTR_THRESHOLD_AUD}` });
  }
  if (!tx.transaction_datetime) {
    errors.push({ field: "transaction_datetime", message: "Transaction date/time is required" });
  } else if (new Date(tx.transaction_datetime as string) < AUSTRAC_MIN_DATE) {
    // AUSTRAC Date type minimum — TTR-1-0 rejects dates before 2000-01-01.
    errors.push({ field: "transaction_datetime", message: "Transaction date must be on or after 2000-01-01" });
  }
  if (!tx.transaction_ref) {
    errors.push({ field: "transaction_ref", message: "Transaction reference is required" });
  }
  if (!tx.designated_service) {
    errors.push({ field: "designated_service", message: "Designated service is required" });
  }
  // TTR-1-0: AAN must be exactly 9 digits
  const aan = entity?.austrac_account_number as string | null;
  if (!aan || !/^[0-9]{9}$/.test(aan)) {
    errors.push({ field: "austrac_account_number", message: "AUSTRAC account number must be exactly 9 digits" });
  }
}

export function validateParties(parties: Record<string, unknown>[], errors: ValidationError[]) {
  if (parties.length === 0) {
    errors.push({ field: "parties", message: "At least one party is required" });
    return;
  }
  for (const p of parties) {
    const pid = p.id as string;
    if (p.party_type === "individual") {
      if (!p.first_name) errors.push({ field: "first_name", message: "First name is required", partyId: pid });
      if (!p.last_name)  errors.push({ field: "last_name",  message: "Last name is required",  partyId: pid });
      if (p.full_name && (p.full_name as string).length > MAX_NAME_LENGTH) {
        errors.push({ field: "full_name", message: `Full name must be ${MAX_NAME_LENGTH} characters or fewer`, partyId: pid });
      }
      if (!p.date_of_birth) errors.push({ field: "date_of_birth", message: "Date of birth is required", partyId: pid });
      if (!p.res_street)   errors.push({ field: "res_street",   message: "Street address is required", partyId: pid });
      if (!p.res_suburb) {
        errors.push({ field: "res_suburb", message: "Suburb is required", partyId: pid });
      } else if ((p.res_suburb as string).length > MAX_SUBURB_LENGTH) {
        errors.push({ field: "res_suburb", message: `Suburb must be ${MAX_SUBURB_LENGTH} characters or fewer`, partyId: pid });
      }
      if (!p.res_state)    errors.push({ field: "res_state",    message: "State is required",           partyId: pid });
      if (!p.res_postcode) errors.push({ field: "res_postcode", message: "Postcode is required",        partyId: pid });
      if (!p.phone && !p.email) {
        errors.push({ field: "phone", message: "Phone or email is required", partyId: pid });
      }
      if (!p.occupation) errors.push({ field: "occupation", message: "Occupation is required", partyId: pid });
      // TTR-1-0 IndividualDetails
      if (!p.gender) errors.push({ field: "gender", message: "Gender is required", partyId: pid });
      if (!p.citizenship_country_code) errors.push({ field: "citizenship_country_code", message: "Citizenship country code is required", partyId: pid });
      if (!p.tax_residency_country_code) errors.push({ field: "tax_residency_country_code", message: "Tax residency country code is required", partyId: pid });
    } else if (p.party_type === "company") {
      if (!p.entity_name) {
        errors.push({ field: "entity_name", message: "Entity name is required", partyId: pid });
      } else if ((p.entity_name as string).length > MAX_NAME_LENGTH) {
        errors.push({ field: "entity_name", message: `Entity name must be ${MAX_NAME_LENGTH} characters or fewer`, partyId: pid });
      }
      if (!p.reg_identifier)    errors.push({ field: "reg_identifier",    message: "Registration ID is required",     partyId: pid });
      if (!p.reg_id_type)       errors.push({ field: "reg_id_type",       message: "Registration ID type is required", partyId: pid });
      if (!p.biz_street)        errors.push({ field: "biz_street",        message: "Business street is required",     partyId: pid });
      if (!p.biz_suburb) {
        errors.push({ field: "biz_suburb", message: "Business suburb is required", partyId: pid });
      } else if ((p.biz_suburb as string).length > MAX_SUBURB_LENGTH) {
        errors.push({ field: "biz_suburb", message: `Suburb must be ${MAX_SUBURB_LENGTH} characters or fewer`, partyId: pid });
      }
      if (!p.biz_state)         errors.push({ field: "biz_state",         message: "Business state is required",      partyId: pid });
      if (!p.biz_postcode)      errors.push({ field: "biz_postcode",      message: "Business postcode is required",   partyId: pid });
      if (!p.company_phone)     errors.push({ field: "company_phone",     message: "Company phone is required",       partyId: pid });
      if (!p.principal_activity) errors.push({ field: "principal_activity", message: "Principal activity is required", partyId: pid });
    }
  }
}

export function validateConductingPersons(cps: Record<string, unknown>[], errors: ValidationError[]) {
  if (cps.length === 0) return; // conducting persons are optional
  const primaryCount = cps.filter((cp) => cp.is_primary).length;
  if (primaryCount !== 1) {
    errors.push({ field: "conducting_persons", message: "Exactly one conducting person must be marked as primary" });
  }
  for (const cp of cps) {
    const cpId = cp.id as string;
    if (!cp.full_name) {
      errors.push({ field: "full_name", message: "Full name is required", partyId: cpId });
    } else if ((cp.full_name as string).length > MAX_NAME_LENGTH) {
      errors.push({ field: "full_name", message: `Full name must be ${MAX_NAME_LENGTH} characters or fewer`, partyId: cpId });
    }
    if (!cp.res_street)      errors.push({ field: "res_street",      message: "Street address is required",  partyId: cpId });
    if (!cp.res_suburb) {
      errors.push({ field: "res_suburb", message: "Suburb is required", partyId: cpId });
    } else if ((cp.res_suburb as string).length > MAX_SUBURB_LENGTH) {
      errors.push({ field: "res_suburb", message: `Suburb must be ${MAX_SUBURB_LENGTH} characters or fewer`, partyId: cpId });
    }
    if (!cp.res_state)       errors.push({ field: "res_state",       message: "State is required",           partyId: cpId });
    if (!cp.res_postcode)    errors.push({ field: "res_postcode",    message: "Postcode is required",        partyId: cpId });
    if (!cp.authority_to_act) errors.push({ field: "authority_to_act", message: "Authority to act is required", partyId: cpId });
    if (!cp.relationship)    errors.push({ field: "relationship",    message: "Relationship is required",    partyId: cpId });
  }
}

export async function validateIdVerifications(
  idvs: Record<string, unknown>[],
  parties: Record<string, unknown>[],
  cps: Record<string, unknown>[],
  errors: ValidationError[],
  schemaClient: ReturnType<ReturnType<typeof createClient>["schema"]>,
  reportingEntityId: string,
) {
  // Every individual party must have an ID verification
  const individualPartyIds = new Set(
    parties.filter((p) => p.party_type === "individual").map((p) => p.id as string),
  );
  const cpIds = new Set(cps.map((cp) => cp.id as string));

  const coveredPartyIds = new Set<string>();
  const coveredCpIds = new Set<string>();

  for (const idv of idvs) {
    const idvId = idv.id as string;
    if (idv.party_id)             coveredPartyIds.add(idv.party_id as string);
    if (idv.conducting_person_id) coveredCpIds.add(idv.conducting_person_id as string);

    if (!idv.verification_method) {
      errors.push({ field: "verification_method", message: "Verification method is required", partyId: idvId });
    }
    if (!idv.document_type) {
      errors.push({ field: "document_type", message: "Document type is required", partyId: idvId });
    }
    if (!idv.document_number) {
      errors.push({ field: "document_number", message: "Document number is required", partyId: idvId });
    } else if ((idv.document_number as string).length > MAX_DOCUMENT_NUMBER_LENGTH) {
      errors.push({ field: "document_number", message: `Document number must be ${MAX_DOCUMENT_NUMBER_LENGTH} characters or fewer`, partyId: idvId });
    }
    if (!idv.verification_description) {
      errors.push({ field: "verification_description", message: "Verification description is required", partyId: idvId });
    }
    if (idv.has_expiry && !idv.expiry_date) {
      errors.push({ field: "expiry_date", message: "Expiry date is required when document has expiry", partyId: idvId });
    }

    const isReliance = idv.verification_basis === "relied_on_prior_identification";

    if (isReliance) {
      if (!idv.reliance_reason) {
        errors.push({ field: "reliance_reason", message: "Reliance reason is required", partyId: idvId });
      }
      if (!idv.prior_verification_id) {
        errors.push({ field: "prior_verification_id", message: "Prior verification record is required", partyId: idvId });
      } else {
        const { data: priorIdv } = await schemaClient
          .from("id_verifications")
          .select("id, is_complete, transaction_id")
          .eq("id", idv.prior_verification_id as string)
          .single();

        if (!priorIdv) {
          errors.push({ field: "prior_verification_id", message: "Prior verification record not found", partyId: idvId });
        } else if (!priorIdv.is_complete) {
          errors.push({ field: "prior_verification_id", message: "Prior verification is not complete", partyId: idvId });
        } else {
          const { data: priorTx } = await schemaClient
            .from("transactions")
            .select("reporting_entity_id")
            .eq("id", priorIdv.transaction_id)
            .single();
          if (!priorTx || priorTx.reporting_entity_id !== reportingEntityId) {
            errors.push({ field: "prior_verification_id", message: "Prior verification does not belong to this reporting entity", partyId: idvId });
          }
        }
      }
    } else {
      if (!idv.front_image_id) {
        errors.push({ field: "front_image_id", message: "Front image is required", partyId: idvId });
      }
      // Driver licences require a back image
      if (idv.document_type === "Driver licence" && !idv.back_image_id) {
        errors.push({ field: "back_image_id", message: "Back image is required for driver licences", partyId: idvId });
      }
      // TTR-1-0: country of issue required on new captures
      if (!idv.id_country_code) {
        errors.push({ field: "id_country_code", message: "Country of issue is required for ID documents", partyId: idvId });
      }
    }
  }

  for (const pid of individualPartyIds) {
    if (!coveredPartyIds.has(pid)) {
      errors.push({ field: "id_verifications", message: "ID verification is required", partyId: pid });
    }
  }
  for (const cpId of cpIds) {
    if (!coveredCpIds.has(cpId)) {
      errors.push({ field: "id_verifications", message: "ID verification is required for conducting person", partyId: cpId });
    }
  }
}

export function validateRecipientDelivery(rds: Record<string, unknown>[], errors: ValidationError[]) {
  if (rds.length === 0) {
    errors.push({ field: "recipient_delivery", message: "Recipient/delivery record is required" });
    return;
  }
  const rd = rds[0];
  if (!rd.purpose_of_transfer) {
    errors.push({ field: "purpose_of_transfer", message: "Purpose of transfer is required" });
  }
  if (!rd.delivery_method) {
    errors.push({ field: "delivery_method", message: "Delivery method is required" });
  }
  if (rd.recipient_is_party === false) {
    if (!rd.recipient_full_name) {
      errors.push({ field: "recipient_full_name", message: "Recipient full name is required when not linked to a party" });
    }
    if (!rd.recip_street || !rd.recip_suburb || !rd.recip_postcode) {
      errors.push({ field: "recip_street", message: "Recipient address is required when not linked to a party" });
    }
  }
}

export function validateBullionItems(items: Record<string, unknown>[], errors: ValidationError[]) {
  if (items.length === 0) {
    errors.push({ field: "bullion_items", message: "At least one bullion item is required" });
    return;
  }
  for (const item of items) {
    const itemId = item.id as string;
    if (!item.direction)    errors.push({ field: "direction",    message: "Direction is required",    partyId: itemId });
    if (!item.metal_type)   errors.push({ field: "metal_type",   message: "Metal type is required",   partyId: itemId });
    // TTR-1-0 BullionType only supports GOLD/SILVER/PLATINUM/PALLADIUM
    const VALID_BULLION_TYPES = new Set(["Gold", "Silver", "Platinum", "Palladium"]);
    if (item.metal_type && !VALID_BULLION_TYPES.has(item.metal_type as string)) {
      errors.push({ field: "metal_type", message: `Metal type "${item.metal_type}" cannot be reported to AUSTRAC. Use Gold, Silver, Platinum, or Palladium.`, partyId: itemId });
    }
    if (!item.product_type) errors.push({ field: "product_type", message: "Product type is required", partyId: itemId });
    if (!item.purity)       errors.push({ field: "purity",       message: "Purity is required",       partyId: itemId });
    if (!item.weight_unit)  errors.push({ field: "weight_unit",  message: "Weight unit is required",  partyId: itemId });
    if (!(Number(item.quantity) > 0)) {
      errors.push({ field: "quantity", message: "Quantity must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.weight) > 0)) {
      errors.push({ field: "weight", message: "Weight must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.unit_price_aud) > 0)) {
      errors.push({ field: "unit_price_aud", message: "Unit price must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.line_total_aud) > 0)) {
      errors.push({ field: "line_total_aud", message: "Line total must be greater than 0", partyId: itemId });
    }
  }
}

export function validatePreciousMetalItems(items: Record<string, unknown>[], errors: ValidationError[]) {
  if (items.length === 0) {
    errors.push({ field: "precious_metal_items", message: "At least one precious metal item is required" });
    return;
  }
  // TTR-1-0 PreciousMetalType — unlike BullionType, Alloy and Other are valid AUSTRAC codes
  const VALID_PRECIOUS_METAL_TYPES = new Set([
    "Gold", "Iridium", "Osmium", "Palladium", "Platinum", "Rhodium", "Ruthenium", "Silver", "Alloy", "Other",
  ]);
  const DESCRIPTION_REQUIRED_TYPES = new Set(["Alloy", "Other"]);
  for (const item of items) {
    const itemId = item.id as string;
    if (!item.direction)  errors.push({ field: "direction",  message: "Direction is required",  partyId: itemId });
    if (!item.metal_type) errors.push({ field: "metal_type", message: "Metal type is required", partyId: itemId });
    if (item.metal_type && !VALID_PRECIOUS_METAL_TYPES.has(item.metal_type as string)) {
      errors.push({ field: "metal_type", message: `Metal type "${item.metal_type}" cannot be reported to AUSTRAC.`, partyId: itemId });
    }
    if (item.metal_type && DESCRIPTION_REQUIRED_TYPES.has(item.metal_type as string) && !item.description) {
      errors.push({ field: "description", message: `Description is required when metal type is ${item.metal_type}`, partyId: itemId });
    }
    if (!item.weight_unit) errors.push({ field: "weight_unit", message: "Weight unit is required", partyId: itemId });
    if (!(Number(item.quantity) > 0)) {
      errors.push({ field: "quantity", message: "Quantity must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.weight) > 0)) {
      errors.push({ field: "weight", message: "Weight must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.unit_price_aud) > 0)) {
      errors.push({ field: "unit_price_aud", message: "Unit price must be greater than 0", partyId: itemId });
    }
    if (!(Number(item.line_total_aud) > 0)) {
      errors.push({ field: "line_total_aud", message: "Line total must be greater than 0", partyId: itemId });
    }
  }
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
