import { supabase } from './supabase.js'
import { wizardStorageKeys, writeWizardData } from '../components/wizardStorage.js'

// ─── Transaction ID pointer (only thing kept in sessionStorage post-init) ─────
const TX_KEY = 'ttr.transactionId'
export const getTransactionId = () => sessionStorage.getItem(TX_KEY)
export const clearTransactionId = () => sessionStorage.removeItem(TX_KEY)
function setTransactionId(id) { sessionStorage.setItem(TX_KEY, id) }

const ttr = () => supabase.schema('ttr')

async function getAuthHeader() {
  const { data: { session } } = await supabase.auth.getSession()
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  }
}

const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

// ─── Scenario mapping ─────────────────────────────────────────────────────────
// Keyed by serviceType (the AUSTRAC designated service being reported) then by
// sell/buy direction. Bullion (BULSER) and precious metal (PRECIOUS) are modeled as
// distinct designated services with distinct DB scenario codes.
const SCENARIO_TO_DB = {
  bullion: { sell: 'bullion_sell', buy: 'bullion_buy' },
  precious_metal: { sell: 'precious_metal_sell', buy: 'precious_metal_buy' },
}
const SCENARIO_FROM_DB = {
  bullion_sell: { scenario: 'sell', serviceType: 'bullion' },
  bullion_buy: { scenario: 'buy', serviceType: 'bullion' },
  precious_metal_sell: { scenario: 'sell', serviceType: 'precious_metal' },
  precious_metal_buy: { scenario: 'buy', serviceType: 'precious_metal' },
}

const DESIGNATED_SERVICES = {
  bullion_sell: 'Sale of bullion for physical cash',
  bullion_buy: 'Purchase of bullion for physical cash',
  precious_metal_sell: 'Sale of precious metal for physical cash',
  precious_metal_buy: 'Purchase of precious metal for physical cash',
}

// ─── TRANSACTION ──────────────────────────────────────────────────────────────

// Creates the ttr.transactions row + migrates sessionStorage parties to DB.
// Called from TransactionDetailsPage once all required fields are available.
// parties = current value of ttr.customers from sessionStorage
export async function initTransaction({ startData, financialData, parties, staffMember }) {
  const scenario = SCENARIO_TO_DB[startData.serviceType || 'bullion']?.[startData.scenario] || startData.scenario
  const isFx = financialData.cashCurrency === 'Other'
  const cashAmount = parseFloat(financialData.cashAmount || 0)
  const fxAmount = parseFloat(financialData.foreignCurrencyAmount || 0)
  const fxRate = parseFloat(financialData.fxRate || 0)
  const audValue = isFx ? fxAmount * fxRate : cashAmount

  const { data: tx, error: txError } = await ttr().from('transactions').insert({
    reporting_entity_id: staffMember.reporting_entity_id,
    created_by_staff_id: staffMember.id,
    scenario,
    transaction_ref: startData.transactionRef,
    transaction_datetime: new Date(startData.dateTime).toISOString(),
    designated_service: DESIGNATED_SERVICES[scenario],
    location_snapshot: 'Coburg, VIC',
    staff_member_name: staffMember.full_name,
    staff_member_email: staffMember.email,
    cash_currency: isFx ? 'other' : 'AUD',
    cash_amount: isFx ? fxAmount : cashAmount,
    aud_value: audValue,
    fx_currency_code: isFx ? financialData.foreignCurrencyType : null,
    fx_currency_amount: isFx ? fxAmount : null,
    fx_rate: isFx ? fxRate : null,
    fx_rate_source: isFx ? financialData.rateSource : null,
    lpp_flag: financialData.lppFlag === true,
    is_other_ds_provider_involved: financialData.isOtherDsProviderInvolved === true,
  }).select('id').single()

  if (txError) throw txError
  const transactionId = tx.id
  setTransactionId(transactionId)

  await migrateNewParties(parties)

  return transactionId
}

// Inserts any sessionStorage parties not yet migrated into ttr.parties (marked _migrated),
// leaving already-migrated parties untouched. Called on first transaction creation and again
// whenever the user returns to Transaction Details after adding more parties.
export async function migrateNewParties(parties) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const unmigrated = parties.filter((p) => !p._migrated)
  if (unmigrated.length === 0) return parties

  const partyRows = unmigrated.map((p) => partyToDbRow(p, transactionId))
  const { data: insertedRows, error: partiesError } = await ttr().from('parties').insert(partyRows).select('id')
  if (partiesError) throw partiesError

  // Carry over aliases from an existing customer selected via search — partyToDbRow only
  // covers columns that live directly on ttr.parties, but aliases are a child table
  // (ttr.party_aliases) keyed by the new row's id, which Postgres only assigns on insert.
  // Relies on a single INSERT ... RETURNING preserving row order relative to partyRows/unmigrated.
  for (let i = 0; i < unmigrated.length; i++) {
    const aliases = (unmigrated[i].aliases || []).filter(Boolean)
    if (aliases.length === 0) continue
    const { error: aliasError } = await ttr().from('party_aliases').insert(
      aliases.map((alias) => ({ party_id: insertedRows[i].id, alias }))
    )
    if (aliasError) throw aliasError
  }

  // Keep each party's original id stable (it's what CustomerSearchPage's dedup check keys off) —
  // only flag it as migrated so a re-run of this function won't insert it again.
  const updatedParties = parties.map((p) => (p._migrated ? p : { ...p, _migrated: true }))

  writeWizardData(wizardStorageKeys.customers, updatedParties)
  return updatedParties
}

export async function loadTransaction() {
  const transactionId = getTransactionId()
  if (!transactionId) return null

  const { data, error } = await ttr().from('transactions').select('*').eq('id', transactionId).single()
  if (error) throw error
  return dbRowToTransaction(data)
}

// Returns the transaction for a ref whatever its status — callers need to tell a completed
// transaction apart from an unused ref, since uq_tx_ref_per_entity blocks re-using either.
export async function findTransactionByRef(transactionRef) {
  const { data, error } = await ttr()
    .from('transactions')
    .select('*')
    .eq('transaction_ref', transactionRef)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  // A completed transaction must never become the session's active transaction — it can't be
  // updated or deleted (trg_lock_completed), so adopting its id would wedge the wizard.
  if (data.status === 'draft') setTransactionId(data.id)
  return dbRowToTransaction(data)
}

// Updates the existing transaction row (e.g. if user edits fields on TransactionDetailsPage)
export async function saveTransaction(financialData, startData) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const scenario = SCENARIO_TO_DB[startData.serviceType || 'bullion']?.[startData.scenario] || startData.scenario
  const isFx = financialData.cashCurrency === 'Other'
  const cashAmount = parseFloat(financialData.cashAmount || 0)
  const fxAmount = parseFloat(financialData.foreignCurrencyAmount || 0)
  const fxRate = parseFloat(financialData.fxRate || 0)
  const audValue = isFx ? fxAmount * fxRate : cashAmount

  const { error } = await ttr().from('transactions').update({
    scenario,
    transaction_ref: startData.transactionRef,
    transaction_datetime: new Date(startData.dateTime).toISOString(),
    designated_service: DESIGNATED_SERVICES[scenario],
    cash_currency: isFx ? 'other' : 'AUD',
    cash_amount: isFx ? fxAmount : cashAmount,
    aud_value: audValue,
    fx_currency_code: isFx ? financialData.foreignCurrencyType : null,
    fx_currency_amount: isFx ? fxAmount : null,
    fx_rate: isFx ? fxRate : null,
    fx_rate_source: isFx ? financialData.rateSource : null,
    lpp_flag: financialData.lppFlag === true,
    is_other_ds_provider_involved: financialData.isOtherDsProviderInvolved === true,
  }).eq('id', transactionId)

  if (error) throw error
}

// ─── PARTIES ──────────────────────────────────────────────────────────────────

export async function saveCustomers(customers) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  for (const party of customers) {
    const row = partyToDbRow(party, transactionId)
    const { error } = await ttr().from('parties').update(row).eq('id', party.id).eq('transaction_id', transactionId)
    if (error) throw error

    // Sync aliases: delete existing then re-insert
    await ttr().from('party_aliases').delete().eq('party_id', party.id)
    const aliases = (party.aliases || []).filter(Boolean)
    if (aliases.length > 0) {
      const { error: aliasError } = await ttr().from('party_aliases').insert(
        aliases.map((alias) => ({ party_id: party.id, alias }))
      )
      if (aliasError) throw aliasError
    }
  }
}

export async function deleteParty(partyId) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const { error } = await ttr().from('parties').delete().eq('id', partyId).eq('transaction_id', transactionId)
  if (error) throw error
}

export async function loadCustomers() {
  const transactionId = getTransactionId()
  if (!transactionId) return []

  const { data: parties, error } = await ttr()
    .from('parties')
    .select('*, party_aliases(alias)')
    .eq('transaction_id', transactionId)
  if (error) throw error

  return (parties || []).map(dbRowToParty)
}

// ─── CONDUCTING PERSON ────────────────────────────────────────────────────────

export async function saveConductingPerson(data) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  if (data.hasConductingPerson !== 'yes') {
    // Remove any existing CP record
    await ttr().from('conducting_persons').delete().eq('transaction_id', transactionId)
    return
  }

  const row = cpToDbRow(data, transactionId)
  const existing = await ttr().from('conducting_persons').select('id').eq('transaction_id', transactionId).maybeSingle()

  if (existing.data) {
    const { error } = await ttr().from('conducting_persons').update(row).eq('id', existing.data.id)
    if (error) throw error

    await ttr().from('cp_aliases').delete().eq('conducting_person_id', existing.data.id)
    const aliases = (data.aliases || []).filter(Boolean)
    if (aliases.length > 0) {
      const { error: aliasError } = await ttr().from('cp_aliases').insert(
        aliases.map((alias) => ({ conducting_person_id: existing.data.id, alias }))
      )
      if (aliasError) throw aliasError
    }
  } else {
    const { data: newCp, error } = await ttr().from('conducting_persons').insert(row).select('id').single()
    if (error) throw error

    const aliases = (data.aliases || []).filter(Boolean)
    if (aliases.length > 0) {
      const { error: aliasError } = await ttr().from('cp_aliases').insert(
        aliases.map((alias) => ({ conducting_person_id: newCp.id, alias }))
      )
      if (aliasError) throw aliasError
    }
  }
}

// Records who conducted the transaction when there's no separate conducting person:
// either which party conducted it (self-conducted, disambiguates multiple parties) or,
// for a company party whose conducting individual can't be identified, a
// methodOfConductingTxn code. Called alongside saveConductingPerson.
export async function saveConductorInfo({ conductedByPartyId, methodOfConductingTxn }) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const { error } = await ttr().from('transactions').update({
    conducted_by_party_id: conductedByPartyId || null,
    method_of_conducting_txn: methodOfConductingTxn || null,
  }).eq('id', transactionId)

  if (error) throw error
}

export async function loadConductingPerson() {
  const transactionId = getTransactionId()
  if (!transactionId) return null

  const { data, error } = await ttr()
    .from('conducting_persons')
    .select('*, cp_aliases(alias)')
    .eq('transaction_id', transactionId)
    .maybeSingle()
  if (error) throw error
  if (!data) return { hasConductingPerson: 'no' }

  return dbRowToCp(data)
}

// ─── ID VERIFICATIONS ─────────────────────────────────────────────────────────

export async function saveIdVerifications(verifications) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  // Get CP DB UUID for the 'conducting-person' session key
  let cpDbId = null
  if (verifications['conducting-person']) {
    const { data: cp } = await ttr().from('conducting_persons').select('id').eq('transaction_id', transactionId).maybeSingle()
    cpDbId = cp?.id ?? null
  }

  for (const [sessionKey, v] of Object.entries(verifications)) {
    const isParty = sessionKey.startsWith('party-')
    const partyId = isParty ? sessionKey.replace('party-', '') : null
    const conductingPersonId = !isParty && cpDbId ? cpDbId : null

    if (!partyId && !conductingPersonId) continue

    // Basis follows the chosen method, not the presence of prior_verification_id:
    // a re-capture of an unclear stored copy is a new capture that still links to
    // the record it refreshes.
    const isReliance = v.verificationMethod === 'Relied on prior identification'

    const row = {
      transaction_id: transactionId,
      party_id: partyId || null,
      conducting_person_id: conductingPersonId || null,
      verification_method: v.verificationMethod || 'Sighted original document',
      verification_method_other: v.verificationMethodOther || null,
      document_type: v.documentType || 'Driver licence',
      document_type_other: v.documentTypeOther || null,
      document_number: v.documentNumber || '',
      issuer: v.issuer || null,
      has_expiry: v.hasExpiry === 'yes',
      expiry_date: v.hasExpiry === 'yes' ? v.expiryDate || null : null,
      verification_description: v.verificationDescription || '',
      is_complete: v.isComplete || false,
      verification_basis: isReliance ? 'relied_on_prior_identification' : 'new_capture',
      prior_verification_id: v.priorVerificationId || null,
      reliance_reason: isReliance ? v.relianceReason || null : null,
      new_capture_reason: isReliance ? null : v.newCaptureReason || null,
      elec_data_src: v.elecDataSrc || null,
      front_image_id: v.frontImageId || null,
      back_image_id: v.backImageId || null,
      id_country_code: v.idCountryCode || null,
    }

    // Check for existing record
    const query = isParty
      ? ttr().from('id_verifications').select('id').eq('party_id', partyId).eq('transaction_id', transactionId)
      : ttr().from('id_verifications').select('id').eq('conducting_person_id', conductingPersonId).eq('transaction_id', transactionId)

    const { data: existing } = await query.maybeSingle()

    if (existing) {
      const { error } = await ttr().from('id_verifications').update(row).eq('id', existing.id)
      if (error) throw error
    } else {
      const { error } = await ttr().from('id_verifications').insert(row)
      if (error) throw error
    }
  }
}

export async function loadIdVerifications() {
  const transactionId = getTransactionId()
  if (!transactionId) return {}

  const { data, error } = await ttr().from('id_verifications').select('*').eq('transaction_id', transactionId)
  if (error) throw error

  const result = {}
  for (const row of (data || [])) {
    const key = row.party_id ? `party-${row.party_id}` : 'conducting-person'
    result[key] = dbRowToIdVerification(row)
  }
  return result
}

// ─── RECIPIENT DELIVERY ───────────────────────────────────────────────────────

export async function saveRecipientDelivery(data) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const recipientIsParty = data.recipientIsParty === true || data.recipientIsParty === 'yes'
  const dobKnown = data.dobKnown === true || data.dobKnown === 'yes'
  const deliveryAddressDifferent = data.deliveryAddressDifferent === true || data.deliveryAddressDifferent === 'yes'
  const row = {
    transaction_id: transactionId,
    recipient_is_party: recipientIsParty,
    selected_party_id: recipientIsParty ? data.selectedPartyId || null : null,
    recipient_full_name: !recipientIsParty ? data.recipientFullName || null : null,
    dob_known: !recipientIsParty ? dobKnown : null,
    recipient_dob: !recipientIsParty && dobKnown ? data.recipientDob || null : null,
    recip_street: !recipientIsParty ? data.recipientAddress?.street || null : null,
    recip_suburb: !recipientIsParty ? data.recipientAddress?.suburb || null : null,
    recip_state: !recipientIsParty ? data.recipientAddress?.state || null : null,
    recip_postcode: !recipientIsParty ? data.recipientAddress?.postcode || null : null,
    recip_country: !recipientIsParty ? (data.recipientAddress?.country || 'Australia') : null,
    purpose_of_transfer: data.purposeOfTransfer || 'Collecting bullion',
    delivery_method: data.deliveryMethod || 'Collected',
    delivery_method_other: data.deliveryMethod === 'Other' ? data.deliveryMethodOther || null : null,
    delivery_address_different: deliveryAddressDifferent,
    del_street: deliveryAddressDifferent ? data.deliveryAddress?.street || null : null,
    del_suburb: deliveryAddressDifferent ? data.deliveryAddress?.suburb || null : null,
    del_state: deliveryAddressDifferent ? data.deliveryAddress?.state || null : null,
    del_postcode: deliveryAddressDifferent ? data.deliveryAddress?.postcode || null : null,
    del_country: deliveryAddressDifferent ? (data.deliveryAddress?.country || 'Australia') : null,
    handover_notes: data.handoverNotes || null,
  }

  const { data: existing } = await ttr().from('recipient_deliveries').select('id').eq('transaction_id', transactionId).maybeSingle()

  if (existing) {
    const { error } = await ttr().from('recipient_deliveries').update(row).eq('id', existing.id)
    if (error) throw error
  } else {
    const { error } = await ttr().from('recipient_deliveries').insert(row)
    if (error) throw error
  }
}

export async function loadRecipientDelivery() {
  const transactionId = getTransactionId()
  if (!transactionId) return null

  const { data, error } = await ttr().from('recipient_deliveries').select('*').eq('transaction_id', transactionId).maybeSingle()
  if (error) throw error
  if (!data) return null
  return dbRowToRecipientDelivery(data)
}

// ─── BULLION ITEMS ────────────────────────────────────────────────────────────

export async function saveBullionItems(items) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  await ttr().from('bullion_items').delete().eq('transaction_id', transactionId)

  if (items.length > 0) {
    const rows = items.map((item, i) => ({
      transaction_id: transactionId,
      sort_order: i,
      direction: item.direction || 'Provided to customer',
      metal_type: item.metalType || 'Gold',
      metal_type_other: item.metalType === 'Other' ? item.metalTypeOther || null : null,
      product_type: item.productType || 'Bar',
      product_type_other: item.productType === 'Other' ? item.productTypeOther || null : null,
      purity: item.purity || '',
      quantity: parseFloat(item.quantity || 0),
      weight: parseFloat(item.weight || 0),
      weight_unit: item.weightUnit || 'grams',
      weight_unit_other: item.weightUnit === 'other' ? item.weightUnitOther || null : null,
      unit_price_aud: parseFloat(item.unitPrice || 0),
      line_total_aud: item.lineTotal || 0,
      description: item.description || null,
    }))

    const { error } = await ttr().from('bullion_items').insert(rows)
    if (error) throw error
  }
}

export async function loadBullionItems() {
  const transactionId = getTransactionId()
  if (!transactionId) return []

  const { data, error } = await ttr().from('bullion_items').select('*').eq('transaction_id', transactionId).order('sort_order')
  if (error) throw error

  return (data || []).map((row) => ({
    id: row.id,
    direction: row.direction,
    metalType: row.metal_type,
    metalTypeOther: row.metal_type_other || '',
    productType: row.product_type,
    productTypeOther: row.product_type_other || '',
    purity: row.purity,
    quantity: String(row.quantity),
    weight: String(row.weight),
    weightUnit: row.weight_unit,
    weightUnitOther: row.weight_unit_other || '',
    unitPrice: String(row.unit_price_aud),
    lineTotal: parseFloat(row.line_total_aud),
    description: row.description || '',
  }))
}

// ─── PRECIOUS METAL ITEMS ─────────────────────────────────────────────────────

export async function savePreciousMetalItems(items) {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  await ttr().from('precious_metal_items').delete().eq('transaction_id', transactionId)

  if (items.length > 0) {
    const rows = items.map((item, i) => ({
      transaction_id: transactionId,
      sort_order: i,
      direction: item.direction || 'Provided to customer',
      metal_type: item.metalType || 'Gold',
      quantity: parseFloat(item.quantity || 0),
      weight: parseFloat(item.weight || 0),
      weight_unit: item.weightUnit || 'grams',
      weight_unit_other: item.weightUnit === 'other' ? item.weightUnitOther || null : null,
      unit_price_aud: parseFloat(item.unitPrice || 0),
      line_total_aud: item.lineTotal || 0,
      description: item.description || null,
      serial_number: item.serialNumber || null,
    }))

    const { error } = await ttr().from('precious_metal_items').insert(rows)
    if (error) throw error
  }
}

export async function loadPreciousMetalItems() {
  const transactionId = getTransactionId()
  if (!transactionId) return []

  const { data, error } = await ttr().from('precious_metal_items').select('*').eq('transaction_id', transactionId).order('sort_order')
  if (error) throw error

  return (data || []).map((row) => ({
    id: row.id,
    direction: row.direction,
    metalType: row.metal_type,
    quantity: String(row.quantity),
    weight: String(row.weight),
    weightUnit: row.weight_unit,
    weightUnitOther: row.weight_unit_other || '',
    unitPrice: String(row.unit_price_aud),
    lineTotal: parseFloat(row.line_total_aud),
    description: row.description || '',
    serialNumber: row.serial_number || '',
  }))
}

// ─── PRIOR VERIFICATIONS ──────────────────────────────────────────────────────

// Finds an existing capture of the same document, keyed exactly as the
// uq_idv_doc_new_capture index is. Role-agnostic on purpose: the collision it
// reports is the collision the database will reject, whether the record on file
// belongs to a customer or a conducting person. Returns null when there is none.
export async function fetchVerificationForDocument({ documentType, documentNumber, excludeId = null }) {
  if (!documentType || !documentNumber?.trim()) return null
  const { data, error } = await supabase.rpc('get_verification_for_document', {
    p_document_type: documentType,
    p_document_number: documentNumber,
    p_exclude_id: excludeId,
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function fetchPriorVerifications(person) {
  if (person.role !== 'party') return []
  const isIndividual = person.type === 'individual'
  const rpc = isIndividual ? 'get_prior_verifications_individual' : 'get_prior_verifications_company'
  const params = isIndividual
    ? { p_last_name: person.lastName, p_first_name: person.firstName, p_dob: person.dateOfBirth || null }
    : { p_entity_name: person.entityName, p_reg_identifier: person.abnAcn || null }
  const { data, error } = await supabase.rpc(rpc, params)
  if (error) throw error
  return data ?? []
}

// ─── CUSTOMER SEARCH ─────────────────────────────────────────────────────────

export async function searchIndividualCustomers({ firstName, lastName, dob }) {
  const { data, error } = await supabase.rpc('search_individual_customers', {
    p_first_name: firstName || null,
    p_last_name:  lastName  || null,
    p_dob:        dob       || null,
  })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id:                  r.party_id,
    type:                'individual',
    firstName:           r.first_name    || '',
    middleName:          r.middle_name   || '',
    lastName:            r.last_name     || '',
    dateOfBirth:         r.date_of_birth || '',
    gender:              r.gender        || '',
    phone:               r.phone         || '',
    email:               r.email         || '',
    occupation:          r.occupation    || '',
    abn:                 '',
    businessTradingName: '',
    aliases:             r.aliases || [],
    residentialAddress: {
      street:   r.res_street   || '',
      suburb:   r.res_suburb   || '',
      state:    r.res_state    || '',
      postcode: r.res_postcode || '',
      country:  r.res_country  || 'Australia',
    },
    hasPostalAddress: false,
    postalAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
    displayName: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
    detail: r.date_of_birth
      ? `DOB: ${new Date(r.date_of_birth).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : '',
  }))
}

export async function searchCompanyCustomers({ entityName, regIdentifier, suburb }) {
  const { data, error } = await supabase.rpc('search_company_customers', {
    p_entity_name:    entityName    || null,
    p_reg_identifier: regIdentifier || null,
    p_suburb:         suburb        || null,
  })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id:                         r.party_id,
    type:                       'company',
    entityName:                 r.entity_name          || '',
    companyTradingName:         r.company_trading_name || '',
    legalForm:                  r.legal_form           || '',
    registrationIdentifierType: r.reg_id_type          || '',
    registrationIdentifier:     r.reg_identifier       || '',
    abnAcn:                     r.reg_identifier       || '',
    companyPhone:               r.company_phone        || '',
    phone:                      r.company_phone        || '',
    principalActivity:          r.principal_activity   || '',
    isExpressTrust:             r.is_express_trust === true ? 'Yes' : r.is_express_trust === false ? 'No' : '',
    trustTypeOther:             r.trust_type_other     || '',
    trustName:                  r.trust_name           || '',
    aliases:                    r.aliases || [],
    businessAddress: {
      street:   r.biz_street   || '',
      suburb:   r.biz_suburb   || '',
      state:    r.biz_state    || '',
      postcode: r.biz_postcode || '',
      country:  r.biz_country  || 'Australia',
    },
    hasCompanyPostalAddress: false,
    companyPostalAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
    displayName: r.entity_name || '',
    detail: [
      r.reg_identifier ? `ABN/ACN: ${r.reg_identifier}` : null,
      r.biz_suburb,
    ].filter(Boolean).join(' · '),
  }))
}

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────

// blob: Blob, personType: 'party'|'conducting-person', personId: UUID, side: 'front'|'back'
export async function uploadIdImage({ transactionId, personType, personId, side, blob }) {
  const headers = await getAuthHeader()
  delete headers['Content-Type'] // let browser set multipart boundary

  const form = new FormData()
  form.append('transactionId', transactionId)
  form.append('personType', personType)
  form.append('personId', personId)
  form.append('side', side)
  form.append('file', blob, `${side}.jpg`)

  const res = await fetch(`${EDGE_URL}/upload-id-image`, { method: 'POST', headers, body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Upload failed: ${res.status}`)
  }
  return res.json() // { imageId, path, sha256 }
}

// ─── IMAGE URL FETCHING ───────────────────────────────────────────────────────

// Routed through an Edge Function rather than signing client-side: viewing an ID
// image must write a ttr.access_log row, and a client that mints its own signed
// URL could skip that. Returns { [imageId]: signedUrl }, unchanged for callers.
export async function getIdImageSignedUrls(imageIds) {
  const ids = imageIds.filter(Boolean)
  if (!ids.length) return {}

  const headers = await getAuthHeader()
  const res = await fetch(`${EDGE_URL}/get-id-image-urls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageIds: ids }),
  })
  if (!res.ok) return {}
  const { urls } = await res.json()
  return urls ?? {}
}

// ─── LIFECYCLE ────────────────────────────────────────────────────────────────

export async function deleteTransaction() {
  const transactionId = getTransactionId()
  if (!transactionId) {
    // No DB row yet — just clear session storage
    Object.values(wizardStorageKeys).forEach((k) => sessionStorage.removeItem(k))
    return
  }

  const headers = await getAuthHeader()
  await fetch(`${EDGE_URL}/delete-draft-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transactionId }),
  })

  clearTransactionId()
  Object.values(wizardStorageKeys).forEach((k) => sessionStorage.removeItem(k))
}

export async function completeTransaction() {
  const transactionId = getTransactionId()
  if (!transactionId) throw new Error('No active transaction')

  const headers = await getAuthHeader()
  const res = await fetch(`${EDGE_URL}/complete-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transactionId }),
  })

  const body = await res.json()
  if (!res.ok) return { ok: false, errors: body.errors || [{ message: body.error }] }

  clearTransactionId()
  Object.values(wizardStorageKeys).forEach((k) => sessionStorage.removeItem(k))
  return { ok: true, completedAt: body.completedAt ?? null }
}

// ─── DATA MAPPING: session → DB ───────────────────────────────────────────────

function partyToDbRow(p, transactionId) {
  if (p.type === 'individual') {
    return {
      transaction_id: transactionId,
      party_type: 'individual',
      is_complete: p.isComplete || false,
      first_name: p.firstName || null,
      middle_name: p.middleName || null,
      last_name: p.lastName || null,
      full_name: p.fullName || p.displayName || null,
      date_of_birth: p.dateOfBirth || null,
      phone: p.phone || null,
      email: p.email || null,
      occupation: p.occupation || null,
      abn: p.abn ? p.abn.replace(/\s/g, '') : null,
      business_trading_name: p.businessTradingName || null,
      res_street: p.residentialAddress?.street || null,
      res_suburb: p.residentialAddress?.suburb || null,
      res_state: p.residentialAddress?.state || null,
      res_postcode: p.residentialAddress?.postcode || null,
      res_country: p.residentialAddress?.country || 'Australia',
      has_postal_address: p.hasPostalAddress || false,
      post_street: p.postalAddress?.street || null,
      post_suburb: p.postalAddress?.suburb || null,
      post_state: p.postalAddress?.state || null,
      post_postcode: p.postalAddress?.postcode || null,
      post_country: p.postalAddress?.country || null,
      gender: p.gender || null,
      citizenship_country_code: p.citizenshipCountryCode || null,
      tax_residency_country_code: p.taxResidencyCountryCode || null,
    }
  }

  // company
  return {
    transaction_id: transactionId,
    party_type: 'company',
    is_complete: p.isComplete || false,
    entity_name: p.entityName || null,
    company_trading_name: p.companyTradingName || null,
    legal_form: p.legalForm || null,
    is_express_trust: p.isExpressTrust === 'Yes' ? true : p.isExpressTrust === 'No' ? false : null,
    trust_type_other: p.isExpressTrust === 'Yes' ? p.trustTypeOther || null : null,
    trust_name: p.isExpressTrust === 'Yes' ? p.trustName || null : null,
    company_phone: p.companyPhone || p.phone || null,
    reg_id_type: p.registrationIdentifierType || null,
    reg_identifier: (p.registrationIdentifier || p.abnAcn || '').replace(/\s/g, '') || null,
    principal_activity: p.principalActivity || null,
    biz_street: p.businessAddress?.street || null,
    biz_suburb: p.businessAddress?.suburb || null,
    biz_state: p.businessAddress?.state || null,
    biz_postcode: p.businessAddress?.postcode || null,
    biz_country: p.businessAddress?.country || 'Australia',
    has_company_postal_address: p.hasCompanyPostalAddress || false,
    co_post_street: p.companyPostalAddress?.street || null,
    co_post_suburb: p.companyPostalAddress?.suburb || null,
    co_post_state: p.companyPostalAddress?.state || null,
    co_post_postcode: p.companyPostalAddress?.postcode || null,
    co_post_country: p.companyPostalAddress?.country || null,
  }
}

// ─── DATA MAPPING: DB → session ───────────────────────────────────────────────

function dbRowToTransaction(row) {
  const mapped = SCENARIO_FROM_DB[row.scenario] || { scenario: row.scenario, serviceType: 'bullion' }
  return {
    scenario: mapped.scenario,
    serviceType: mapped.serviceType,
    transactionRef: row.transaction_ref,
    dateTime: row.transaction_datetime ? row.transaction_datetime.slice(0, 16) : '',
    staffMember: row.staff_member_name,
    status: row.status,
    location: row.location_snapshot,
    designatedService: row.designated_service,
    cashCurrency: row.cash_currency === 'AUD' ? 'AUD' : 'Other',
    cashAmount: String(row.cash_amount),
    audValue: String(row.aud_value),
    foreignCurrency: row.cash_currency === 'other' ? {
      type: row.fx_currency_code,
      amount: row.fx_currency_amount,
      fxRate: row.fx_rate,
      rateSource: row.fx_rate_source,
    } : null,
    lppFlag: row.lpp_flag || false,
    isOtherDsProviderInvolved: row.is_other_ds_provider_involved || false,
    conductedByPartyId: row.conducted_by_party_id || '',
    methodOfConductingTxn: row.method_of_conducting_txn || '',
  }
}

function dbRowToParty(row) {
  const aliases = (row.party_aliases || []).map((a) => a.alias)

  if (row.party_type === 'individual') {
    const displayName = row.full_name || [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')
    return {
      id: row.id,
      type: 'individual',
      isComplete: row.is_complete,
      firstName: row.first_name || '',
      middleName: row.middle_name || '',
      lastName: row.last_name || '',
      fullName: row.full_name || '',
      displayName,
      dateOfBirth: row.date_of_birth || '',
      detail: row.date_of_birth ? `DOB: ${row.date_of_birth}` : '',
      phone: row.phone || '',
      email: row.email || '',
      occupation: row.occupation || '',
      abn: row.abn || '',
      businessTradingName: row.business_trading_name || '',
      aliases,
      residentialAddress: {
        street: row.res_street || '',
        suburb: row.res_suburb || '',
        state: row.res_state || '',
        postcode: row.res_postcode || '',
        country: row.res_country || 'Australia',
      },
      hasPostalAddress: row.has_postal_address || false,
      postalAddress: {
        street: row.post_street || '',
        suburb: row.post_suburb || '',
        state: row.post_state || '',
        postcode: row.post_postcode || '',
        country: row.post_country || 'Australia',
      },
      gender: row.gender || '',
      citizenshipCountryCode: row.citizenship_country_code || '',
      taxResidencyCountryCode: row.tax_residency_country_code || '',
    }
  }

  // company
  return {
    id: row.id,
    type: 'company',
    isComplete: row.is_complete,
    entityName: row.entity_name || '',
    displayName: row.entity_name || '',
    companyTradingName: row.company_trading_name || '',
    legalForm: row.legal_form || '',
    isExpressTrust: row.is_express_trust === true ? 'Yes' : row.is_express_trust === false ? 'No' : '',
    trustTypeOther: row.trust_type_other || '',
    trustName: row.trust_name || '',
    phone: row.company_phone || '',
    registrationIdentifierType: row.reg_id_type || '',
    registrationIdentifier: row.reg_identifier || '',
    abnAcn: row.reg_identifier || '',
    detail: row.reg_identifier ? `ABN/ACN: ${row.reg_identifier}` : '',
    principalActivity: row.principal_activity || '',
    aliases,
    businessAddress: {
      street: row.biz_street || '',
      suburb: row.biz_suburb || '',
      state: row.biz_state || '',
      postcode: row.biz_postcode || '',
      country: row.biz_country || 'Australia',
    },
    hasCompanyPostalAddress: row.has_company_postal_address || false,
    companyPostalAddress: {
      street: row.co_post_street || '',
      suburb: row.co_post_suburb || '',
      state: row.co_post_state || '',
      postcode: row.co_post_postcode || '',
      country: row.co_post_country || 'Australia',
    },
  }
}

function cpToDbRow(data, transactionId) {
  // Find the represented party DB UUID (it's already stored as the party id after initTransaction)
  return {
    transaction_id: transactionId,
    represented_party_id: data.representedPartyId || null,
    is_primary: true,
    full_name: data.fullName || '',
    dob_known: data.dobKnown === 'yes',
    date_of_birth: data.dobKnown === 'yes' ? (data.dateOfBirth || null) : null,
    phone: data.phone || null,
    occupation: data.occupation || null,
    res_street: data.residentialAddress?.street || '',
    res_suburb: data.residentialAddress?.suburb || '',
    res_state: data.residentialAddress?.state || '',
    res_postcode: data.residentialAddress?.postcode || '',
    res_country: data.residentialAddress?.country || 'Australia',
    has_postal_address: data.postalAddressDifferent || false,
    post_street: data.postalAddressDifferent ? data.postalAddress?.street || null : null,
    post_suburb: data.postalAddressDifferent ? data.postalAddress?.suburb || null : null,
    post_state: data.postalAddressDifferent ? data.postalAddress?.state || null : null,
    post_postcode: data.postalAddressDifferent ? data.postalAddress?.postcode || null : null,
    post_country: data.postalAddressDifferent ? (data.postalAddress?.country || 'Australia') : null,
    relationship: data.relationship || 'Other',
    relationship_other: data.relationship === 'Other' ? data.relationshipOther || null : null,
    authority_to_act: data.authorityToAct || '',
    is_employee: data.isEmployee || null,
    employee_role: data.employeeRole || null,
    acting_via_entity: data.actingViaEntity === true,
    entity_name: data.actingViaEntity ? data.entityName || null : null,
    entity_street: data.actingViaEntity ? data.entityAddress?.street || null : null,
    entity_suburb: data.actingViaEntity ? data.entityAddress?.suburb || null : null,
    entity_state: data.actingViaEntity ? data.entityAddress?.state || null : null,
    entity_postcode: data.actingViaEntity ? data.entityAddress?.postcode || null : null,
    entity_country: data.actingViaEntity ? (data.entityAddress?.country || 'Australia') : null,
    entity_reg_type: data.entityRegType || null,
    entity_reg_number: data.entityRegNumber || null,
  }
}

function dbRowToCp(row) {
  const aliases = (row.cp_aliases || []).map((a) => a.alias)
  return {
    id: row.id,
    hasConductingPerson: 'yes',
    representedPartyId: row.represented_party_id || '',
    fullName: row.full_name || '',
    aliases,
    // Converted, not passed through: the page's radios compare against 'yes'/'no',
    // so a raw boolean reads as unselected and silently resets on draft reload.
    // Same conversion dbRowToRecipientDelivery already does for its dob_known.
    dobKnown: row.dob_known === true ? 'yes' : row.dob_known === false ? 'no' : null,
    dateOfBirth: row.date_of_birth || '',
    phone: row.phone || '',
    occupation: row.occupation || '',
    residentialAddress: {
      street: row.res_street || '',
      suburb: row.res_suburb || '',
      state: row.res_state || '',
      postcode: row.res_postcode || '',
      country: row.res_country || 'Australia',
    },
    postalAddressDifferent: row.has_postal_address || false,
    postalAddress: {
      street: row.post_street || '',
      suburb: row.post_suburb || '',
      state: row.post_state || '',
      postcode: row.post_postcode || '',
      country: row.post_country || 'Australia',
    },
    relationship: row.relationship || '',
    relationshipOther: row.relationship_other || '',
    authorityToAct: row.authority_to_act || '',
    isEmployee: row.is_employee || null,
    employeeRole: row.employee_role || '',
    actingViaEntity: row.acting_via_entity || false,
    entityName: row.entity_name || '',
    entityAddress: {
      street: row.entity_street || '',
      suburb: row.entity_suburb || '',
      state: row.entity_state || '',
      postcode: row.entity_postcode || '',
      country: row.entity_country || 'Australia',
    },
    entityRegType: row.entity_reg_type || '',
    entityRegNumber: row.entity_reg_number || '',
  }
}

function dbRowToIdVerification(row) {
  return {
    id: row.id, // needed as p_exclude_id so a saved row doesn't collide with itself
    verificationMethod: row.verification_method || '',
    verificationMethodOther: row.verification_method_other || '',
    documentType: row.document_type || '',
    documentTypeOther: row.document_type_other || '',
    documentNumber: row.document_number || '',
    issuer: row.issuer || '',
    hasExpiry: row.has_expiry ? 'yes' : 'no',
    expiryDate: row.expiry_date || '',
    verificationDescription: row.verification_description || '',
    frontImageId: row.front_image_id || null,
    backImageId: row.back_image_id || null,
    isComplete: row.is_complete || false,
    verificationBasis: row.verification_basis || 'new_capture',
    priorVerificationId: row.prior_verification_id || null,
    relianceReason: row.reliance_reason || null,
    newCaptureReason: row.new_capture_reason || null,
    elecDataSrc: row.elec_data_src || '',
    idCountryCode: row.id_country_code || '',
  }
}

function dbRowToRecipientDelivery(row) {
  return {
    recipientIsParty: row.recipient_is_party === true ? 'yes' : row.recipient_is_party === false ? 'no' : null,
    selectedPartyId: row.selected_party_id || '',
    recipientFullName: row.recipient_full_name || '',
    dobKnown: row.dob_known === true ? 'yes' : row.dob_known === false ? 'no' : null,
    recipientDob: row.recipient_dob || '',
    recipientAddress: {
      street: row.recip_street || '',
      suburb: row.recip_suburb || '',
      state: row.recip_state || '',
      postcode: row.recip_postcode || '',
      country: row.recip_country || 'Australia',
    },
    purposeOfTransfer: row.purpose_of_transfer || '',
    deliveryMethod: row.delivery_method || '',
    deliveryMethodOther: row.delivery_method_other || '',
    deliveryAddressDifferent: row.delivery_address_different ? 'yes' : 'no',
    deliveryAddress: {
      street: row.del_street || '',
      suburb: row.del_suburb || '',
      state: row.del_state || '',
      postcode: row.del_postcode || '',
      country: row.del_country || 'Australia',
    },
    handoverNotes: row.handover_notes || '',
  }
}
