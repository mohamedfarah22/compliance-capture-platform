import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import Button from '../../../components/ui/Button.jsx'
import DatePicker from '../../../components/ui/DatePicker.jsx'
import FormField from '../../../components/ui/FormField.jsx'
import TextInput from '../../../components/ui/TextInput.jsx'
import WizardFrame from '../../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, readWizardData, writeWizardData } from '../../../components/wizardStorage.js'
import styles from './CreateCustomerPage.module.css'

const formatDobDetail = (isoDate) => {
  if (!isoDate) return ''
  try {
    return format(new Date(isoDate + 'T00:00:00'), 'd MMM yyyy')
  } catch {
    return isoDate
  }
}

const CreateCustomerPage = () => {
  const navigate = useNavigate()

  const [partyType, setPartyType] = useState('individual')

  const [firstName, setFirstName] = useState('')
  const [middleName, setMiddleName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  const [entityName, setEntityName] = useState('')
  const [abnAcn, setAbnAcn] = useState('')
  const [suburb, setSuburb] = useState('')
  const [companyPhone, setCompanyPhone] = useState('')
  const [companyEmail, setCompanyEmail] = useState('')

  const [errors, setErrors] = useState({})

  const switchPartyType = (type) => {
    setPartyType(type)
    setErrors({})
  }

  const validateIndividual = () => {
    const newErrors = {}
    if (!firstName.trim()) newErrors.firstName = 'Enter a first name.'
    if (!lastName.trim()) newErrors.lastName = 'Enter a last name.'
    if (!dateOfBirth) newErrors.dateOfBirth = 'Enter a date of birth.'
    return newErrors
  }

  const validateCompany = () => {
    const newErrors = {}
    if (!entityName.trim()) newErrors.entityName = 'Enter a registered entity name.'
    if (!abnAcn.trim()) newErrors.abnAcn = 'Enter an ABN or ACN.'
    return newErrors
  }

  const handleSave = (e) => {
    e.preventDefault()

    const newErrors = partyType === 'individual' ? validateIndividual() : validateCompany()
    setErrors(newErrors)
    if (Object.keys(newErrors).length > 0) return

    let party
    if (partyType === 'individual') {
      const dob = formatDobDetail(dateOfBirth)
      party = {
        id: `new-${Date.now()}`,
        type: 'individual',
        firstName: firstName.trim(),
        middleName: middleName.trim(),
        lastName: lastName.trim(),
        dateOfBirth,
        phone: phone.trim(),
        email: email.trim(),
        displayName: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
        detail: dob ? `DOB: ${dob}` : '',
      }
    } else {
      const en = entityName.trim()
      const abn = abnAcn.trim()
      const sub = suburb.trim()
      party = {
        id: `new-${Date.now()}`,
        type: 'company',
        entityName: en,
        abnAcn: abn,
        suburb: sub,
        phone: companyPhone.trim(),
        email: companyEmail.trim(),
        displayName: en,
        detail: `ABN: ${abn}${sub ? ` · ${sub}` : ''}`,
      }
    }

    const existing = readWizardData(wizardStorageKeys.customers, [])
    writeWizardData(wizardStorageKeys.customers, [...existing, party])
    navigate('/customers')
  }

  const handleCancel = () => {
    if (!window.confirm('Discard this new party? Any entered data will be lost.')) return
    navigate('/customers')
  }

  return (
    <WizardFrame
      backLabel="Back"
      helperText="Step 1 of 3"
      subtitle="Enter the details for a new customer or party involved in this transaction."
      title="Create New Customer / Party"
      onBack={() => navigate('/customers')}
      actions={
        <>
          <Button onClick={handleCancel} variant="secondary">
            Cancel
          </Button>
          <Button form="create-customer-form" type="submit">
            Save customer
          </Button>
        </>
      }
    >
      <form className={styles.card} id="create-customer-form" onSubmit={handleSave}>
        <div aria-label="Party type" className={styles.modeToggle} role="group">
          <button
            aria-pressed={partyType === 'individual'}
            className={
              partyType === 'individual'
                ? `${styles.modeTab} ${styles.modeTabActive}`
                : styles.modeTab
            }
            type="button"
            onClick={() => switchPartyType('individual')}
          >
            Individual
          </button>
          <button
            aria-pressed={partyType === 'company'}
            className={
              partyType === 'company'
                ? `${styles.modeTab} ${styles.modeTabActive}`
                : styles.modeTab
            }
            type="button"
            onClick={() => switchPartyType('company')}
          >
            Company / Business
          </button>
        </div>

        {partyType === 'individual' ? (
          <>
            <div className={styles.fieldRow}>
              <FormField error={errors.firstName} label="First name" labelFor="firstName">
                <TextInput
                  id="firstName"
                  placeholder="First name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </FormField>
              <FormField label="Middle name" labelFor="middleName">
                <TextInput
                  id="middleName"
                  placeholder="Middle name (optional)"
                  type="text"
                  value={middleName}
                  onChange={(e) => setMiddleName(e.target.value)}
                />
              </FormField>
            </div>
            <FormField error={errors.lastName} label="Last name" labelFor="lastName">
              <TextInput
                id="lastName"
                placeholder="Last name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </FormField>
            <FormField error={errors.dateOfBirth} label="Date of birth" labelFor="dateOfBirth">
              <DatePicker id="dateOfBirth" value={dateOfBirth} onChange={setDateOfBirth} />
            </FormField>
            <FormField label="Phone number" labelFor="phone">
              <TextInput
                id="phone"
                placeholder="Phone number (optional)"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </FormField>
            <FormField label="Email address" labelFor="email">
              <TextInput
                id="email"
                placeholder="Email address (optional)"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField
              error={errors.entityName}
              label="Registered entity name"
              labelFor="entityName"
            >
              <TextInput
                id="entityName"
                placeholder="Registered entity name"
                type="text"
                value={entityName}
                onChange={(e) => setEntityName(e.target.value)}
              />
            </FormField>
            <FormField error={errors.abnAcn} label="ABN / ACN" labelFor="abnAcn">
              <TextInput
                id="abnAcn"
                placeholder="ABN or ACN"
                type="text"
                value={abnAcn}
                onChange={(e) => setAbnAcn(e.target.value)}
              />
            </FormField>
            <FormField label="Registered suburb / postcode" labelFor="companySuburb">
              <TextInput
                id="companySuburb"
                placeholder="Suburb or postcode (optional)"
                type="text"
                value={suburb}
                onChange={(e) => setSuburb(e.target.value)}
              />
            </FormField>
            <FormField label="Phone number" labelFor="companyPhone">
              <TextInput
                id="companyPhone"
                placeholder="Phone number (optional)"
                type="tel"
                value={companyPhone}
                onChange={(e) => setCompanyPhone(e.target.value)}
              />
            </FormField>
            <FormField label="Email address" labelFor="companyEmail">
              <TextInput
                id="companyEmail"
                placeholder="Email address (optional)"
                type="email"
                value={companyEmail}
                onChange={(e) => setCompanyEmail(e.target.value)}
              />
            </FormField>
          </>
        )}
      </form>
    </WizardFrame>
  )
}

export default CreateCustomerPage
