import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, X } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { deleteTransaction, loadConductingPerson, loadCustomers, saveConductingPerson } from '../../lib/wizardApi.js'
import styles from './ConductingPersonPage.module.css'

const STATES = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']

const RELATIONSHIP_OPTIONS = [
  'Self',
  'Employee',
  'Director',
  'Authorised representative',
  'Agent',
  'Family member',
  'Trustee',
  'Partner',
  'Other',
]

const emptyAddress = () => ({
  street: '',
  suburb: '',
  state: '',
  postcode: '',
  country: 'Australia',
})

const initialData = () => ({
  hasConductingPerson: null,
  representedPartyId: '',
  fullName: '',
  aliases: [],
  dobKnown: null,
  dateOfBirth: '',
  residentialAddress: emptyAddress(),
  postalAddressDifferent: false,
  postalAddress: emptyAddress(),
  phone: '',
  occupation: '',
  relationship: '',
  relationshipOther: '',
  authorityToAct: '',
  isEmployee: null,
  employeeRole: '',
  actingViaEntity: null,
  entityName: '',
  entityAddress: emptyAddress(),
  entityRegType: '',
  entityRegNumber: '',
})

const hasFormData = (data) =>
  !!(data.fullName || data.phone || data.occupation || data.authorityToAct)

const ConductingPersonPage = () => {
  const navigate = useNavigate()
  const [parties, setParties] = useState([])
  const [data, setData] = useState(initialData)
  const [errors, setErrors] = useState({})
  const [showExitModal, setShowExitModal] = useState(false)
  const [showClearWarning, setShowClearWarning] = useState(false)

  useEffect(() => {
    Promise.all([loadCustomers(), loadConductingPerson()]).then(([loaded, cp]) => {
      setParties(loaded)
      if (cp) setData((prev) => ({ ...prev, ...cp }))
    })
  }, [])

  const updateData = (updates) => setData((prev) => ({ ...prev, ...updates }))

  const updateAddress = (type, field, value) =>
    setData((prev) => ({ ...prev, [type]: { ...prev[type], [field]: value } }))

  const addAlias = () => updateData({ aliases: [...data.aliases, ''] })

  const updateAlias = (i, value) =>
    updateData({ aliases: data.aliases.map((a, idx) => (idx === i ? value : a)) })

  const removeAlias = (i) =>
    updateData({ aliases: data.aliases.filter((_, idx) => idx !== i) })

  const handleHasConductingPersonChange = (value) => {
    if (value === 'no' && data.hasConductingPerson === 'yes' && hasFormData(data)) {
      setShowClearWarning(true)
      return
    }
    updateData({ hasConductingPerson: value })
  }

  const confirmClear = () => {
    setData({ ...initialData(), hasConductingPerson: 'no' })
    setShowClearWarning(false)
  }

  const validate = () => {
    const e = {}

    if (data.hasConductingPerson === null) {
      e.hasConductingPerson = 'Select whether a different person is conducting the transaction.'
    }

    if (data.hasConductingPerson === 'yes') {
      if (!data.representedPartyId) {
        e.representedPartyId = 'Select the party this person is acting for.'
      }
      if (!data.fullName.trim()) {
        e.fullName = 'Enter the full legal name.'
      }
      const ra = data.residentialAddress
      if (!ra.street.trim() || !ra.suburb.trim() || !ra.state.trim() || !ra.postcode.trim()) {
        e.residentialAddress = 'Enter the residential address.'
      }
      if (!data.relationship) {
        e.relationship = 'Select the relationship to the party.'
      }
      if (data.relationship === 'Other' && !data.relationshipOther.trim()) {
        e.relationshipOther = 'Describe the relationship.'
      }
      if (!data.authorityToAct.trim()) {
        e.authorityToAct = 'Describe the authority to act.'
      }
      if (data.isEmployee === 'yes' && !data.employeeRole.trim()) {
        e.employeeRole = 'Enter the employee title or role.'
      }
      if (data.actingViaEntity === 'yes') {
        if (!data.entityName.trim()) e.entityName = 'Enter the entity name.'
        const ea = data.entityAddress
        if (!ea.street.trim() || !ea.suburb.trim() || !ea.state.trim() || !ea.postcode.trim()) {
          e.entityAddress = 'Enter the entity address.'
        }
      }
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleContinue = async () => {
    if (!validate()) return
    await saveConductingPerson(data)
    navigate('/id-verification')
  }

  const getPartyLabel = (party) => {
    const type = party.type === 'individual' ? 'Individual' : 'Company'
    const id = party.abnAcn ? ` — ${party.abnAcn}` : ''
    return `${party.displayName} (${type})${id}`
  }

  const isComplete = () => {
    if (data.hasConductingPerson === 'no') return true
    if (data.hasConductingPerson === 'yes') {
      return !!(
        data.representedPartyId &&
        data.fullName &&
        data.residentialAddress.street &&
        data.relationship &&
        data.authorityToAct
      )
    }
    return false
  }

  return (
    <WizardFrame
      title="Conducting Person Details"
      subtitle="Record the person physically conducting the transaction if they are acting on behalf of a customer or party."
      helperText="Step 4"
      onBack={() => navigate('/party-details')}
      onExit={() => setShowExitModal(true)}
      actions={<Button onClick={handleContinue}>Continue</Button>}
    >
      <div className={styles.card}>
        {/* Section 1: Decision */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Who is conducting the transaction?</h2>
          <FormField
            label="Is a different person conducting the transaction on behalf of a party?"
            error={errors.hasConductingPerson}
          >
            <div data-testid="hasConductingPerson-group" className={styles.radioGroup}>
              <label className={styles.radioLabel}>
                <input
                  type="radio"
                  id="hasConductingPerson-no"
                  name="hasConductingPerson"
                  checked={data.hasConductingPerson === 'no'}
                  onChange={() => handleHasConductingPersonChange('no')}
                />
                No
              </label>
              <label className={styles.radioLabel}>
                <input
                  type="radio"
                  name="hasConductingPerson"
                  checked={data.hasConductingPerson === 'yes'}
                  onChange={() => handleHasConductingPersonChange('yes')}
                />
                Yes
              </label>
            </div>
          </FormField>

          {data.hasConductingPerson === 'no' && (
            <div className={styles.successBanner}>
              <CheckCircle2 aria-hidden="true" size={18} />
              <p>The conducting person is the same as the customer / party.</p>
            </div>
          )}
        </div>

        {data.hasConductingPerson === 'yes' && (
          <>
            {/* Section 2: Which party */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Acting for which party?</h2>
              <FormField
                label="Customer / party being represented"
                labelFor="representedPartyId"
                error={errors.representedPartyId}
              >
                <select
                  id="representedPartyId"
                  value={data.representedPartyId}
                  onChange={(e) => updateData({ representedPartyId: e.target.value })}
                  className={styles.select}
                >
                  <option value="">Select a party…</option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {getPartyLabel(p)}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            {/* Section 3: Person details */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Conducting person details</h2>

              <FormField label="Full legal name" labelFor="fullName" error={errors.fullName}>
                <input
                  id="fullName"
                  type="text"
                  value={data.fullName}
                  onChange={(e) => updateData({ fullName: e.target.value })}
                  className={styles.input}
                />
              </FormField>

              <FormField label="Other names or aliases">
                {data.aliases.map((alias, i) => (
                  <div key={i} className={styles.aliasRow}>
                    <input
                      type="text"
                      value={alias}
                      onChange={(e) => updateAlias(i, e.target.value)}
                      placeholder="Enter alias"
                      className={styles.input}
                    />
                    <button
                      type="button"
                      onClick={() => removeAlias(i)}
                      className={styles.aliasRemove}
                      aria-label={`Remove alias ${alias}`}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addAlias} className={styles.addAlias}>
                  + Add alias
                </button>
              </FormField>

              <FormField label="Is the date of birth known?">
                <div className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      id="dobKnown-yes"
                      name="dobKnown"
                      checked={data.dobKnown === 'yes'}
                      onChange={() => updateData({ dobKnown: 'yes' })}
                    />
                    Yes
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="dobKnown"
                      checked={data.dobKnown === 'no'}
                      onChange={() => updateData({ dobKnown: 'no', dateOfBirth: '' })}
                    />
                    No
                  </label>
                </div>
              </FormField>

              {data.dobKnown === 'yes' && (
                <FormField label="Date of birth" labelFor="dateOfBirth">
                  <DatePicker
                    id="dateOfBirth"
                    value={data.dateOfBirth}
                    onChange={(date) => updateData({ dateOfBirth: date })}
                  />
                </FormField>
              )}

              <FormField
                label="Residential address"
                labelFor="resStreet"
                error={errors.residentialAddress}
              >
                <div className={styles.addressGrid}>
                  <input
                    id="resStreet"
                    type="text"
                    placeholder="Street address"
                    value={data.residentialAddress.street}
                    onChange={(e) => updateAddress('residentialAddress', 'street', e.target.value)}
                    className={styles.input}
                    aria-label="Street address"
                  />
                  <div className={styles.grid2}>
                    <input
                      type="text"
                      placeholder="Suburb"
                      value={data.residentialAddress.suburb}
                      onChange={(e) => updateAddress('residentialAddress', 'suburb', e.target.value)}
                      className={styles.input}
                      aria-label="Suburb"
                    />
                    <select
                      value={data.residentialAddress.state}
                      onChange={(e) => updateAddress('residentialAddress', 'state', e.target.value)}
                      className={styles.select}
                      aria-label="State"
                    >
                      <option value="">State…</option>
                      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className={styles.grid2}>
                    <input
                      type="text"
                      placeholder="Postcode"
                      value={data.residentialAddress.postcode}
                      onChange={(e) => updateAddress('residentialAddress', 'postcode', e.target.value)}
                      className={styles.input}
                      aria-label="Postcode"
                    />
                    <input
                      type="text"
                      placeholder="Country"
                      value={data.residentialAddress.country}
                      onChange={(e) => updateAddress('residentialAddress', 'country', e.target.value)}
                      className={styles.input}
                      aria-label="Country"
                    />
                  </div>
                </div>
              </FormField>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={data.postalAddressDifferent === true}
                  onChange={(e) =>
                    updateData({
                      postalAddressDifferent: e.target.checked,
                      postalAddress: e.target.checked ? data.postalAddress : emptyAddress(),
                    })
                  }
                />
                Postal address is different
              </label>

              {data.postalAddressDifferent && (
                <FormField label="Postal address" labelFor="postStreet">
                  <div className={styles.addressGrid}>
                    <input
                      id="postStreet"
                      type="text"
                      placeholder="Street / PO Box"
                      value={data.postalAddress.street}
                      onChange={(e) => updateAddress('postalAddress', 'street', e.target.value)}
                      className={styles.input}
                      aria-label="Street / PO Box"
                    />
                    <div className={styles.grid2}>
                      <input
                        type="text"
                        placeholder="Suburb"
                        value={data.postalAddress.suburb}
                        onChange={(e) => updateAddress('postalAddress', 'suburb', e.target.value)}
                        className={styles.input}
                        aria-label="Suburb"
                      />
                      <select
                        value={data.postalAddress.state}
                        onChange={(e) => updateAddress('postalAddress', 'state', e.target.value)}
                        className={styles.select}
                        aria-label="State"
                      >
                        <option value="">State…</option>
                        {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className={styles.grid2}>
                      <input
                        type="text"
                        placeholder="Postcode"
                        value={data.postalAddress.postcode}
                        onChange={(e) => updateAddress('postalAddress', 'postcode', e.target.value)}
                        className={styles.input}
                        aria-label="Postcode"
                      />
                      <input
                        type="text"
                        placeholder="Country"
                        value={data.postalAddress.country}
                        onChange={(e) => updateAddress('postalAddress', 'country', e.target.value)}
                        className={styles.input}
                        aria-label="Country"
                      />
                    </div>
                  </div>
                </FormField>
              )}

              <FormField label="Phone number" labelFor="phone">
                <input
                  id="phone"
                  type="tel"
                  value={data.phone}
                  onChange={(e) => updateData({ phone: e.target.value })}
                  className={styles.input}
                />
              </FormField>

              <FormField label="Occupation, job title, or principal activity" labelFor="occupation">
                <input
                  id="occupation"
                  type="text"
                  value={data.occupation}
                  onChange={(e) => updateData({ occupation: e.target.value })}
                  className={styles.input}
                />
              </FormField>
            </div>

            {/* Section 4: Relationship & Authority */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Relationship to the customer / party</h2>

              <FormField
                label="Relationship to the customer / party"
                labelFor="relationship"
                error={errors.relationship}
              >
                <select
                  id="relationship"
                  value={data.relationship}
                  onChange={(e) => updateData({ relationship: e.target.value })}
                  className={styles.select}
                >
                  <option value="">Select relationship…</option>
                  {RELATIONSHIP_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </FormField>

              {data.relationship === 'Other' && (
                <FormField
                  label="Describe relationship"
                  labelFor="relationshipOther"
                  error={errors.relationshipOther}
                >
                  <input
                    id="relationshipOther"
                    type="text"
                    value={data.relationshipOther}
                    onChange={(e) => updateData({ relationshipOther: e.target.value })}
                    className={styles.input}
                  />
                </FormField>
              )}

              <FormField
                label="Authority to act"
                labelFor="authorityToAct"
                helperText="Examples: company director, signed authority letter, employee authorised by employer, trustee acting for trust"
                error={errors.authorityToAct}
              >
                <textarea
                  id="authorityToAct"
                  value={data.authorityToAct}
                  onChange={(e) => updateData({ authorityToAct: e.target.value })}
                  rows={3}
                  placeholder="Describe how this person is authorised to act for the customer or party."
                  className={styles.textarea}
                />
              </FormField>

              <FormField
                label="Is the conducting person an employee of the customer / party?"
              >
                <div data-testid="isEmployee-group" className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      id="isEmployee-yes"
                      name="isEmployee"
                      checked={data.isEmployee === 'yes'}
                      onChange={() => updateData({ isEmployee: 'yes' })}
                    />
                    Yes
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="isEmployee"
                      checked={data.isEmployee === 'no'}
                      onChange={() => updateData({ isEmployee: 'no', employeeRole: '' })}
                    />
                    No
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="isEmployee"
                      checked={data.isEmployee === 'unknown'}
                      onChange={() => updateData({ isEmployee: 'unknown', employeeRole: '' })}
                    />
                    Unknown
                  </label>
                </div>
              </FormField>

              {data.isEmployee === 'yes' && (
                <FormField
                  label="Employee title or role"
                  labelFor="employeeRole"
                  error={errors.employeeRole}
                >
                  <input
                    id="employeeRole"
                    type="text"
                    value={data.employeeRole}
                    onChange={(e) => updateData({ employeeRole: e.target.value })}
                    placeholder="e.g. Store manager, Director, Accounts officer"
                    className={styles.input}
                  />
                </FormField>
              )}
            </div>

            {/* Section 5: Another entity */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Another entity involved</h2>

              <FormField
                label="Is the conducting person acting through another entity?"
              >
                <div data-testid="actingViaEntity-group" className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      id="actingViaEntity-no"
                      name="actingViaEntity"
                      checked={data.actingViaEntity === 'no'}
                      onChange={() =>
                        updateData({
                          actingViaEntity: 'no',
                          entityName: '',
                          entityAddress: emptyAddress(),
                          entityRegType: '',
                          entityRegNumber: '',
                        })
                      }
                    />
                    No
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="actingViaEntity"
                      checked={data.actingViaEntity === 'yes'}
                      onChange={() => updateData({ actingViaEntity: 'yes' })}
                    />
                    Yes
                  </label>
                </div>
              </FormField>

              {data.actingViaEntity === 'yes' && (
                <>
                  <FormField
                    label="Entity name"
                    labelFor="entityName"
                    error={errors.entityName}
                  >
                    <input
                      id="entityName"
                      type="text"
                      value={data.entityName}
                      onChange={(e) => updateData({ entityName: e.target.value })}
                      className={styles.input}
                    />
                  </FormField>

                  <FormField
                    label="Entity address"
                    labelFor="entityStreet"
                    error={errors.entityAddress}
                  >
                    <div className={styles.addressGrid}>
                      <input
                        id="entityStreet"
                        type="text"
                        placeholder="Street address"
                        value={data.entityAddress.street}
                        onChange={(e) => updateAddress('entityAddress', 'street', e.target.value)}
                        className={styles.input}
                        aria-label="Street address"
                      />
                      <div className={styles.grid2}>
                        <input
                          type="text"
                          placeholder="Suburb"
                          value={data.entityAddress.suburb}
                          onChange={(e) => updateAddress('entityAddress', 'suburb', e.target.value)}
                          className={styles.input}
                          aria-label="Suburb"
                        />
                        <select
                          value={data.entityAddress.state}
                          onChange={(e) => updateAddress('entityAddress', 'state', e.target.value)}
                          className={styles.select}
                          aria-label="State"
                        >
                          <option value="">State…</option>
                          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className={styles.grid2}>
                        <input
                          type="text"
                          placeholder="Postcode"
                          value={data.entityAddress.postcode}
                          onChange={(e) => updateAddress('entityAddress', 'postcode', e.target.value)}
                          className={styles.input}
                          aria-label="Postcode"
                        />
                        <input
                          type="text"
                          placeholder="Country"
                          value={data.entityAddress.country}
                          onChange={(e) => updateAddress('entityAddress', 'country', e.target.value)}
                          className={styles.input}
                          aria-label="Country"
                        />
                      </div>
                    </div>
                  </FormField>

                  <div className={styles.grid2}>
                    <FormField label="Registration identifier type" labelFor="entityRegType">
                      <select
                        id="entityRegType"
                        value={data.entityRegType}
                        onChange={(e) => updateData({ entityRegType: e.target.value })}
                        className={styles.select}
                      >
                        <option value="">Select type…</option>
                        <option value="ABN">ABN</option>
                        <option value="ACN">ACN</option>
                        <option value="ARBN">ARBN</option>
                        <option value="Other">Other</option>
                      </select>
                    </FormField>
                    <FormField label="Registration identifier" labelFor="entityRegNumber">
                      <input
                        id="entityRegNumber"
                        type="text"
                        value={data.entityRegNumber}
                        onChange={(e) => updateData({ entityRegNumber: e.target.value })}
                        placeholder="Enter if known"
                        className={styles.input}
                      />
                    </FormField>
                  </div>
                </>
              )}
            </div>

            {/* Completion summary */}
            {isComplete() && (
              <div className={styles.successBanner}>
                <CheckCircle2 aria-hidden="true" size={18} />
                <div>
                  <p className={styles.successTitle}>Conducting person record complete</p>
                  <ul className={styles.completionList}>
                    <li>Represented party selected</li>
                    <li>Person name and details completed</li>
                    <li>Address completed</li>
                    <li>Relationship and authority completed</li>
                    {data.isEmployee === 'yes' && <li>Employee details completed</li>}
                    {data.actingViaEntity === 'yes' && <li>Other entity details completed</li>}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Clear data warning modal */}
      {showClearWarning && (
        <div className={styles.overlay}>
          <div
            role="dialog"
            aria-labelledby="clear-warning-title"
            aria-modal="true"
            className={styles.modal}
          >
            <h3 id="clear-warning-title" className={styles.modalTitle}>
              Clear conducting person details?
            </h3>
            <p className={styles.modalBody}>
              Changing this to No will remove the conducting person details entered on this screen. Continue?
            </p>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setShowClearWarning(false)}>
                Cancel
              </Button>
              <Button onClick={confirmClear}>Continue</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={showExitModal}
        onCancel={() => setShowExitModal(false)}
        onConfirm={async () => { await deleteTransaction(); navigate('/start') }}
      />
    </WizardFrame>
  )
}

export default ConductingPersonPage
