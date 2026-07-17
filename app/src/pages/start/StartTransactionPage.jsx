import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button.jsx'
import ChoiceCard from '../../components/ui/ChoiceCard.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, writeWizardData } from '../../components/wizardStorage.js'
import { MAX_TRN_LENGTH } from '../../lib/austrac.js'
import { deleteTransaction, findDraftByRef, loadCustomers } from '../../lib/wizardApi.js'
import styles from './StartTransactionPage.module.css'

const currentLocalDateTime = () => {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  const localDate = new Date(now.getTime() - offset * 60 * 1000)
  return localDate.toISOString().slice(0, 16)
}

const StartTransactionPage = () => {
  const navigate = useNavigate()
  const [scenario, setScenario] = useState('')
  const [serviceType, setServiceType] = useState('bullion')
  const [transactionRef, setTransactionRef] = useState('')
  const [dateTime, setDateTime] = useState(currentLocalDateTime)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [draftNotice, setDraftNotice] = useState('')

  const validateForm = () => {
    const newErrors = {}
    if (!scenario) newErrors.scenario = 'Select a transaction scenario.'
    if (!transactionRef.trim()) newErrors.transactionRef = 'Enter a transaction reference.'
    else if (transactionRef.trim().length > MAX_TRN_LENGTH) newErrors.transactionRef = `Reference must be ${MAX_TRN_LENGTH} characters or fewer.`
    if (!dateTime) newErrors.dateTime = 'Enter the transaction date and time.'
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleRefBlur = async () => {
    const ref = transactionRef.trim()
    if (!ref) return
    try {
      const draft = await findDraftByRef(ref)
      if (draft) {
        setScenario(draft.scenario)
        setServiceType(draft.serviceType || 'bullion')
        setDateTime(draft.dateTime)
        setDraftNotice('Existing draft found — fields pre-filled.')
      } else {
        setDraftNotice('')
      }
    } catch { /* ignore */ }
  }

  const handleScenarioChoice = (nextServiceType, nextScenario) => {
    setServiceType(nextServiceType)
    setScenario(nextScenario)
  }

  const handleStartTransaction = async (event) => {
    event.preventDefault()
    if (!validateForm()) return

    setSaving(true)
    try {
      const draft = await findDraftByRef(transactionRef.trim())
      if (draft) {
        const customers = await loadCustomers()
        // Every party loadCustomers() returns already has a row in ttr.parties for this
        // transaction — flag as migrated so re-entering Transaction Details doesn't re-insert them.
        writeWizardData(wizardStorageKeys.customers, customers.map((c) => ({ ...c, _migrated: true })))
        writeWizardData(wizardStorageKeys.transaction, {
          scenario: draft.scenario,
          serviceType: draft.serviceType || 'bullion',
          transactionRef: draft.transactionRef,
          dateTime: draft.dateTime,
          status: draft.status,
          createdAt: new Date().toISOString(),
        })
      } else {
        await deleteTransaction()
        writeWizardData(wizardStorageKeys.transaction, {
          scenario,
          serviceType,
          transactionRef: transactionRef.trim(),
          dateTime,
          status: 'Draft',
          createdAt: new Date().toISOString(),
        })
      }
      navigate('/customers')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    if (!window.confirm('Cancel transaction creation? Any entered data will be lost.')) return
    await deleteTransaction()
    setScenario('')
    setServiceType('bullion')
    setTransactionRef('')
    setDateTime(currentLocalDateTime())
    setErrors({})
  }

  return (
    <WizardFrame
      title="Start TTR Transaction"
      subtitle="Create a new reportable bullion or precious metal transaction record."
      helperText="This flow is for reportable TTR transactions only."
      actions={
        <>
          <Button onClick={handleCancel} variant="secondary">
            Cancel
          </Button>
          <Button disabled={saving} form="start-transaction-form" type="submit">
            {saving ? 'Starting…' : 'Start transaction'}
          </Button>
        </>
      }
    >
      <form className={styles.card} id="start-transaction-form" onSubmit={handleStartTransaction}>
        <h2>Transaction setup</h2>

        <fieldset className={styles.fieldset}>
          <legend>Transaction scenario</legend>
          <div className={styles.choiceStack}>
            <ChoiceCard
              checked={serviceType === 'bullion' && scenario === 'sell'}
              description="Customer pays business"
              label="Sell bullion to customer"
              name="scenario"
              onChange={() => handleScenarioChoice('bullion', 'sell')}
              value="bullion_sell"
            />
            <ChoiceCard
              checked={serviceType === 'bullion' && scenario === 'buy'}
              description="Business pays customer"
              label="Buy bullion from customer"
              name="scenario"
              onChange={() => handleScenarioChoice('bullion', 'buy')}
              value="bullion_buy"
            />
            <ChoiceCard
              checked={serviceType === 'precious_metal' && scenario === 'sell'}
              description="Customer pays business"
              label="Sell precious metal to customer"
              name="scenario"
              onChange={() => handleScenarioChoice('precious_metal', 'sell')}
              value="precious_metal_sell"
            />
            <ChoiceCard
              checked={serviceType === 'precious_metal' && scenario === 'buy'}
              description="Business pays customer"
              label="Buy precious metal from customer"
              name="scenario"
              onChange={() => handleScenarioChoice('precious_metal', 'buy')}
              value="precious_metal_buy"
            />
          </div>
          {errors.scenario ? <p className={styles.error}>{errors.scenario}</p> : null}
        </fieldset>

        <FormField
          error={errors.transactionRef}
          helperText="Use the store's invoice or internal transaction reference number."
          label="Transaction reference"
          labelFor="transactionRef"
        >
          <TextInput
            id="transactionRef"
            onBlur={handleRefBlur}
            onChange={(event) => { setTransactionRef(event.target.value); setDraftNotice('') }}
            placeholder="Enter invoice or transaction reference"
            type="text"
            value={transactionRef}
            maxLength={MAX_TRN_LENGTH}
          />
        </FormField>
        {draftNotice ? <p className={styles.draftNotice}>{draftNotice}</p> : null}

        <FormField
          error={errors.dateTime}
          label="Transaction date and time"
          labelFor="dateTime"
        >
          <TextInput
            id="dateTime"
            onChange={(event) => setDateTime(event.target.value)}
            type="datetime-local"
            value={dateTime}
          />
        </FormField>
      </form>
    </WizardFrame>
  )
}

export default StartTransactionPage
