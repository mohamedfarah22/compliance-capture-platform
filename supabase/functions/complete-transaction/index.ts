import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TTR_THRESHOLD_AUD = 10_000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ValidationError {
  field: string;
  message: string;
  partyId?: string;
}

Deno.serve(async (req: Request) => {
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
    .select("id, status, aud_value, transaction_datetime, transaction_ref, designated_service, reporting_entity_id, lpp_flag, is_other_ds_provider_involved")
    .eq("id", transactionId)
    .single();

  if (txError || !tx) return json({ error: "Transaction not found" }, 404);
  if (tx.status === "complete") return json({ error: "Transaction is already complete" }, 409);

  // 4b. Load reporting entity (needed for AAN validation)
  const { data: entity } = await serviceClient
    .from("reporting_entities")
    .select("austrac_re_number")
    .eq("id", tx.reporting_entity_id as string)
    .single();

  // 5. Load all child records via service client to avoid RLS permission gaps during validation
  const [
    { data: parties },
    { data: conductingPersons },
    { data: idVerifications },
    { data: recipientDeliveries },
    { data: bullionItems },
  ] = await Promise.all([
    ttr.from("parties").select("*").eq("transaction_id", transactionId),
    ttr.from("conducting_persons").select("*").eq("transaction_id", transactionId),
    ttr.from("id_verifications").select("*").eq("transaction_id", transactionId),
    ttr.from("recipient_deliveries").select("*").eq("transaction_id", transactionId),
    ttr.from("bullion_items").select("*").eq("transaction_id", transactionId),
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
  validateBullionItems(bullionItems ?? [], errors);

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

  // 8. Return completed_at from the freshly updated row
  const { data: completed } = await ttr
    .from("transactions")
    .select("completed_at")
    .eq("id", transactionId)
    .single();

  return json({ completed: true, completedAt: completed?.completed_at }, 200);
});

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateTransaction(
  tx: Record<string, unknown>,
  entity: Record<string, unknown> | null,
  errors: ValidationError[],
) {
  if (typeof tx.aud_value !== "number" || tx.aud_value < TTR_THRESHOLD_AUD) {
    errors.push({ field: "aud_value", message: `AUD value must be at least $${TTR_THRESHOLD_AUD}` });
  }
  if (!tx.transaction_datetime) {
    errors.push({ field: "transaction_datetime", message: "Transaction date/time is required" });
  }
  if (!tx.transaction_ref) {
    errors.push({ field: "transaction_ref", message: "Transaction reference is required" });
  }
  if (!tx.designated_service) {
    errors.push({ field: "designated_service", message: "Designated service is required" });
  }
  // TTR-1-0: AAN must be exactly 9 digits
  const aan = entity?.austrac_re_number as string | null;
  if (!aan || !/^[0-9]{9}$/.test(aan)) {
    errors.push({ field: "austrac_re_number", message: "AUSTRAC account number must be exactly 9 digits" });
  }
}

function validateParties(parties: Record<string, unknown>[], errors: ValidationError[]) {
  if (parties.length === 0) {
    errors.push({ field: "parties", message: "At least one party is required" });
    return;
  }
  for (const p of parties) {
    const pid = p.id as string;
    if (p.party_type === "individual") {
      if (!p.first_name) errors.push({ field: "first_name", message: "First name is required", partyId: pid });
      if (!p.last_name)  errors.push({ field: "last_name",  message: "Last name is required",  partyId: pid });
      if (!p.date_of_birth) errors.push({ field: "date_of_birth", message: "Date of birth is required", partyId: pid });
      if (!p.res_street)   errors.push({ field: "res_street",   message: "Street address is required", partyId: pid });
      if (!p.res_suburb)   errors.push({ field: "res_suburb",   message: "Suburb is required",         partyId: pid });
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
      if (!p.entity_name)       errors.push({ field: "entity_name",       message: "Entity name is required",         partyId: pid });
      if (!p.reg_identifier)    errors.push({ field: "reg_identifier",    message: "Registration ID is required",     partyId: pid });
      if (!p.reg_id_type)       errors.push({ field: "reg_id_type",       message: "Registration ID type is required", partyId: pid });
      if (!p.biz_street)        errors.push({ field: "biz_street",        message: "Business street is required",     partyId: pid });
      if (!p.biz_suburb)        errors.push({ field: "biz_suburb",        message: "Business suburb is required",     partyId: pid });
      if (!p.biz_state)         errors.push({ field: "biz_state",         message: "Business state is required",      partyId: pid });
      if (!p.biz_postcode)      errors.push({ field: "biz_postcode",      message: "Business postcode is required",   partyId: pid });
      if (!p.company_phone)     errors.push({ field: "company_phone",     message: "Company phone is required",       partyId: pid });
      if (!p.principal_activity) errors.push({ field: "principal_activity", message: "Principal activity is required", partyId: pid });
    }
  }
}

function validateConductingPersons(cps: Record<string, unknown>[], errors: ValidationError[]) {
  if (cps.length === 0) return; // conducting persons are optional
  const primaryCount = cps.filter((cp) => cp.is_primary).length;
  if (primaryCount !== 1) {
    errors.push({ field: "conducting_persons", message: "Exactly one conducting person must be marked as primary" });
  }
  for (const cp of cps) {
    const cpId = cp.id as string;
    if (!cp.full_name)       errors.push({ field: "full_name",       message: "Full name is required",       partyId: cpId });
    if (!cp.res_street)      errors.push({ field: "res_street",      message: "Street address is required",  partyId: cpId });
    if (!cp.res_suburb)      errors.push({ field: "res_suburb",      message: "Suburb is required",          partyId: cpId });
    if (!cp.res_state)       errors.push({ field: "res_state",       message: "State is required",           partyId: cpId });
    if (!cp.res_postcode)    errors.push({ field: "res_postcode",    message: "Postcode is required",        partyId: cpId });
    if (!cp.authority_to_act) errors.push({ field: "authority_to_act", message: "Authority to act is required", partyId: cpId });
    if (!cp.relationship)    errors.push({ field: "relationship",    message: "Relationship is required",    partyId: cpId });
  }
}

async function validateIdVerifications(
  idvs: Record<string, unknown>[],
  parties: Record<string, unknown>[],
  cps: Record<string, unknown>[],
  errors: ValidationError[],
  schemaClient: ReturnType<typeof createClient>,
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

function validateRecipientDelivery(rds: Record<string, unknown>[], errors: ValidationError[]) {
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

function validateBullionItems(items: Record<string, unknown>[], errors: ValidationError[]) {
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

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
