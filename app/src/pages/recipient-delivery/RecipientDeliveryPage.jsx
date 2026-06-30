import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { loadCustomers, loadRecipientDelivery, saveRecipientDelivery } from '../../lib/wizardApi.js'
import styles from './RecipientDeliveryPage.module.css'

const DELIVERY_METHODS = ['Collected', 'Shipped', 'Courier', 'Other']

const emptyAddress = () => ({
  street: '',
  suburb: '',
  state: '',
  postcode: '',
  country: 'Australia',
})

const initialData = () => ({
  recipientIsParty: null,
  selectedPartyId: '',
  recipientFullName: '',
  dobKnown: null,
  recipientDob: '',
  recipientAddress: emptyAddress(),
  purposeOfTransfer: '',
  deliveryMethod: '',
  deliveryMethodOther: '',
  deliveryAddressDifferent: null,
  deliveryAddress: emptyAddress(),
  handoverNotes: '',
})

const getPartyLabel = (party) => {
  const name =
    party.type === 'individual'
      ? party.displayName || [party.firstName, party.lastName].filter(Boolean).join(' ')
      : party.entityName || party.displayName
  const typeLabel = party.type === 'individual' ? 'Individual' : 'Company'
  return party.dateOfBirth
    ? `${name} (${typeLabel}) – ${party.dateOfBirth}`
    : `${name} (${typeLabel})`
}

const RecipientDeliveryPage = () => {
  const navigate = useNavigate()
  const [parties, setParties] = useState([])
  const [data, setData] = useState(initialData)
  const [errors, setErrors] = useState({})

  useEffect(() => {
    const init = async () => {
      const [customers, saved] = await Promise.all([loadCustomers(), loadRecipientDelivery()])
      setParties(customers)
      if (saved) setData(saved)
    }
    init()
  }, [])

  const updateData = (updates) => setData((prev) => ({ ...prev, ...updates }))

  const updateAddress = (type, field, value) =>
    setData((prev) => ({ ...prev, [type]: { ...prev[type], [field]: value } }))

  const validate = () => {
    const e = {}

    if (data.recipientIsParty === null) {
      e.recipientIsParty = 'Indicate if the recipient is one of the recorded parties.'
    }

    if (data.recipientIsParty === 'yes' && !data.selectedPartyId) {
      e.selectedPartyId = 'Select the recipient.'
    }

    if (data.recipientIsParty === 'no') {
      if (!data.recipientFullName.trim()) {
        e.recipientFullName = "Enter the recipient's full name."
      }
      const ra = data.recipientAddress
      if (!ra.street.trim() || !ra.suburb.trim() || !ra.state.trim() || !ra.postcode.trim()) {
        e.recipientAddress = "Enter the recipient's physical address."
      }
    }

    if (!data.purposeOfTransfer.trim()) {
      e.purposeOfTransfer = 'Enter the purpose of the transfer.'
    }

    if (!data.deliveryMethod) {
      e.deliveryMethod = 'Select the delivery method.'
    }

    if (data.deliveryMethod === 'Other' && !data.deliveryMethodOther.trim()) {
      e.deliveryMethodOther = 'Describe the delivery method.'
    }

    if (data.deliveryAddressDifferent === 'yes') {
      const da = data.deliveryAddress
      if (!da.street.trim() || !da.suburb.trim() || !da.state.trim() || !da.postcode.trim()) {
        e.deliveryAddress = 'Enter the delivery address.'
      }
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleContinue = async () => {
    if (!validate()) return
    await saveRecipientDelivery(data)
    navigate('/bullion-details')
  }

  const isComplete = () => {
    if (data.recipientIsParty === null) return false
    if (data.recipientIsParty === 'yes' && !data.selectedPartyId) return false
    if (data.recipientIsParty === 'no' && (!data.recipientFullName || !data.recipientAddress.street)) return false
    if (!data.purposeOfTransfer || !data.deliveryMethod) return false
    return true
  }

  const showBody = data.recipientIsParty !== null

  return (
    <WizardFrame
      title="Recipient / Delivery"
      subtitle="Record the recipient and any delivery or handover details for this transaction."
      onBack={() => navigate('/id-verification')}
      actions={<Button onClick={handleContinue}>Continue</Button>}
    >
      <div className={styles.card}>
        {/* Section 1: Recipient decision */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Recipient</h2>
          <FormField
            label="Is the recipient the same as one of the recorded parties?"
            error={errors.recipientIsParty}
          >
            <div className={styles.radioGroup}>
              <label className={styles.radioLabel}>
                <input
                  type="radio"
                  name="recipientIsParty"
                  checked={data.recipientIsParty === 'yes'}
                  onChange={() => updateData({ recipientIsParty: 'yes' })}
                />
                Yes
              </label>
              <label className={styles.radioLabel}>
                <input
                  type="radio"
                  name="recipientIsParty"
                  checked={data.recipientIsParty === 'no'}
                  onChange={() => updateData({ recipientIsParty: 'no' })}
                />
                No
              </label>
            </div>
          </FormField>
        </div>

        {/* Section 2A: Select existing party */}
        {data.recipientIsParty === 'yes' && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Select recipient</h2>
            <FormField label="Recipient" error={errors.selectedPartyId}>
              <select
                className={styles.select}
                value={data.selectedPartyId}
                onChange={(e) => updateData({ selectedPartyId: e.target.value })}
              >
                <option value="">Select a party…</option>
                {parties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {getPartyLabel(party)}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}

        {/* Section 2B: New recipient */}
        {data.recipientIsParty === 'no' && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Recipient details</h2>

            <FormField label="Recipient full name" error={errors.recipientFullName}>
              <input
                className={styles.input}
                type="text"
                value={data.recipientFullName}
                onChange={(e) => updateData({ recipientFullName: e.target.value })}
              />
            </FormField>

            <FormField label="Is the recipient's date of birth known?">
              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    checked={data.dobKnown === 'yes'}
                    onChange={() => updateData({ dobKnown: 'yes' })}
                  />
                  Yes
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    checked={data.dobKnown === 'no'}
                    onChange={() => updateData({ dobKnown: 'no', recipientDob: '' })}
                  />
                  No
                </label>
              </div>
            </FormField>

            {data.dobKnown === 'yes' && (
              <FormField label="Recipient date of birth">
                <DatePicker
                  value={data.recipientDob}
                  onChange={(date) => updateData({ recipientDob: date })}
                />
              </FormField>
            )}

            <FormField
              label="Recipient residential / business physical address"
              error={errors.recipientAddress}
            >
              <div className={styles.addressGrid}>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="Street address"
                  value={data.recipientAddress.street}
                  onChange={(e) => updateAddress('recipientAddress', 'street', e.target.value)}
                />
                <div className={styles.grid2}>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="Suburb"
                    value={data.recipientAddress.suburb}
                    onChange={(e) => updateAddress('recipientAddress', 'suburb', e.target.value)}
                  />
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="State"
                    value={data.recipientAddress.state}
                    onChange={(e) => updateAddress('recipientAddress', 'state', e.target.value)}
                  />
                </div>
                <div className={styles.grid2}>
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="Postcode"
                    value={data.recipientAddress.postcode}
                    onChange={(e) => updateAddress('recipientAddress', 'postcode', e.target.value)}
                  />
                  <input
                    className={styles.input}
                    type="text"
                    placeholder="Country"
                    value={data.recipientAddress.country}
                    onChange={(e) => updateAddress('recipientAddress', 'country', e.target.value)}
                  />
                </div>
              </div>
            </FormField>
          </div>
        )}

        {/* Section 3: Purpose */}
        {showBody && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Purpose of transfer</h2>
            <FormField label="Purpose of the transfer" error={errors.purposeOfTransfer}>
              <input
                className={styles.input}
                type="text"
                placeholder="e.g. customer collecting bullion purchase, delivery to authorised recipient"
                value={data.purposeOfTransfer}
                onChange={(e) => updateData({ purposeOfTransfer: e.target.value })}
              />
            </FormField>
          </div>
        )}

        {/* Section 4: Delivery / Handover */}
        {showBody && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Delivery / handover</h2>

            <FormField label="Delivery method" error={errors.deliveryMethod}>
              <select
                className={styles.select}
                value={data.deliveryMethod}
                onChange={(e) => {
                  const method = e.target.value
                  updateData({
                    deliveryMethod: method,
                    ...(method === 'Collected' && {
                      deliveryAddressDifferent: null,
                      deliveryAddress: emptyAddress(),
                    }),
                  })
                }}
              >
                <option value="">Select method…</option>
                {DELIVERY_METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </FormField>

            {data.deliveryMethod === 'Other' && (
              <FormField label="Describe delivery method" error={errors.deliveryMethodOther}>
                <input
                  className={styles.input}
                  type="text"
                  value={data.deliveryMethodOther}
                  onChange={(e) => updateData({ deliveryMethodOther: e.target.value })}
                />
              </FormField>
            )}

            {data.deliveryMethod !== 'Collected' && (
              <>
                <FormField label="Is the delivery address different from the recipient's main address?">
                  <div className={styles.radioGroup}>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        checked={data.deliveryAddressDifferent === 'no'}
                        onChange={() =>
                          updateData({ deliveryAddressDifferent: 'no', deliveryAddress: emptyAddress() })
                        }
                      />
                      No
                    </label>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        checked={data.deliveryAddressDifferent === 'yes'}
                        onChange={() => updateData({ deliveryAddressDifferent: 'yes' })}
                      />
                      Yes
                    </label>
                  </div>
                </FormField>

                {data.deliveryAddressDifferent === 'yes' && (
                  <FormField label="Delivery address" error={errors.deliveryAddress}>
                    <div className={styles.addressGrid}>
                      <input
                        className={styles.input}
                        type="text"
                        placeholder="Street address"
                        value={data.deliveryAddress.street}
                        onChange={(e) => updateAddress('deliveryAddress', 'street', e.target.value)}
                      />
                      <div className={styles.grid2}>
                        <input
                          className={styles.input}
                          type="text"
                          placeholder="Suburb"
                          value={data.deliveryAddress.suburb}
                          onChange={(e) => updateAddress('deliveryAddress', 'suburb', e.target.value)}
                        />
                        <input
                          className={styles.input}
                          type="text"
                          placeholder="State"
                          value={data.deliveryAddress.state}
                          onChange={(e) => updateAddress('deliveryAddress', 'state', e.target.value)}
                        />
                      </div>
                      <div className={styles.grid2}>
                        <input
                          className={styles.input}
                          type="text"
                          placeholder="Postcode"
                          value={data.deliveryAddress.postcode}
                          onChange={(e) => updateAddress('deliveryAddress', 'postcode', e.target.value)}
                        />
                        <input
                          className={styles.input}
                          type="text"
                          placeholder="Country"
                          value={data.deliveryAddress.country}
                          onChange={(e) => updateAddress('deliveryAddress', 'country', e.target.value)}
                        />
                      </div>
                    </div>
                  </FormField>
                )}
              </>
            )}

            <FormField label="Collection or handover notes">
              <textarea
                className={styles.textarea}
                rows={3}
                placeholder="e.g. collected in person at counter, courier handover reference, authorised pickup confirmed"
                value={data.handoverNotes}
                onChange={(e) => updateData({ handoverNotes: e.target.value })}
              />
            </FormField>
          </div>
        )}

        {/* Completion banner */}
        {isComplete() && (
          <div className={styles.section}>
            <div className={styles.successBanner}>
              <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <p className={styles.successTitle}>Recipient and delivery details complete</p>
                <ul className={styles.completionList}>
                  <li>Recipient identified</li>
                  {data.recipientIsParty === 'no' && data.dobKnown === 'yes' && (
                    <li>Date of birth recorded</li>
                  )}
                  {data.recipientIsParty === 'no' && <li>Physical address recorded</li>}
                  <li>Purpose recorded</li>
                  <li>Delivery method recorded</li>
                  {data.deliveryAddressDifferent === 'yes' && <li>Delivery address recorded</li>}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </WizardFrame>
  )
}

export default RecipientDeliveryPage
