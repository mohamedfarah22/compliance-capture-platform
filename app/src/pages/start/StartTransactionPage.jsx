import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ChoiceCard from '../../components/ui/ChoiceCard.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, writeWizardData } from '../../components/wizardStorage.js'
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
  const [transactionRef, setTransactionRef] = useState('')
  const [dateTime, setDateTime] = useState(currentLocalDateTime)
  const [staffMember, setStaffMember] = useState('John Smith')
  const [errors, setErrors] = useState({})

  const validateForm = () => {
    const newErrors = {}

    if (!scenario) {
      newErrors.scenario = 'Select a transaction scenario.'
    }
    if (!transactionRef.trim()) {
      newErrors.transactionRef = 'Enter a transaction reference.'
    }
    if (!dateTime) {
      newErrors.dateTime = 'Enter the transaction date and time.'
    }
    if (!staffMember.trim()) {
      newErrors.staffMember = 'Enter or confirm the staff member.'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleStartTransaction = (event) => {
    event.preventDefault()

    if (!validateForm()) {
      return
    }

    writeWizardData(wizardStorageKeys.transaction, {
      scenario,
      transactionRef: transactionRef.trim(),
      dateTime,
      staffMember: staffMember.trim(),
      status: 'Draft',
      createdAt: new Date().toISOString(),
    })

    navigate('/customers')
  }

  const handleCancel = () => {
    if (!window.confirm('Cancel transaction creation? Any entered data will be lost.')) {
      return
    }

    setScenario('')
    setTransactionRef('')
    setDateTime(currentLocalDateTime())
    setStaffMember('John Smith')
    setErrors({})
  }

  return (
    <WizardFrame
      title="Start TTR Transaction"
      subtitle="Create a new reportable bullion transaction record."
      helperText="This flow is for reportable TTR transactions only."
      actions={
        <>
          <Button onClick={handleCancel} variant="secondary">
            Cancel
          </Button>
          <Button form="start-transaction-form" type="submit">
            Start transaction
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
              checked={scenario === 'sell'}
              description="Customer pays business"
              label="Sell bullion to customer"
              name="scenario"
              onChange={(event) => setScenario(event.target.value)}
              value="sell"
            />
            <ChoiceCard
              checked={scenario === 'buy'}
              description="Business pays customer"
              label="Buy bullion from customer"
              name="scenario"
              onChange={(event) => setScenario(event.target.value)}
              value="buy"
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
            onChange={(event) => setTransactionRef(event.target.value)}
            placeholder="Enter invoice or transaction reference"
            type="text"
            value={transactionRef}
          />
        </FormField>

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

        <FormField error={errors.staffMember} label="Staff member" labelFor="staffMember">
          <TextInput
            icon={<User aria-hidden="true" size={18} strokeWidth={2} />}
            id="staffMember"
            onChange={(event) => setStaffMember(event.target.value)}
            placeholder="Staff member name"
            type="text"
            value={staffMember}
          />
        </FormField>
      </form>

    </WizardFrame>
  )
}

export default StartTransactionPage
