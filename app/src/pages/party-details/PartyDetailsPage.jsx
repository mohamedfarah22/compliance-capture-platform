import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Building2, CheckCircle2, Circle, User } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, readWizardData, writeWizardData } from '../../components/wizardStorage.js'
import styles from './PartyDetailsPage.module.css'

const STATES = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']

const PartyDetailsPage = () => {
  const navigate = useNavigate()

  const [parties, setParties] = useState(() =>
    readWizardData(wizardStorageKeys.customers, []).map(party => ({
      ...party,
      partyType: party.type === 'individual' ? 'Individual' : 'Company',
      isComplete: party.isComplete || false,
    }))
  )

  const [currentPartyIndex, setCurrentPartyIndex] = useState(0)
  const [errors, setErrors] = useState({})
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [showExitModal, setShowExitModal] = useState(false)
  const [continueError, setContinueError] = useState('')

  // Individual fields
  const [fullName, setFullName] = useState('')
  const [aliases, setAliases] = useState([])
  const [aliasInput, setAliasInput] = useState('')
  const [businessTradingName, setBusinessTradingName] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [resStreet, setResStreet] = useState('')
  const [resSuburb, setResSuburb] = useState('')
  const [resState, setResState] = useState('')
  const [resPostcode, setResPostcode] = useState('')
  const [resCountry, setResCountry] = useState('Australia')
  const [hasPostalAddress, setHasPostalAddress] = useState(false)
  const [postStreet, setPostStreet] = useState('')
  const [postSuburb, setPostSuburb] = useState('')
  const [postState, setPostState] = useState('')
  const [postPostcode, setPostPostcode] = useState('')
  const [postCountry, setPostCountry] = useState('Australia')
  const [phone, setPhone] = useState('')
  const [occupation, setOccupation] = useState('')
  const [abn, setAbn] = useState('')

  // Company fields
  const [entityName, setEntityName] = useState('')
  const [companyTradingName, setCompanyTradingName] = useState('')
  const [legalForm, setLegalForm] = useState('')
  const [bizStreet, setBizStreet] = useState('')
  const [bizSuburb, setBizSuburb] = useState('')
  const [bizState, setBizState] = useState('')
  const [bizPostcode, setBizPostcode] = useState('')
  const [bizCountry, setBizCountry] = useState('Australia')
  const [hasCompanyPostalAddress, setHasCompanyPostalAddress] = useState(false)
  const [compPostStreet, setCompPostStreet] = useState('')
  const [compPostSuburb, setCompPostSuburb] = useState('')
  const [compPostState, setCompPostState] = useState('')
  const [compPostPostcode, setCompPostPostcode] = useState('')
  const [compPostCountry, setCompPostCountry] = useState('Australia')
  const [companyPhone, setCompanyPhone] = useState('')
  const [registrationIdentifierType, setRegistrationIdentifierType] = useState('ABN')
  const [registrationIdentifier, setRegistrationIdentifier] = useState('')
  const [principalActivity, setPrincipalActivity] = useState('')

  const currentParty = parties[currentPartyIndex]

  useEffect(() => {
    if (currentParty) loadPartyData(currentParty)
  }, [currentPartyIndex])

  const loadPartyData = (party) => {
    if (party.partyType === 'Individual') {
      setFullName(party.fullName || party.displayName || `${party.firstName || ''} ${party.lastName || ''}`.trim())
      setAliases(party.aliases || [])
      setBusinessTradingName(party.businessTradingName || '')
      setDateOfBirth(party.dateOfBirth ? String(party.dateOfBirth).split('T')[0] : '')
      setResStreet(party.residentialAddress?.street || '')
      setResSuburb(party.residentialAddress?.suburb || '')
      setResState(party.residentialAddress?.state || '')
      setResPostcode(party.residentialAddress?.postcode || '')
      setResCountry(party.residentialAddress?.country || 'Australia')
      setHasPostalAddress(party.hasPostalAddress || false)
      setPostStreet(party.postalAddress?.street || '')
      setPostSuburb(party.postalAddress?.suburb || '')
      setPostState(party.postalAddress?.state || '')
      setPostPostcode(party.postalAddress?.postcode || '')
      setPostCountry(party.postalAddress?.country || 'Australia')
      setPhone(party.phone || '')
      setOccupation(party.occupation || '')
      setAbn(party.abn || '')
    } else {
      setEntityName(party.entityName || '')
      setCompanyTradingName(party.companyTradingName || '')
      setLegalForm(party.legalForm || '')
      setBizStreet(party.businessAddress?.street || '')
      setBizSuburb(party.businessAddress?.suburb || '')
      setBizState(party.businessAddress?.state || '')
      setBizPostcode(party.businessAddress?.postcode || '')
      setBizCountry(party.businessAddress?.country || 'Australia')
      setHasCompanyPostalAddress(party.hasCompanyPostalAddress || false)
      setCompPostStreet(party.companyPostalAddress?.street || '')
      setCompPostSuburb(party.companyPostalAddress?.suburb || '')
      setCompPostState(party.companyPostalAddress?.state || '')
      setCompPostPostcode(party.companyPostalAddress?.postcode || '')
      setCompPostCountry(party.companyPostalAddress?.country || 'Australia')
      setCompanyPhone(party.companyPhone || party.phone || '')
      setRegistrationIdentifierType(party.registrationIdentifierType || 'ABN')
      setRegistrationIdentifier(party.registrationIdentifier || party.abnAcn || '')
      setPrincipalActivity(party.principalActivity || '')
    }
    setErrors({})
    setHasUnsavedChanges(false)
    setContinueError('')
  }

  const validateIndividual = () => {
    const newErrors = {}
    if (!fullName.trim()) newErrors.fullName = 'Enter the full legal name.'
    if (!dateOfBirth) newErrors.dateOfBirth = 'Enter the date of birth.'
    if (!resStreet.trim()) newErrors.resStreet = 'Enter the street address.'
    if (!resSuburb.trim()) newErrors.resSuburb = 'Enter the suburb.'
    if (!resState.trim()) newErrors.resState = 'Enter the state.'
    if (!resPostcode.trim()) newErrors.resPostcode = 'Enter the postcode.'
    if (!resCountry.trim()) newErrors.resCountry = 'Enter the country.'
    if (!phone.trim()) newErrors.phone = 'Enter the phone number.'
    if (!occupation.trim()) newErrors.occupation = 'Enter the occupation or principal activity.'
    if (hasPostalAddress) {
      if (!postStreet.trim()) newErrors.postStreet = 'Enter the postal street address.'
      if (!postSuburb.trim()) newErrors.postSuburb = 'Enter the postal suburb.'
      if (!postState.trim()) newErrors.postState = 'Enter the postal state.'
      if (!postPostcode.trim()) newErrors.postPostcode = 'Enter the postal postcode.'
      if (!postCountry.trim()) newErrors.postCountry = 'Enter the postal country.'
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const validateCompany = () => {
    const newErrors = {}
    if (!entityName.trim()) newErrors.entityName = 'Enter the legal entity name.'
    if (!legalForm.trim()) newErrors.legalForm = 'Select the legal form or structure.'
    if (!bizStreet.trim()) newErrors.bizStreet = 'Enter the street address.'
    if (!bizSuburb.trim()) newErrors.bizSuburb = 'Enter the suburb.'
    if (!bizState.trim()) newErrors.bizState = 'Enter the state.'
    if (!bizPostcode.trim()) newErrors.bizPostcode = 'Enter the postcode.'
    if (!bizCountry.trim()) newErrors.bizCountry = 'Enter the country.'
    if (!companyPhone.trim()) newErrors.companyPhone = 'Enter the phone number.'
    if (!registrationIdentifier.trim()) newErrors.registrationIdentifier = 'Enter the registration identifier.'
    if (!principalActivity.trim()) newErrors.principalActivity = 'Enter the principal activity or business activity.'
    if (hasCompanyPostalAddress) {
      if (!compPostStreet.trim()) newErrors.compPostStreet = 'Enter the postal street address.'
      if (!compPostSuburb.trim()) newErrors.compPostSuburb = 'Enter the postal suburb.'
      if (!compPostState.trim()) newErrors.compPostState = 'Enter the postal state.'
      if (!compPostPostcode.trim()) newErrors.compPostPostcode = 'Enter the postal postcode.'
      if (!compPostCountry.trim()) newErrors.compPostCountry = 'Enter the postal country.'
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const buildSavedParty = () => {
    const isValid = currentParty.partyType === 'Individual'
      ? validateIndividual()
      : validateCompany()
    if (!isValid) return null

    const updatedParty = { ...currentParty, isComplete: true }

    if (currentParty.partyType === 'Individual') {
      updatedParty.fullName = fullName
      updatedParty.aliases = aliases
      updatedParty.businessTradingName = businessTradingName
      updatedParty.dateOfBirth = dateOfBirth
      updatedParty.residentialAddress = { street: resStreet, suburb: resSuburb, state: resState, postcode: resPostcode, country: resCountry }
      updatedParty.hasPostalAddress = hasPostalAddress
      if (hasPostalAddress) {
        updatedParty.postalAddress = { street: postStreet, suburb: postSuburb, state: postState, postcode: postPostcode, country: postCountry }
      }
      updatedParty.phone = phone
      updatedParty.occupation = occupation
      updatedParty.abn = abn
    } else {
      updatedParty.entityName = entityName
      updatedParty.companyTradingName = companyTradingName
      updatedParty.legalForm = legalForm
      updatedParty.businessAddress = { street: bizStreet, suburb: bizSuburb, state: bizState, postcode: bizPostcode, country: bizCountry }
      updatedParty.hasCompanyPostalAddress = hasCompanyPostalAddress
      if (hasCompanyPostalAddress) {
        updatedParty.companyPostalAddress = { street: compPostStreet, suburb: compPostSuburb, state: compPostState, postcode: compPostPostcode, country: compPostCountry }
      }
      updatedParty.companyPhone = companyPhone
      updatedParty.registrationIdentifierType = registrationIdentifierType
      updatedParty.registrationIdentifier = registrationIdentifier
      updatedParty.principalActivity = principalActivity
    }

    return updatedParty
  }

  const commitSave = (updatedParty) => {
    const updatedParties = [...parties]
    updatedParties[currentPartyIndex] = updatedParty
    setParties(updatedParties)
    writeWizardData(wizardStorageKeys.customers, updatedParties)
    setHasUnsavedChanges(false)
    return updatedParties
  }

  const handleSave = () => {
    const updatedParty = buildSavedParty()
    if (updatedParty) commitSave(updatedParty)
  }

  const handleSaveAndNext = () => {
    const updatedParty = buildSavedParty()
    if (!updatedParty) return
    const updatedParties = commitSave(updatedParty)
    const nextIndex = updatedParties.findIndex((p, idx) => idx > currentPartyIndex && !p.isComplete)
    if (nextIndex !== -1) setCurrentPartyIndex(nextIndex)
  }

  const handleContinue = () => {
    const updatedParty = buildSavedParty()
    if (!updatedParty) return
    const updatedParties = commitSave(updatedParty)
    if (updatedParties.every(p => p.isComplete)) {
      navigate('/conducting-person')
    } else {
      setContinueError('Complete the required details for all parties before continuing.')
    }
  }

  const handleBack = () => navigate('/transaction-details')
  const handleExit = () => setShowExitModal(true)

  const markChanged = () => setHasUnsavedChanges(true)

  const addAlias = () => {
    if (aliasInput.trim()) {
      setAliases([...aliases, aliasInput.trim()])
      setAliasInput('')
      markChanged()
    }
  }

  const removeAlias = (index) => {
    setAliases(aliases.filter((_, i) => i !== index))
    markChanged()
  }

  const getCompletionStatus = (party, index) => {
    if (index === currentPartyIndex && hasUnsavedChanges) return 'in-progress'
    return party.isComplete ? 'complete' : 'not-started'
  }

  const getPartyDisplayName = (party) => {
    if (party.partyType === 'Individual') {
      return party.fullName || party.displayName || `${party.firstName || ''} ${party.lastName || ''}`.trim() || 'Individual Party'
    }
    return party.entityName || party.displayName || 'Company Party'
  }

  if (!currentParty) return null

  return (
    <WizardFrame
      wide
      title="Party Details"
      subtitle="Complete the required details for each customer or party involved in this transaction."
      helperText="Step 3 of 4"
      onBack={handleBack}
      onExit={handleExit}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={handleSave}>Save</Button>
          {currentPartyIndex < parties.length - 1 && (
            <Button variant="secondary" type="button" onClick={handleSaveAndNext}>Save and next party</Button>
          )}
          <Button type="button" onClick={handleContinue}>Continue</Button>
        </>
      }
    >
      {continueError && <p className={styles.continueError}>{continueError}</p>}

      <div className={styles.layout}>
        {/* Left: party navigator */}
        <div className={styles.partyList}>
          <h2 className={styles.panelHeading}>Parties ({parties.length})</h2>
          <div className={styles.partyCards}>
            {parties.map((party, index) => {
              const status = getCompletionStatus(party, index)
              const isActive = index === currentPartyIndex
              return (
                <button
                  key={party.id}
                  type="button"
                  onClick={() => setCurrentPartyIndex(index)}
                  className={[styles.partyCard, isActive ? styles.partyCardActive : ''].filter(Boolean).join(' ')}
                >
                  <div className={styles.partyCardInner}>
                    {party.partyType === 'Individual'
                      ? <User aria-hidden="true" className={styles.partyIcon} size={20} />
                      : <Building2 aria-hidden="true" className={styles.partyIcon} size={20} />
                    }
                    <div className={styles.partyMeta}>
                      <p className={styles.partyName}>{getPartyDisplayName(party)}</p>
                      <p className={styles.partyTypeBadge}>{party.partyType}</p>
                      <div className={styles.statusRow}>
                        {status === 'complete' && (
                          <>
                            <CheckCircle2 aria-hidden="true" size={16} />
                            <span className={styles.statusComplete}>Complete</span>
                          </>
                        )}
                        {status === 'in-progress' && (
                          <>
                            <AlertCircle aria-hidden="true" size={16} />
                            <span className={styles.statusInProgress}>In progress</span>
                          </>
                        )}
                        {status === 'not-started' && (
                          <>
                            <Circle aria-hidden="true" size={16} />
                            <span className={styles.statusNotStarted}>Not started</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Right: form panel */}
        <div className={styles.formPanel}>
          {/* Party summary banner */}
          <div className={styles.summaryCard}>
            <div className={styles.summaryCardInner}>
              {currentParty.partyType === 'Individual'
                ? <User aria-hidden="true" className={styles.partyIcon} size={20} />
                : <Building2 aria-hidden="true" className={styles.partyIcon} size={20} />
              }
              <div>
                <p className={styles.partyName}>{getPartyDisplayName(currentParty)}</p>
                <p className={styles.partyTypeBadge}>{currentParty.partyType}</p>
              </div>
            </div>
          </div>

          {/* Individual form */}
          {currentParty.partyType === 'Individual' && (
            <div className={styles.formSection}>
              <h2>Individual details</h2>

              <FormField label="Full legal name" labelFor="fullName" error={errors.fullName ?? ""}>
                <input
                  id="fullName"
                  type="text"
                  value={fullName}
                  onChange={(e) => { setFullName(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter full legal name"
                />
              </FormField>

              <FormField
                label="Other names or aliases"
                helperText="Include any other known names used by this person."
              >
                <div className={styles.aliasRow}>
                  <input
                    id="aliasInput"
                    type="text"
                    value={aliasInput}
                    onChange={(e) => setAliasInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias() } }}
                    className={styles.input}
                    placeholder="Enter alias and press Enter"
                  />
                  <Button variant="secondary" type="button" onClick={addAlias}>Add</Button>
                </div>
                {aliases.length > 0 && (
                  <div className={styles.aliasTags}>
                    {aliases.map((alias, i) => (
                      <span key={i} className={styles.aliasTag}>
                        {alias}
                        <button
                          type="button"
                          className={styles.aliasRemove}
                          onClick={() => removeAlias(i)}
                          aria-label={`Remove alias ${alias}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </FormField>

              <FormField
                label="Business or trading name"
                labelFor="businessTradingName"
                helperText="Only if the person operates under a business or trading name."
              >
                <input
                  id="businessTradingName"
                  type="text"
                  value={businessTradingName}
                  onChange={(e) => { setBusinessTradingName(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter business or trading name"
                />
              </FormField>

              <FormField label="Date of birth" error={errors.dateOfBirth ?? ""}>
                <DatePicker
                  value={dateOfBirth}
                  onChange={(val) => { setDateOfBirth(val); markChanged() }}
                  placeholder="Select date of birth"
                />
              </FormField>

              <div className={styles.addressGroup}>
                <h3>Residential address</h3>

                <FormField label="Street address" labelFor="resStreet" error={errors.resStreet ?? ""}>
                  <input
                    id="resStreet"
                    type="text"
                    value={resStreet}
                    onChange={(e) => { setResStreet(e.target.value); markChanged() }}
                    className={styles.input}
                    placeholder="Enter street address"
                  />
                </FormField>

                <div className={styles.grid2}>
                  <FormField label="Suburb" labelFor="resSuburb" error={errors.resSuburb ?? ""}>
                    <input
                      id="resSuburb"
                      type="text"
                      value={resSuburb}
                      onChange={(e) => { setResSuburb(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter suburb"
                    />
                  </FormField>

                  <FormField label="State" labelFor="resState" error={errors.resState ?? ""}>
                    <select
                      id="resState"
                      value={resState}
                      onChange={(e) => { setResState(e.target.value); markChanged() }}
                      className={styles.select}
                    >
                      <option value="">Select state</option>
                      {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </FormField>
                </div>

                <div className={styles.grid2}>
                  <FormField label="Postcode" labelFor="resPostcode" error={errors.resPostcode ?? ""}>
                    <input
                      id="resPostcode"
                      type="text"
                      value={resPostcode}
                      onChange={(e) => { setResPostcode(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter postcode"
                    />
                  </FormField>

                  <FormField label="Country" labelFor="resCountry" error={errors.resCountry ?? ""}>
                    <input
                      id="resCountry"
                      type="text"
                      value={resCountry}
                      onChange={(e) => { setResCountry(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter country"
                    />
                  </FormField>
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={hasPostalAddress}
                  onChange={(e) => { setHasPostalAddress(e.target.checked); markChanged() }}
                />
                <span>Postal address is different</span>
              </label>

              {hasPostalAddress && (
                <div className={styles.postalSection}>
                  <h3>Postal address</h3>

                  <FormField label="Street / PO Box" labelFor="postStreet" error={errors.postStreet ?? ""}>
                    <input
                      id="postStreet"
                      type="text"
                      value={postStreet}
                      onChange={(e) => { setPostStreet(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter street or PO Box"
                    />
                  </FormField>

                  <div className={styles.grid2}>
                    <FormField label="Suburb" labelFor="postSuburb" error={errors.postSuburb ?? ""}>
                      <input
                        id="postSuburb"
                        type="text"
                        value={postSuburb}
                        onChange={(e) => { setPostSuburb(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter suburb"
                      />
                    </FormField>

                    <FormField label="State" labelFor="postState" error={errors.postState ?? ""}>
                      <select
                        id="postState"
                        value={postState}
                        onChange={(e) => { setPostState(e.target.value); markChanged() }}
                        className={styles.select}
                      >
                        <option value="">Select state</option>
                        {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </FormField>
                  </div>

                  <div className={styles.grid2}>
                    <FormField label="Postcode" labelFor="postPostcode" error={errors.postPostcode ?? ""}>
                      <input
                        id="postPostcode"
                        type="text"
                        value={postPostcode}
                        onChange={(e) => { setPostPostcode(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter postcode"
                      />
                    </FormField>

                    <FormField label="Country" labelFor="postCountry" error={errors.postCountry ?? ""}>
                      <input
                        id="postCountry"
                        type="text"
                        value={postCountry}
                        onChange={(e) => { setPostCountry(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter country"
                      />
                    </FormField>
                  </div>
                </div>
              )}

              <FormField label="Phone number" labelFor="phone" error={errors.phone ?? ""}>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter phone number"
                />
              </FormField>

              <FormField label="Occupation or principal activity" labelFor="occupation" error={errors.occupation ?? ""}>
                <input
                  id="occupation"
                  type="text"
                  value={occupation}
                  onChange={(e) => { setOccupation(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter occupation"
                />
              </FormField>

              <FormField label="ABN" labelFor="abn" helperText="Only if relevant or known.">
                <input
                  id="abn"
                  type="text"
                  value={abn}
                  onChange={(e) => { setAbn(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter ABN if relevant"
                />
              </FormField>
            </div>
          )}

          {/* Company form */}
          {currentParty.partyType === 'Company' && (
            <div className={styles.formSection}>
              <h2>Non-individual details</h2>

              <FormField label="Legal entity name" labelFor="entityName" error={errors.entityName ?? ""}>
                <input
                  id="entityName"
                  type="text"
                  value={entityName}
                  onChange={(e) => { setEntityName(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter legal entity name"
                />
              </FormField>

              <FormField label="Trading or business name" labelFor="companyTradingName" helperText="Optional â€” only if different from the legal entity name.">
                <input
                  id="companyTradingName"
                  type="text"
                  value={companyTradingName}
                  onChange={(e) => { setCompanyTradingName(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter trading or business name"
                />
              </FormField>

              <FormField label="Legal form or structure" labelFor="legalForm" error={errors.legalForm ?? ""}>
                <select
                  id="legalForm"
                  value={legalForm}
                  onChange={(e) => { setLegalForm(e.target.value); markChanged() }}
                  className={styles.select}
                >
                  <option value="">Select legal form</option>
                  <option value="Company">Company</option>
                  <option value="Partnership">Partnership</option>
                  <option value="Trust">Trust</option>
                  <option value="Sole trader">Sole trader</option>
                  <option value="Association">Association</option>
                  <option value="Other">Other</option>
                </select>
              </FormField>

              <div className={styles.addressGroup}>
                <h3>Principal business address</h3>

                <FormField label="Street address" labelFor="bizStreet" error={errors.bizStreet ?? ""}>
                  <input
                    id="bizStreet"
                    type="text"
                    value={bizStreet}
                    onChange={(e) => { setBizStreet(e.target.value); markChanged() }}
                    className={styles.input}
                    placeholder="Enter street address"
                  />
                </FormField>

                <div className={styles.grid2}>
                  <FormField label="Suburb" labelFor="bizSuburb" error={errors.bizSuburb ?? ""}>
                    <input
                      id="bizSuburb"
                      type="text"
                      value={bizSuburb}
                      onChange={(e) => { setBizSuburb(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter suburb"
                    />
                  </FormField>

                  <FormField label="State" labelFor="bizState" error={errors.bizState ?? ""}>
                    <select
                      id="bizState"
                      value={bizState}
                      onChange={(e) => { setBizState(e.target.value); markChanged() }}
                      className={styles.select}
                    >
                      <option value="">Select state</option>
                      {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </FormField>
                </div>

                <div className={styles.grid2}>
                  <FormField label="Postcode" labelFor="bizPostcode" error={errors.bizPostcode ?? ""}>
                    <input
                      id="bizPostcode"
                      type="text"
                      value={bizPostcode}
                      onChange={(e) => { setBizPostcode(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter postcode"
                    />
                  </FormField>

                  <FormField label="Country" labelFor="bizCountry" error={errors.bizCountry ?? ""}>
                    <input
                      id="bizCountry"
                      type="text"
                      value={bizCountry}
                      onChange={(e) => { setBizCountry(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter country"
                    />
                  </FormField>
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={hasCompanyPostalAddress}
                  onChange={(e) => { setHasCompanyPostalAddress(e.target.checked); markChanged() }}
                />
                <span>Postal address is different</span>
              </label>

              {hasCompanyPostalAddress && (
                <div className={styles.postalSection}>
                  <h3>Postal address</h3>

                  <FormField label="Street / PO Box" labelFor="compPostStreet" error={errors.compPostStreet ?? ""}>
                    <input
                      id="compPostStreet"
                      type="text"
                      value={compPostStreet}
                      onChange={(e) => { setCompPostStreet(e.target.value); markChanged() }}
                      className={styles.input}
                      placeholder="Enter street or PO Box"
                    />
                  </FormField>

                  <div className={styles.grid2}>
                    <FormField label="Suburb" labelFor="compPostSuburb" error={errors.compPostSuburb ?? ""}>
                      <input
                        id="compPostSuburb"
                        type="text"
                        value={compPostSuburb}
                        onChange={(e) => { setCompPostSuburb(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter suburb"
                      />
                    </FormField>

                    <FormField label="State" labelFor="compPostState" error={errors.compPostState ?? ""}>
                      <select
                        id="compPostState"
                        value={compPostState}
                        onChange={(e) => { setCompPostState(e.target.value); markChanged() }}
                        className={styles.select}
                      >
                        <option value="">Select state</option>
                        {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </FormField>
                  </div>

                  <div className={styles.grid2}>
                    <FormField label="Postcode" labelFor="compPostPostcode" error={errors.compPostPostcode ?? ""}>
                      <input
                        id="compPostPostcode"
                        type="text"
                        value={compPostPostcode}
                        onChange={(e) => { setCompPostPostcode(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter postcode"
                      />
                    </FormField>

                    <FormField label="Country" labelFor="compPostCountry" error={errors.compPostCountry ?? ""}>
                      <input
                        id="compPostCountry"
                        type="text"
                        value={compPostCountry}
                        onChange={(e) => { setCompPostCountry(e.target.value); markChanged() }}
                        className={styles.input}
                        placeholder="Enter country"
                      />
                    </FormField>
                  </div>
                </div>
              )}

              <FormField label="Phone number" labelFor="companyPhone" error={errors.companyPhone ?? ""}>
                <input
                  id="companyPhone"
                  type="tel"
                  value={companyPhone}
                  onChange={(e) => { setCompanyPhone(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter phone number"
                />
              </FormField>

              <FormField label="Registration identifier" error={errors.registrationIdentifier ?? ""}>
                <div className={styles.idTypeRow}>
                  <select
                    aria-label="Registration identifier type"
                    value={registrationIdentifierType}
                    onChange={(e) => { setRegistrationIdentifierType(e.target.value); markChanged() }}
                    className={styles.select}
                  >
                    <option value="ABN">ABN</option>
                    <option value="ACN">ACN</option>
                    <option value="ARBN">ARBN</option>
                    <option value="Other">Other</option>
                  </select>
                  <input
                    aria-label="Registration identifier value"
                    type="text"
                    value={registrationIdentifier}
                    onChange={(e) => { setRegistrationIdentifier(e.target.value); markChanged() }}
                    className={[styles.input, styles.idValueInput].join(' ')}
                    placeholder="Enter identifier"
                  />
                </div>
              </FormField>

              <FormField label="Principal activity or business activity" labelFor="principalActivity" error={errors.principalActivity ?? ""}>
                <input
                  id="principalActivity"
                  type="text"
                  value={principalActivity}
                  onChange={(e) => { setPrincipalActivity(e.target.value); markChanged() }}
                  className={styles.input}
                  placeholder="Enter principal activity"
                />
              </FormField>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={showExitModal}
        onCancel={() => setShowExitModal(false)}
        onConfirm={() => navigate('/')}
      />
    </WizardFrame>
  )
}

export default PartyDetailsPage
