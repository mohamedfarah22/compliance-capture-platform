import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, readWizardData } from '../../components/wizardStorage.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { deleteTransaction, getTransactionId, initTransaction, migrateNewParties, saveTransaction } from '../../lib/wizardApi.js'
import styles from './TransactionDetailsPage.module.css'

const LOCATION = 'Coburg, VIC'

const DESIGNATED_SERVICES = {
  bullion: {
    sell: 'Sale of bullion for physical cash',
    buy: 'Purchase of bullion for physical cash',
  },
  precious_metal: {
    sell: 'Sale of precious metal for physical cash',
    buy: 'Purchase of precious metal for physical cash',
  },
}

const SCENARIO_LABELS = {
  bullion: { sell: 'Sell bullion to customer', buy: 'Buy bullion from customer' },
  precious_metal: { sell: 'Sell precious metal to customer', buy: 'Buy precious metal from customer' },
}

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - United States Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'AED', label: 'AED - UAE Dirham' },
  { value: 'CNY', label: 'CNY - Chinese Yuan' },
  { value: 'JPY', label: 'JPY - Japanese Yen' },
]

const RATE_SOURCE_OPTIONS = [
  'Internal POS rate',
  'Treasury rate',
  'Daily branch rate',
  'Market rate',
]

const TransactionDetailsPage = () => {
  const navigate = useNavigate()
  const { staffMember } = useAuth()

  const [transactionData] = useState(() => readWizardData(wizardStorageKeys.transaction, {}))
  const [selectedParties] = useState(() => readWizardData(wizardStorageKeys.customers, []))

  const [scenario, setScenario] = useState(transactionData.scenario || 'sell')
  const [serviceType] = useState(transactionData.serviceType || 'bullion')
  const [dateTime, setDateTime] = useState(transactionData.dateTime || '')
  const [transactionRef, setTransactionRef] = useState(transactionData.transactionRef || '')

  const [cashCurrency, setCashCurrency] = useState('AUD')
  const [cashAmount, setCashAmount] = useState('')

  const [foreignCurrencyType, setForeignCurrencyType] = useState('USD')
  const [foreignCurrencyAmount, setForeignCurrencyAmount] = useState('')
  const [fxRate, setFxRate] = useState('')
  const [rateSource, setRateSource] = useState('')

  const [errors, setErrors] = useState({})
  const [showExitModal, setShowExitModal] = useState(false)
  const [saving, setSaving] = useState(false)

  const designatedService = DESIGNATED_SERVICES[serviceType]?.[scenario] || ''
  const serviceLabel = serviceType === 'precious_metal' ? 'precious metal' : 'bullion'

  const audValue =
    cashCurrency === 'AUD'
      ? cashAmount
      : foreignCurrencyAmount && fxRate
        ? (parseFloat(foreignCurrencyAmount) * parseFloat(fxRate)).toFixed(2)
        : ''

  const validateForm = () => {
    const newErrors = {}
    if (!transactionRef.trim()) newErrors.transactionRef = 'Enter the transaction reference.'
    if (!dateTime) newErrors.dateTime = 'Enter the transaction date and time.'
    if (cashCurrency === 'AUD' && (!cashAmount || parseFloat(cashAmount) <= 0)) newErrors.cashAmount = 'Enter the physical cash amount.'
    if (!audValue || parseFloat(audValue) <= 0) newErrors.audValue = 'Enter the Australian dollar value.'
    if (cashCurrency === 'Other') {
      if (!foreignCurrencyType) newErrors.foreignCurrencyType = 'Select the foreign currency type.'
      if (!foreignCurrencyAmount || parseFloat(foreignCurrencyAmount) <= 0) newErrors.foreignCurrencyAmount = 'Enter the foreign currency amount.'
      if (!fxRate || parseFloat(fxRate) <= 0) newErrors.fxRate = 'Enter the FX rate used.'
      if (!rateSource) newErrors.rateSource = 'Select the rate source.'
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const buildFinancialData = () => ({
    cashCurrency,
    cashAmount,
    foreignCurrencyType,
    foreignCurrencyAmount,
    fxRate,
    rateSource,
    lppFlag: false,
    isOtherDsProviderInvolved: false,
  })

  const handleContinue = async () => {
    if (!validateForm()) return
    setSaving(true)
    try {
      const startData = { scenario, serviceType, transactionRef: transactionRef.trim(), dateTime }
      const financialData = buildFinancialData()
      if (getTransactionId()) {
        // Transaction already exists (e.g. user went back) — update it and migrate any parties added since
        await saveTransaction(financialData, startData)
        await migrateNewParties(selectedParties)
      } else {
        // First time through — create the DB row and migrate parties
        await initTransaction({ startData, financialData, parties: selectedParties, staffMember })
      }
      navigate('/party-details')
    } catch (err) {
      setErrors({ _submit: err.message || 'Failed to save. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  const handleExitConfirm = async () => {
    await deleteTransaction()
    navigate('/start')
  }

  const partiesLabel = selectedParties.length === 1 ? '1 party' : `${selectedParties.length} parties`

  const formatAmount = (value) => {
    const num = parseFloat(value)
    if (!value || isNaN(num)) return '—'
    return num.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  return (
    <WizardFrame
      title="Transaction & Cash Details"
      subtitle="Enter the transaction and physical cash details for this reportable transaction."
      helperText="Step 2 of 3"
      backLabel="Back"
      onBack={() => navigate('/customers')}
      onExit={() => setShowExitModal(true)}
      actions={
        <>
          <Button disabled={saving || audValue < 10000} onClick={handleContinue}>
            {saving ? 'Saving…' : 'Continue'}
          </Button>
        </>
      }
    >
      {errors._submit ? <p className={styles.submitError}>{errors._submit}</p> : null}

      {/* Transaction summary */}
      <div className={styles.summaryCard}>
        <h2>Transaction summary</h2>
        <div className={styles.summaryGrid}>
          <div>
            <span className={styles.summaryLabel}>Transaction reference</span>
            <p className={styles.summaryValue}>{transactionRef || 'Not set'}</p>
          </div>
          <div>
            <span className={styles.summaryLabel}>Scenario</span>
            <p className={styles.summaryValue}>
              {SCENARIO_LABELS[serviceType]?.[scenario] || SCENARIO_LABELS.bullion[scenario]}
            </p>
          </div>
          <div>
            <span className={styles.summaryLabel}>Staff member</span>
            <p className={styles.summaryValue}>{staffMember?.full_name || '—'}</p>
          </div>
          <div>
            <span className={styles.summaryLabel}>Parties added</span>
            <p className={styles.summaryValue}>{partiesLabel}</p>
          </div>
        </div>
      </div>

      {/* Transaction details */}
      <div className={styles.card}>
        <h2>Transaction details</h2>

        <div>
          <p className={styles.fieldLabel}>Transaction scenario</p>
          <div aria-label="Transaction scenario" className={styles.modeToggle} role="group">
            <button
              aria-pressed={scenario === 'sell'}
              className={scenario === 'sell' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
              type="button"
              onClick={() => setScenario('sell')}
            >
              {SCENARIO_LABELS[serviceType]?.sell || SCENARIO_LABELS.bullion.sell}
            </button>
            <button
              aria-pressed={scenario === 'buy'}
              className={scenario === 'buy' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
              type="button"
              onClick={() => setScenario('buy')}
            >
              {SCENARIO_LABELS[serviceType]?.buy || SCENARIO_LABELS.bullion.buy}
            </button>
          </div>
          <p className={styles.fieldHint}>
            {scenario === 'sell' ? 'Customer pays business' : 'Business pays customer'}
          </p>
        </div>

        <FormField label="Transaction date and time" labelFor="dateTime" error={errors.dateTime}>
          <TextInput id="dateTime" type="datetime-local" value={dateTime} onChange={(e) => setDateTime(e.target.value)} />
        </FormField>

        <div>
          <p className={styles.fieldLabel}>Transaction location</p>
          <div className={styles.readOnlyValue}>{LOCATION}</div>
        </div>

        <FormField
          label="Transaction reference"
          labelFor="transactionRef"
          helperText="Use the invoice number or internal transaction reference."
          error={errors.transactionRef}
        >
          <TextInput
            id="transactionRef"
            type="text"
            value={transactionRef}
            onChange={(e) => setTransactionRef(e.target.value)}
            placeholder="Enter invoice or transaction reference"
          />
        </FormField>

        <div>
          <p className={styles.fieldLabel}>Designated service</p>
          <div className={styles.readOnlyValue}>{designatedService}</div>
        </div>

      </div>

      {/* Cash details */}
      <div className={styles.card}>
        <h2>Cash details</h2>

        <div>
          <p className={styles.fieldLabel}>Cash currency</p>
          <div aria-label="Cash currency" className={styles.modeToggle} role="group">
            <button
              aria-pressed={cashCurrency === 'AUD'}
              className={cashCurrency === 'AUD' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
              type="button"
              onClick={() => setCashCurrency('AUD')}
            >
              AUD
            </button>
            <button
              aria-pressed={cashCurrency === 'Other'}
              className={cashCurrency === 'Other' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
              type="button"
              onClick={() => setCashCurrency('Other')}
            >
              Other
            </button>
          </div>
        </div>

        {cashCurrency === 'AUD' ? (
          <FormField label="Cash amount" labelFor="cashAmount" error={errors.cashAmount}>
            <div className={styles.amountField}>
              <span aria-hidden="true" className={styles.amountPrefix}>$</span>
              <input
                id="cashAmount"
                type="number"
                step="0.01"
                min="0"
                value={cashAmount}
                onChange={(e) => setCashAmount(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className={`${styles.amountInput} ${styles.amountInputPrefixed}`}
                placeholder="0.00"
              />
            </div>
          </FormField>
        ) : null}

        <FormField
          label="Australian dollar value"
          labelFor="audValue"
          helperText={cashCurrency === 'AUD' ? 'Auto-filled from cash amount' : 'Auto-calculated from foreign amount × FX rate'}
          error={errors.audValue}
        >
          <div className={styles.amountField}>
            <span aria-hidden="true" className={styles.amountPrefix}>$</span>
            <input
              id="audValue"
              type="number"
              step="0.01"
              min="0"
              value={audValue}
              disabled
              className={`${styles.amountInput} ${styles.amountInputPrefixed}`}
              placeholder="0.00"
            />
          </div>
        </FormField>
      </div>

      {/* Foreign currency details */}
      {cashCurrency === 'Other' ? (
        <div className={styles.card}>
          <h2>Foreign currency details</h2>

          <FormField label="Foreign currency type" labelFor="foreignCurrencyType" error={errors.foreignCurrencyType}>
            <select id="foreignCurrencyType" value={foreignCurrencyType} onChange={(e) => setForeignCurrencyType(e.target.value)} className={styles.select}>
              {CURRENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="Foreign currency amount" labelFor="foreignCurrencyAmount" error={errors.foreignCurrencyAmount}>
            <TextInput id="foreignCurrencyAmount" type="number" step="0.01" min="0" value={foreignCurrencyAmount} onChange={(e) => setForeignCurrencyAmount(e.target.value)} placeholder="0.00" />
          </FormField>

          <FormField label="FX rate used" labelFor="fxRate" error={errors.fxRate}>
            <TextInput id="fxRate" type="number" step="0.0001" min="0" value={fxRate} onChange={(e) => setFxRate(e.target.value)} placeholder="0.0000" />
          </FormField>

          <FormField label="Rate source" labelFor="rateSource" error={errors.rateSource}>
            <select id="rateSource" value={rateSource} onChange={(e) => setRateSource(e.target.value)} className={styles.select}>
              <option value="">Select rate source</option>
              {RATE_SOURCE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </FormField>
        </div>
      ) : null}

      {/* Value checks */}
      <div className={styles.summaryCard}>
        <h2>Value checks</h2>
        <div className={styles.summaryGrid}>
          <div>
            <span className={styles.summaryLabel}>Cash amount entered</span>
            <p className={styles.summaryValue}>
              {cashCurrency === 'AUD' ? '$' : ''}
              {formatAmount(cashCurrency === 'AUD' ? cashAmount : foreignCurrencyAmount)}
              {cashCurrency === 'Other' && foreignCurrencyType ? ` ${foreignCurrencyType}` : ''}
            </p>
          </div>
          <div>
            <span className={styles.summaryLabel}>AUD equivalent</span>
            <p className={styles.summaryValue}>${formatAmount(audValue)}</p>
          </div>
          <div>
            <span className={styles.summaryLabel}>Meets TTR threshold</span>
            <p className={`${styles.summaryValue} ${audValue >= 10000 ? styles.summaryPositive : styles.summaryNegative}`}>
              {audValue >= 10000 ? 'Yes' : 'No'}
            </p>
          </div>
          <div>
            <span className={styles.summaryLabel}>Scenario</span>
            <p className={styles.summaryValue}>
              {scenario === 'sell'
                ? `Business received physical cash (${serviceLabel})`
                : `Business paid physical cash (${serviceLabel})`}
            </p>
          </div>
        </div>
      </div>

      {audValue && parseFloat(audValue) < 10000 ? (
        <p className={styles.thresholdWarning}>
          Ensure the cash transaction amount is greater than $10,000 for it to be reportable.
        </p>
      ) : null}

      <ConfirmModal
        isOpen={showExitModal}
        onCancel={() => setShowExitModal(false)}
        onConfirm={handleExitConfirm}
      />

      <p className={styles.infoNote}>
        This transaction is being recorded as a reportable physical cash transaction.
      </p>
    </WizardFrame>
  )
}

export default TransactionDetailsPage
