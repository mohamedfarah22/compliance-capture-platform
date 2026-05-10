import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, writeWizardData, readWizardData } from '../../components/wizardStorage.js'
import { mockCompanies, mockIndividuals } from './customerMockData.js'
import styles from './CustomerSearchPage.module.css'

const CustomerSearchPage = () => {
  const navigate = useNavigate()

  const [searchMode, setSearchMode] = useState('individual')

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')

  const [entityName, setEntityName] = useState('')
  const [abnAcn, setAbnAcn] = useState('')
  const [suburb, setSuburb] = useState('')

  const [hasSearched, setHasSearched] = useState(false)
  const [results, setResults] = useState([])

  const [selectedParties, setSelectedParties] = useState(() =>
    readWizardData(wizardStorageKeys.customers, []),
  )

  const [searchError, setSearchError] = useState('')
  const [duplicateError, setDuplicateError] = useState('')
  const [continueError, setContinueError] = useState('')

  const switchMode = (mode) => {
    setSearchMode(mode)
    setSearchError('')
    setDuplicateError('')
    setHasSearched(false)
    setResults([])
  }

  const handleSearch = (e) => {
    e.preventDefault()
    setDuplicateError('')

    if (searchMode === 'individual') {
      const fn = firstName.trim()
      const ln = lastName.trim()

      if (!((fn && ln) || (ln && dateOfBirth))) {
        setSearchError('Enter First Name + Last Name, or Last Name + DOB to search.')
        setHasSearched(false)
        setResults([])
        return
      }

      setSearchError('')

      const filtered = mockIndividuals.filter((p) => {
        const matchesFirstLast =
          fn && ln && p.firstName.toLowerCase().includes(fn.toLowerCase()) && p.lastName.toLowerCase().includes(ln.toLowerCase())
        const matchesLastDob =
          ln && dateOfBirth && p.lastName.toLowerCase().includes(ln.toLowerCase()) && p.dateOfBirth === dateOfBirth
        return matchesFirstLast || matchesLastDob
      })

      setResults(filtered)
      setHasSearched(true)
    } else {
      const en = entityName.trim()
      const abn = abnAcn.trim()

      if (!en && !abn) {
        setSearchError('Enter Registered Entity Name or ABN / ACN to search.')
        setHasSearched(false)
        setResults([])
        return
      }

      setSearchError('')

      const filtered = mockCompanies.filter((p) => {
        const matchesEntity = en && p.entityName.toLowerCase().includes(en.toLowerCase())
        const matchesAbn =
          abn &&
          p.abnAcn.toLowerCase().replace(/\s/g, '').includes(abn.toLowerCase().replace(/\s/g, ''))
        return matchesEntity || matchesAbn
      })

      setResults(filtered)
      setHasSearched(true)
    }
  }

  const handleAddParty = (party) => {
    setDuplicateError('')

    if (selectedParties.some((p) => p.id === party.id)) {
      setDuplicateError('This party has already been added.')
      return
    }

    const updated = [...selectedParties, party]
    setSelectedParties(updated)
    writeWizardData(wizardStorageKeys.customers, updated)
    setContinueError('')
  }

  const handleRemoveParty = (partyId) => {
    const updated = selectedParties.filter((p) => p.id !== partyId)
    setSelectedParties(updated)
    writeWizardData(wizardStorageKeys.customers, updated)
  }

  const handleSaveDraft = () => {
    writeWizardData(wizardStorageKeys.customers, selectedParties)
  }

  const handleContinue = () => {
    if (selectedParties.length === 0) {
      setContinueError('Add at least one customer or party to continue.')
      return
    }

    writeWizardData(wizardStorageKeys.customers, selectedParties)
    navigate('/transaction-details')
  }

  const isPartyAdded = (partyId) => selectedParties.some((p) => p.id === partyId)

  return (
    <WizardFrame
      helperText="Step 1 of 3"
      subtitle="Search for existing records first, then add all parties involved in this transaction."
      title="Add Customers / Parties"
      wide
      actions={
        <>
          <Button onClick={handleSaveDraft} variant="secondary">
            Save draft
          </Button>
          <Button onClick={handleContinue}>Continue</Button>
        </>
      }
    >
      {continueError ? <p className={styles.continueError}>{continueError}</p> : null}

      <div className={styles.layout}>
        <div className={styles.searchPanel}>
          <div aria-label="Search mode" className={styles.modeToggle} role="group">
            <button
              aria-pressed={searchMode === 'individual'}
              className={
                searchMode === 'individual'
                  ? `${styles.modeTab} ${styles.modeTabActive}`
                  : styles.modeTab
              }
              type="button"
              onClick={() => switchMode('individual')}
            >
              Individual
            </button>
            <button
              aria-pressed={searchMode === 'company'}
              className={
                searchMode === 'company'
                  ? `${styles.modeTab} ${styles.modeTabActive}`
                  : styles.modeTab
              }
              type="button"
              onClick={() => switchMode('company')}
            >
              Company / Business
            </button>
          </div>

          <form className={styles.searchForm} onSubmit={handleSearch}>
            {searchMode === 'individual' ? (
              <>
                <FormField label="First name" labelFor="firstName">
                  <TextInput
                    id="firstName"
                    placeholder="First name"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </FormField>
                <FormField label="Last name" labelFor="lastName">
                  <TextInput
                    id="lastName"
                    placeholder="Last name"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </FormField>
                <FormField label="Date of birth" labelFor="dateOfBirth">
                  <DatePicker id="dateOfBirth" value={dateOfBirth} onChange={setDateOfBirth} />
                </FormField>
                <p className={styles.searchHint}>
                  Search using First Name + Last Name, or Last Name + DOB.
                </p>
              </>
            ) : (
              <>
                <FormField label="Registered entity name" labelFor="entityName">
                  <TextInput
                    id="entityName"
                    placeholder="Registered entity name"
                    type="text"
                    value={entityName}
                    onChange={(e) => setEntityName(e.target.value)}
                  />
                </FormField>
                <FormField label="ABN / ACN" labelFor="abnAcn">
                  <TextInput
                    id="abnAcn"
                    placeholder="ABN or ACN"
                    type="text"
                    value={abnAcn}
                    onChange={(e) => setAbnAcn(e.target.value)}
                  />
                </FormField>
                <FormField label="Registered suburb / postcode" labelFor="suburb">
                  <TextInput
                    id="suburb"
                    placeholder="Suburb or postcode"
                    type="text"
                    value={suburb}
                    onChange={(e) => setSuburb(e.target.value)}
                  />
                </FormField>
                <p className={styles.searchHint}>
                  Search using Registered Entity Name or ABN / ACN.
                </p>
              </>
            )}

            {searchError ? <p className={styles.searchError}>{searchError}</p> : null}
            {duplicateError ? <p className={styles.searchError}>{duplicateError}</p> : null}

            <div className={styles.searchActions}>
              <Button type="submit">Search</Button>
              <Button type="button" variant="secondary" onClick={() => navigate('/customers/create')}>
                Create new customer / party
              </Button>
            </div>
          </form>

          <div className={styles.results}>
            {!hasSearched ? (
              <p className={styles.resultsEmpty}>
                Enter customer or party details to search existing records.
              </p>
            ) : results.length === 0 ? (
              <p className={styles.resultsEmpty}>No matching records found.</p>
            ) : (
              <ul className={styles.resultList}>
                {results.map((party) => {
                  const added = isPartyAdded(party.id)
                  return (
                    <li key={party.id} className={styles.resultItem}>
                      <div className={styles.resultInfo}>
                        <span className={styles.resultName}>{party.displayName}</span>
                        <span className={styles.resultDetail}>{party.detail}</span>
                      </div>
                      <Button
                        disabled={added}
                        variant="secondary"
                        onClick={() => handleAddParty(party)}
                      >
                        {added ? 'Added' : 'Add to transaction'}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <div className={styles.selectedPanel}>
          <h2 className={styles.selectedTitle}>Selected for this transaction</h2>
          {selectedParties.length === 0 ? (
            <p className={styles.selectedEmpty}>
              No parties selected yet. Search and add parties to continue.
            </p>
          ) : (
            <ul className={styles.selectedList}>
              {selectedParties.map((party) => (
                <li key={party.id} className={styles.selectedItem}>
                  <div className={styles.selectedInfo}>
                    <span className={styles.selectedName}>{party.displayName}</span>
                    <span className={styles.selectedDetail}>{party.detail}</span>
                  </div>
                  <button
                    className={styles.removeButton}
                    type="button"
                    onClick={() => handleRemoveParty(party.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </WizardFrame>
  )
}

export default CustomerSearchPage
