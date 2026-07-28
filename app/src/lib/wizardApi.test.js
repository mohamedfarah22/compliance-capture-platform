import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  completeTransaction,
  deleteParty,
  deleteTransaction,
  findTransactionByRef,
  initTransaction,
  loadConductingPerson,
  loadCustomers,
  loadPreciousMetalItems,
  loadTransaction,
  migrateNewParties,
  saveBullionItems,
  saveConductingPerson,
  saveCustomers,
  saveIdVerifications,
  savePreciousMetalItems,
  saveRecipientDelivery,
  saveTransaction,
  searchCompanyCustomers,
  searchIndividualCustomers,
  fetchVerificationForDocument,
  getIdImageSignedUrls,
  uploadIdImage,
} from './wizardApi.js'
import { supabase } from './supabase.js'

vi.mock('./supabase.js', () => ({
  supabase: {
    schema: vi.fn(),
    auth: { getSession: vi.fn() },
    rpc: vi.fn(),
  },
}))

// Minimal chainable Supabase query-builder mock. Every chain method returns the same
// builder so any call sequence (.insert().select().single(), .update().eq(), etc.) works;
// `.single`/`.maybeSingle` resolve independently of the bare-awaited `.then()` so a single
// builder can serve both an "existing row?" check and a subsequent insert/update.
function makeBuilder(defaultResponse = { data: null, error: null }) {
  const builder = {}
  ;['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit'].forEach((method) => {
    builder[method] = vi.fn(() => builder)
  })
  builder.single = vi.fn(() => Promise.resolve(defaultResponse))
  builder.maybeSingle = vi.fn(() => Promise.resolve(defaultResponse))
  builder.then = (resolve, reject) => Promise.resolve(defaultResponse).then(resolve, reject)
  return builder
}

describe('wizardApi', () => {
  let fromMock

  beforeEach(() => {
    window.sessionStorage.clear()
    fromMock = vi.fn(() => makeBuilder())
    supabase.schema.mockReturnValue({ from: fromMock })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initTransaction() inserts a new row into ttr.transactions and returns the created record', async () => {
    const transactionsBuilder = makeBuilder()
    transactionsBuilder.single.mockResolvedValue({ data: { id: 'tx-123' }, error: null })
    const partiesBuilder = makeBuilder({ data: [{ id: 'party-uuid-1' }], error: null })
    fromMock.mockImplementation((table) => (table === 'transactions' ? transactionsBuilder : partiesBuilder))

    const transactionId = await initTransaction({
      startData: { serviceType: 'bullion', scenario: 'sell', transactionRef: 'INV-1', dateTime: '2026-07-04T10:00' },
      financialData: { cashCurrency: 'AUD', cashAmount: '15000', lppFlag: false, isOtherDsProviderInvolved: false },
      parties: [{ id: 'new-1', type: 'individual', firstName: 'Jane', lastName: 'Doe' }],
      staffMember: { id: 'staff-1', reporting_entity_id: 're-1', full_name: 'Jane Staff', email: 'jane@example.com' },
    })

    expect(fromMock).toHaveBeenCalledWith('transactions')
    expect(transactionsBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        reporting_entity_id: 're-1',
        scenario: 'bullion_sell',
        transaction_ref: 'INV-1',
        cash_amount: 15000,
        aud_value: 15000,
      }),
    )
    expect(transactionId).toBe('tx-123')
    expect(window.sessionStorage.getItem('ttr.transactionId')).toBe('tx-123')
    expect(partiesBuilder.insert).toHaveBeenCalled()
  })

  it('preserves each party\'s original id after migration and flags it as migrated', async () => {
    const transactionsBuilder = makeBuilder()
    transactionsBuilder.single.mockResolvedValue({ data: { id: 'tx-123' }, error: null })
    const partiesBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'transactions' ? transactionsBuilder : partiesBuilder))

    await initTransaction({
      startData: { serviceType: 'bullion', scenario: 'sell', transactionRef: 'INV-1', dateTime: '2026-07-04T10:00' },
      financialData: { cashCurrency: 'AUD', cashAmount: '15000', lppFlag: false, isOtherDsProviderInvolved: false },
      parties: [
        { id: 'new-1', type: 'individual', firstName: 'Jane', lastName: 'Doe' },
        { id: 'new-2', type: 'company', entityName: 'Acme Pty Ltd' },
      ],
      staffMember: { id: 'staff-1', reporting_entity_id: 're-1', full_name: 'Jane Staff', email: 'jane@example.com' },
    })

    // The original id must stay stable — CustomerSearchPage's dedup check keys off it, and it
    // would break if a party's id changed after migration (see wizardFlow "duplicate party" bug).
    const stored = JSON.parse(window.sessionStorage.getItem('ttr.customers'))
    expect(stored).toEqual([
      expect.objectContaining({ id: 'new-1', firstName: 'Jane', lastName: 'Doe', _migrated: true }),
      expect.objectContaining({ id: 'new-2', entityName: 'Acme Pty Ltd', _migrated: true }),
    ])
  })

  it('migrateNewParties() only inserts parties not already migrated, leaving migrated ones untouched', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const partiesBuilder = makeBuilder({ error: null })
    fromMock.mockReturnValue(partiesBuilder)

    const updated = await migrateNewParties([
      { id: 'party-already-saved', type: 'individual', firstName: 'Jane', lastName: 'Doe', _migrated: true },
      { id: 'new-2', type: 'company', entityName: 'Acme Pty Ltd' },
    ])

    expect(partiesBuilder.insert).toHaveBeenCalledTimes(1)
    expect(partiesBuilder.insert).toHaveBeenCalledWith([
      expect.objectContaining({ entity_name: 'Acme Pty Ltd' }),
    ])
    expect(updated).toEqual([
      expect.objectContaining({ id: 'party-already-saved', _migrated: true }),
      expect.objectContaining({ id: 'new-2', entityName: 'Acme Pty Ltd', _migrated: true }),
    ])
    expect(JSON.parse(window.sessionStorage.getItem('ttr.customers'))).toEqual(updated)
  })

  it('migrateNewParties() is a no-op when every party is already migrated', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const partiesBuilder = makeBuilder()
    fromMock.mockReturnValue(partiesBuilder)

    const parties = [{ id: 'party-already-saved', type: 'individual', _migrated: true }]
    const updated = await migrateNewParties(parties)

    expect(partiesBuilder.insert).not.toHaveBeenCalled()
    expect(updated).toBe(parties)
  })

  it('migrateNewParties() copies an existing customer\'s aliases onto the newly-generated party id in ttr.party_aliases', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const partiesBuilder = makeBuilder({ data: [{ id: 'new-party-id' }], error: null })
    const aliasesBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'parties' ? partiesBuilder : aliasesBuilder))

    await migrateNewParties([
      { id: 'search-result-id', type: 'individual', firstName: 'Sarah', lastName: 'Austen', aliases: ['Sarah A. Austen-Smith'] },
    ])

    expect(partiesBuilder.insert).toHaveBeenCalledWith([
      expect.objectContaining({ first_name: 'Sarah', last_name: 'Austen' }),
    ])
    expect(partiesBuilder.select).toHaveBeenCalledWith('id')
    expect(aliasesBuilder.insert).toHaveBeenCalledWith([{ party_id: 'new-party-id', alias: 'Sarah A. Austen-Smith' }])
  })

  it('migrateNewParties() does not touch ttr.party_aliases for a party with no aliases', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const partiesBuilder = makeBuilder({ data: [{ id: 'new-party-id' }], error: null })
    const aliasesBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'parties' ? partiesBuilder : aliasesBuilder))

    await migrateNewParties([{ id: 'new-1', type: 'individual', firstName: 'Jane', lastName: 'Doe' }])

    expect(aliasesBuilder.insert).not.toHaveBeenCalled()
  })

  it('saveTransaction() updates the existing ttr.transactions row matched by transactionId', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-existing')
    const builder = makeBuilder({ error: null })
    fromMock.mockReturnValue(builder)

    await saveTransaction(
      { cashCurrency: 'AUD', cashAmount: '20000', lppFlag: false, isOtherDsProviderInvolved: false },
      { serviceType: 'bullion', scenario: 'buy', transactionRef: 'INV-2', dateTime: '2026-07-04T11:00' },
    )

    expect(fromMock).toHaveBeenCalledWith('transactions')
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'bullion_buy', transaction_ref: 'INV-2', cash_amount: 20000 }),
    )
    expect(builder.eq).toHaveBeenCalledWith('id', 'tx-existing')
  })

  it('saveCustomers() upserts each party record and syncs aliases in ttr.party_aliases', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const partiesBuilder = makeBuilder({ error: null })
    const aliasesBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'parties' ? partiesBuilder : aliasesBuilder))

    await saveCustomers([
      { id: 'party-1', type: 'individual', firstName: 'Jane', lastName: 'Doe', aliases: ['J. Doe'] },
    ])

    expect(partiesBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Jane', last_name: 'Doe' }))
    expect(partiesBuilder.eq).toHaveBeenCalledWith('id', 'party-1')
    expect(aliasesBuilder.delete).toHaveBeenCalled()
    expect(aliasesBuilder.insert).toHaveBeenCalledWith([{ party_id: 'party-1', alias: 'J. Doe' }])
  })

  it('loadCustomers() returns all ttr.parties rows belonging to the current transactionId', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({
      data: [{ id: 'p1', party_type: 'individual', first_name: 'Jane', last_name: 'Doe', party_aliases: [] }],
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const result = await loadCustomers()

    expect(fromMock).toHaveBeenCalledWith('parties')
    expect(builder.eq).toHaveBeenCalledWith('transaction_id', 'tx-1')
    expect(result).toEqual([expect.objectContaining({ id: 'p1', type: 'individual', firstName: 'Jane', lastName: 'Doe' })])
  })

  it('deleteParty() deletes the party row scoped to the current transaction', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ error: null })
    fromMock.mockReturnValue(builder)

    await deleteParty('party-1')

    expect(fromMock).toHaveBeenCalledWith('parties')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'party-1')
    expect(builder.eq).toHaveBeenCalledWith('transaction_id', 'tx-1')
  })

  it('deleteParty() throws when the delete fails (e.g. a foreign-key restriction from a later step referencing this party)', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ error: new Error('foreign key violation') })
    fromMock.mockReturnValue(builder)

    await expect(deleteParty('party-1')).rejects.toThrow('foreign key violation')
  })

  it('saveConductingPerson() upserts the conducting person record and CP aliases', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const cpBuilder = makeBuilder({ data: null, error: null }) // maybeSingle "existing?" check -> none found
    cpBuilder.single.mockResolvedValue({ data: { id: 'cp-1' }, error: null }) // insert().select('id').single()
    const aliasBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'conducting_persons' ? cpBuilder : aliasBuilder))

    await saveConductingPerson({
      hasConductingPerson: 'yes',
      representedPartyId: 'party-1',
      fullName: 'Alice Brown',
      aliases: ['A. Brown'],
      residentialAddress: { street: '5 High St', suburb: 'Richmond', state: 'VIC', postcode: '3121', country: 'Australia' },
      relationship: 'Agent',
      authorityToAct: 'Power of attorney',
    })

    expect(cpBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({ transaction_id: 'tx-1', full_name: 'Alice Brown' }))
    expect(aliasBuilder.insert).toHaveBeenCalledWith([{ conducting_person_id: 'cp-1', alias: 'A. Brown' }])
  })

  it('saveConductingPerson() saves dob_known true with the date when dobKnown is the string "yes" — dobKnown is never a boolean', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const cpBuilder = makeBuilder({ data: null, error: null })
    cpBuilder.single.mockResolvedValue({ data: { id: 'cp-1' }, error: null })
    const aliasBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'conducting_persons' ? cpBuilder : aliasBuilder))

    await saveConductingPerson({
      hasConductingPerson: 'yes',
      representedPartyId: 'party-1',
      fullName: 'Alice Brown',
      dobKnown: 'yes',
      dateOfBirth: '1982-04-10',
      residentialAddress: { street: '5 High St', suburb: 'Richmond', state: 'VIC', postcode: '3121', country: 'Australia' },
      relationship: 'Agent',
      authorityToAct: 'Power of attorney',
    })

    expect(cpBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ dob_known: true, date_of_birth: '1982-04-10' }),
    )
  })

  it('saveConductingPerson() saves dob_known false and clears the date when dobKnown is "no", even if a stale dateOfBirth value is present', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const cpBuilder = makeBuilder({ data: null, error: null })
    cpBuilder.single.mockResolvedValue({ data: { id: 'cp-1' }, error: null })
    const aliasBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'conducting_persons' ? cpBuilder : aliasBuilder))

    await saveConductingPerson({
      hasConductingPerson: 'yes',
      representedPartyId: 'party-1',
      fullName: 'Alice Brown',
      dobKnown: 'no',
      dateOfBirth: '1982-04-10', // stale value that must not leak into the saved row
      residentialAddress: { street: '5 High St', suburb: 'Richmond', state: 'VIC', postcode: '3121', country: 'Australia' },
      relationship: 'Agent',
      authorityToAct: 'Power of attorney',
    })

    expect(cpBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ dob_known: false, date_of_birth: null }),
    )
  })

  it('saveConductingPerson() saves is_employee as the string "yes" when isEmployee is "yes" — isEmployee is never a boolean', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const cpBuilder = makeBuilder({ data: null, error: null })
    cpBuilder.single.mockResolvedValue({ data: { id: 'cp-1' }, error: null })
    const aliasBuilder = makeBuilder({ error: null })
    fromMock.mockImplementation((table) => (table === 'conducting_persons' ? cpBuilder : aliasBuilder))

    await saveConductingPerson({
      hasConductingPerson: 'yes',
      representedPartyId: 'party-1',
      fullName: 'Tom Employee',
      dobKnown: 'no',
      residentialAddress: { street: '8 Staff St', suburb: 'Dandenong', state: 'VIC', postcode: '3175', country: 'Australia' },
      relationship: 'Employee',
      authorityToAct: 'Employed staff member authorised to transact on behalf of the company.',
      isEmployee: 'yes',
      employeeRole: 'Store manager',
    })

    expect(cpBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_employee: 'yes', employee_role: 'Store manager' }),
    )
  })

  it('saveIdVerifications() upserts all verification objects keyed by personId with correct data', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: null }) // maybeSingle "existing?" -> none, then bare-awaited insert
    fromMock.mockReturnValue(builder)

    await saveIdVerifications({
      'party-party-1': {
        verificationMethod: 'Sighted original document',
        documentType: 'Passport',
        documentNumber: 'P123456',
        isComplete: true,
      },
    })

    expect(fromMock).toHaveBeenCalledWith('id_verifications')
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_id: 'tx-1', party_id: 'party-1', document_number: 'P123456' }),
    )
  })

  it('saveIdVerifications() derives verification_basis from the chosen method, so a re-capture that links to the ID on file is still stored as new_capture', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)

    await saveIdVerifications({
      'party-party-1': {
        verificationMethod: 'Sighted original document',
        documentType: 'Passport',
        documentNumber: 'P123456',
        priorVerificationId: 'idv-old-1',
        newCaptureReason: 'stored_copy_unclear',
        isComplete: true,
      },
    })

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        verification_basis: 'new_capture',
        prior_verification_id: 'idv-old-1',
        new_capture_reason: 'stored_copy_unclear',
        reliance_reason: null,
      }),
    )
  })

  it('saveIdVerifications() stores a reliance row with no new_capture_reason, keeping the two justification fields mutually exclusive', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)

    await saveIdVerifications({
      'party-party-1': {
        verificationMethod: 'Relied on prior identification',
        documentType: 'Passport',
        documentNumber: 'P123456',
        priorVerificationId: 'idv-old-1',
        relianceReason: 'prior_id_reviewed_still_valid',
        newCaptureReason: 'other',
        isComplete: true,
      },
    })

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        verification_basis: 'relied_on_prior_identification',
        reliance_reason: 'prior_id_reviewed_still_valid',
        new_capture_reason: null,
      }),
    )
  })

  it('fetchVerificationForDocument() returns the single matching record, or null when the number is unused', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ id: 'idv-1', document_number: 'DL999' }], error: null })

    const hit = await fetchVerificationForDocument({ documentType: 'Driver licence', documentNumber: 'DL999' })
    expect(supabase.rpc).toHaveBeenCalledWith('get_verification_for_document', {
      p_document_type: 'Driver licence',
      p_document_number: 'DL999',
      p_exclude_id: null,
    })
    expect(hit).toEqual({ id: 'idv-1', document_number: 'DL999' })

    supabase.rpc.mockResolvedValue({ data: [], error: null })
    expect(await fetchVerificationForDocument({ documentType: 'Passport', documentNumber: 'PA1' })).toBeNull()
  })

  it('fetchVerificationForDocument() passes excludeId so a saved record does not report colliding with itself', async () => {
    supabase.rpc.mockResolvedValue({ data: [], error: null })

    await fetchVerificationForDocument({ documentType: 'Passport', documentNumber: 'PA1', excludeId: 'idv-self' })

    expect(supabase.rpc).toHaveBeenCalledWith(
      'get_verification_for_document',
      expect.objectContaining({ p_exclude_id: 'idv-self' }),
    )
  })

  it('fetchVerificationForDocument() short-circuits without querying when the document is not yet identified', async () => {
    supabase.rpc.mockResolvedValue({ data: [], error: null })

    expect(await fetchVerificationForDocument({ documentType: '', documentNumber: 'DL999' })).toBeNull()
    expect(await fetchVerificationForDocument({ documentType: 'Passport', documentNumber: '   ' })).toBeNull()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('saveRecipientDelivery() upserts the delivery record for the current transactionId', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: null }) // maybeSingle "existing?" -> none
    fromMock.mockReturnValue(builder)

    await saveRecipientDelivery({
      recipientIsParty: 'yes',
      selectedPartyId: 'party-1',
      purposeOfTransfer: 'Collecting bullion',
      deliveryMethod: 'Collected',
    })

    expect(fromMock).toHaveBeenCalledWith('recipient_deliveries')
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_id: 'tx-1', recipient_is_party: true, purpose_of_transfer: 'Collecting bullion' }),
    )
  })

  it('saveBullionItems() deletes all existing ttr.bullion_items for the transaction then inserts the provided items', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ error: null })
    fromMock.mockReturnValue(builder)

    await saveBullionItems([
      { metalType: 'Gold', productType: 'Bar', purity: '999.9', quantity: '1', weight: '10', weightUnit: 'grams', unitPrice: '100', lineTotal: 1000 },
    ])

    expect(fromMock).toHaveBeenCalledWith('bullion_items')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('transaction_id', 'tx-1')
    expect(builder.insert).toHaveBeenCalledWith([
      expect.objectContaining({ transaction_id: 'tx-1', metal_type: 'Gold', sort_order: 0 }),
    ])
  })

  it('savePreciousMetalItems() deletes all existing ttr.precious_metal_items for the transaction then bulk-inserts the provided items, mapping serialNumber to serial_number', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ error: null })
    fromMock.mockReturnValue(builder)

    await savePreciousMetalItems([
      { metalType: 'Gold', quantity: '1', weight: '10', weightUnit: 'grams', unitPrice: '100', lineTotal: 1000, serialNumber: 'SN-1' },
    ])

    expect(fromMock).toHaveBeenCalledWith('precious_metal_items')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.insert).toHaveBeenCalledWith([
      expect.objectContaining({ transaction_id: 'tx-1', metal_type: 'Gold', serial_number: 'SN-1' }),
    ])
  })

  it('completeTransaction() calls the complete-transaction edge function and returns the response errors array', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ errors: [{ field: 'cashAmount', message: 'Cash amount missing' }] }),
    })

    const result = await completeTransaction()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/complete-transaction'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual({ ok: false, errors: [{ field: 'cashAmount', message: 'Cash amount missing' }] })
  })

  it('loadTransaction() returns null — and does not query the DB — when there is no active transactionId', async () => {
    const result = await loadTransaction()

    expect(result).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('loadTransaction() derives scenario and serviceType from the DB scenario code — the source downstream pages rely on', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({
      data: {
        id: 'tx-1',
        scenario: 'precious_metal_buy',
        transaction_ref: 'INV-1',
        transaction_datetime: '2026-07-04T10:00:00Z',
        cash_currency: 'AUD',
        cash_amount: 5000,
        aud_value: 5000,
      },
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const result = await loadTransaction()

    expect(result.scenario).toBe('buy')
    expect(result.serviceType).toBe('precious_metal')
  })

  it('loadTransaction() returns the physical cash amount for foreign-currency transactions — not blank', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-2')
    const builder = makeBuilder({
      data: {
        id: 'tx-2',
        scenario: 'bullion_buy',
        transaction_ref: 'INV-2',
        transaction_datetime: '2026-07-04T10:00:00Z',
        cash_currency: 'other',
        cash_amount: 8000,
        aud_value: 12160,
        fx_currency_code: 'USD',
        fx_currency_amount: 8000,
        fx_rate: 1.52,
        fx_rate_source: 'Internal POS rate',
      },
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const result = await loadTransaction()

    expect(result.cashAmount).toBe('8000')
  })

  // The lookup used to filter on status = 'draft', making a completed ref indistinguishable from
  // an unused one — StartTransactionPage then opened the wizard on a ref that uq_tx_ref_per_entity
  // would reject at insert time, two screens later.
  describe('findTransactionByRef()', () => {
    const rowFor = (status) => ({
      id: 'tx-9',
      scenario: 'bullion_sell',
      transaction_ref: 'INV-9',
      transaction_datetime: '2026-07-04T10:00:00Z',
      status,
      cash_currency: 'AUD',
      cash_amount: 15000,
      aud_value: 15000,
    })

    it('returns a completed transaction with its status, without adopting it as the active transaction', async () => {
      const builder = makeBuilder({ data: rowFor('complete'), error: null })
      fromMock.mockReturnValue(builder)

      const result = await findTransactionByRef('INV-9')

      expect(result).toMatchObject({ transactionRef: 'INV-9', status: 'complete' })
      // Adopting a completed row's id would wedge the wizard — trg_lock_completed blocks every
      // subsequent update and delete against it.
      expect(window.sessionStorage.getItem('ttr.transactionId')).toBeNull()
      // The status filter is gone, so completed rows are visible to the caller.
      expect(builder.eq).toHaveBeenCalledWith('transaction_ref', 'INV-9')
      expect(builder.eq).not.toHaveBeenCalledWith('status', 'draft')
    })

    it('adopts a draft as the active transaction so the wizard resumes it', async () => {
      fromMock.mockReturnValue(makeBuilder({ data: rowFor('draft'), error: null }))

      const result = await findTransactionByRef('INV-9')

      expect(result).toMatchObject({ transactionRef: 'INV-9', status: 'draft' })
      expect(window.sessionStorage.getItem('ttr.transactionId')).toBe('tx-9')
    })

    it('returns null for an unused reference', async () => {
      fromMock.mockReturnValue(makeBuilder({ data: null, error: null }))

      expect(await findTransactionByRef('INV-UNUSED')).toBeNull()
      expect(window.sessionStorage.getItem('ttr.transactionId')).toBeNull()
    })
  })

  it('deleteTransaction() calls the delete-draft-transaction edge function with the current transactionId and clears it', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })

    await deleteTransaction()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/delete-draft-transaction'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transactionId: 'tx-1' }) }),
    )
    expect(window.sessionStorage.getItem('ttr.transactionId')).toBeNull()
  })

  it('loadConductingPerson() returns {hasConductingPerson: "no"} — not null — when no record exists', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)

    const result = await loadConductingPerson()

    expect(result).toEqual({ hasConductingPerson: 'no' })
  })

  it('loadConductingPerson() converts dob_known to the yes/no string the radios use, so a reloaded draft keeps its answer', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const row = { id: 'cp-1', full_name: 'Priya Agent', dob_known: true, date_of_birth: '1982-04-10', cp_aliases: [] }
    fromMock.mockReturnValue(makeBuilder({ data: row, error: null }))

    const loaded = await loadConductingPerson()

    // Was passing the raw boolean straight through, which the page reads as unselected.
    expect(loaded.dobKnown).toBe('yes')
    expect(loaded.dateOfBirth).toBe('1982-04-10')

    fromMock.mockReturnValue(makeBuilder({ data: { ...row, dob_known: false, date_of_birth: null }, error: null }))
    expect((await loadConductingPerson()).dobKnown).toBe('no')
  })

  it('loadPreciousMetalItems() orders by sort_order and maps rows to camelCase', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({
      data: [
        {
          id: 'pmi-1',
          direction: 'Provided to customer',
          metal_type: 'Gold',
          quantity: 2,
          weight: 5,
          weight_unit: 'grams',
          unit_price_aud: 10,
          line_total_aud: 100,
          description: '',
          serial_number: 'SN-1',
        },
      ],
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const result = await loadPreciousMetalItems()

    expect(fromMock).toHaveBeenCalledWith('precious_metal_items')
    expect(builder.order).toHaveBeenCalledWith('sort_order')
    expect(result).toEqual([
      expect.objectContaining({ metalType: 'Gold', quantity: '2', weight: '5', unitPrice: '10', lineTotal: 100, serialNumber: 'SN-1' }),
    ])
  })

  it('searchIndividualCustomers() includes gender in the mapped result', async () => {
    supabase.rpc.mockResolvedValue({
      data: [{ party_id: 'p1', first_name: 'Jane', last_name: 'Doe', gender: 'F', date_of_birth: '1985-06-15' }],
      error: null,
    })

    const result = await searchIndividualCustomers({ firstName: 'Jane', lastName: 'Doe' })

    expect(result[0].gender).toBe('F')
  })

  it('searchIndividualCustomers() includes the middle name in displayName — it must not be silently dropped', async () => {
    supabase.rpc.mockResolvedValue({
      data: [{ party_id: 'p1', first_name: 'Jane', middle_name: 'Alice', last_name: 'Citizen', date_of_birth: '1985-06-15' }],
      error: null,
    })

    const result = await searchIndividualCustomers({ firstName: 'Jane', lastName: 'Citizen' })

    expect(result[0].displayName).toBe('Jane Alice Citizen')
  })

  it('searchCompanyCustomers() includes principalActivity and the trust fields in the mapped result — they must not be silently dropped on reuse', async () => {
    supabase.rpc.mockResolvedValue({
      data: [{
        party_id: 'p2',
        entity_name: 'Southern Cross Metals Trust',
        legal_form: 'Trust',
        principal_activity: 'Precious metal trading',
        is_express_trust: true,
        trust_type_other: 'Discretionary trust',
        trust_name: 'Southern Cross Family Trust',
      }],
      error: null,
    })

    const result = await searchCompanyCustomers({ entityName: 'Southern Cross' })

    expect(result[0]).toEqual(expect.objectContaining({
      principalActivity: 'Precious metal trading',
      isExpressTrust: 'Yes',
      trustTypeOther: 'Discretionary trust',
      trustName: 'Southern Cross Family Trust',
    }))
  })

  it('searchCompanyCustomers() maps is_express_trust false to "No" and null/absent to ""', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        { party_id: 'p3', entity_name: 'No Trust Pty Ltd', is_express_trust: false },
        { party_id: 'p4', entity_name: 'Acme Pty Ltd', is_express_trust: null },
      ],
      error: null,
    })

    const result = await searchCompanyCustomers({ entityName: 'x' })

    expect(result[0].isExpressTrust).toBe('No')
    expect(result[1].isExpressTrust).toBe('')
  })

  it('uploadIdImage() POSTs a multipart FormData payload (no explicit Content-Type header) and returns the parsed response', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ imageId: 'img-1', path: 'x', sha256: 'y' }) })

    const blob = new Blob(['data'], { type: 'image/jpeg' })
    const result = await uploadIdImage({ transactionId: 'tx-1', personType: 'party', personId: 'party-1', side: 'front', blob })

    const [url, options] = globalThis.fetch.mock.calls[0]
    expect(url).toContain('/upload-id-image')
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.headers['Content-Type']).toBeUndefined()
    expect(result).toEqual({ imageId: 'img-1', path: 'x', sha256: 'y' })
  })

  it('getIdImageSignedUrls() mints URLs via the get-id-image-urls Edge Function, so the view is logged server-side rather than signed directly by the client', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ urls: { 'img-1': 'https://signed/one', 'img-2': 'https://signed/two' } }),
    })

    const result = await getIdImageSignedUrls(['img-1', 'img-2'])

    const [url, options] = globalThis.fetch.mock.calls[0]
    expect(url).toContain('/get-id-image-urls')
    expect(JSON.parse(options.body)).toEqual({ imageIds: ['img-1', 'img-2'] })
    expect(result).toEqual({ 'img-1': 'https://signed/one', 'img-2': 'https://signed/two' })
  })

  it('getIdImageSignedUrls() makes no request and returns an empty map when given no usable ids — nothing is logged for a no-op', async () => {
    globalThis.fetch = vi.fn()

    expect(await getIdImageSignedUrls([null, undefined, ''])).toEqual({})
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('getIdImageSignedUrls() returns an empty map when the function fails, so a failed access log never yields a viewable URL', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to record image access' }),
    })

    expect(await getIdImageSignedUrls(['img-1'])).toEqual({})
  })

  it('surfaces the Supabase error object when a query fails (e.g. loadCustomers)', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    const builder = makeBuilder({ data: null, error: { message: 'connection refused' } })
    fromMock.mockReturnValue(builder)

    await expect(loadCustomers()).rejects.toEqual({ message: 'connection refused' })
  })

  it('completeTransaction() rejects with a catchable error — not an unhandled rejection — when the network request itself fails (medium: TC-255)', async () => {
    window.sessionStorage.setItem('ttr.transactionId', 'tx-1')
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    await expect(completeTransaction()).rejects.toThrow('Network error')
  })
})
