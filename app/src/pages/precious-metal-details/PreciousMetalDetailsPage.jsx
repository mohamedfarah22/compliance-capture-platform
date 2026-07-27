import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { deleteTransaction, loadPreciousMetalItems, loadCustomers, loadTransaction, savePreciousMetalItems } from '../../lib/wizardApi.js'
import styles from './PreciousMetalDetailsPage.module.css'

const METAL_TYPES = ['Gold', 'Iridium', 'Osmium', 'Palladium', 'Platinum', 'Rhodium', 'Ruthenium', 'Silver', 'Alloy', 'Other']
const WEIGHT_UNITS = ['grams', 'kilograms', 'ounces', 'tolas', 'other']
const DESCRIPTION_REQUIRED_TYPES = ['Alloy', 'Other']
const MAX_DESCRIPTION_LENGTH = 500
const MAX_SERIAL_NUMBER_LENGTH = 100

const newItem = (direction = '') => ({
  id: Math.random().toString(36).slice(2, 11),
  direction,
  metalType: '',
  quantity: '',
  weight: '',
  weightUnit: 'grams',
  weightUnitOther: '',
  unitPrice: '',
  lineTotal: 0,
  description: '',
  serialNumber: '',
})

const defaultDirection = (scenario) =>
  scenario === 'sell' ? 'Provided to customer' : 'Received from customer'

const PreciousMetalDetailsPage = () => {
  const navigate = useNavigate()
  const [txn, setTxn] = useState({})
  const [partiesCount, setPartiesCount] = useState(0)
  const [items, setItems] = useState(() => [newItem()])
  const [errors, setErrors] = useState({})
  const [collapsedIds, setCollapsedIds] = useState(() => new Set())
  const [showExitModal, setShowExitModal] = useState(false)

  const isItemComplete = (item) =>
    item.metalType &&
    (!DESCRIPTION_REQUIRED_TYPES.includes(item.metalType) || item.description.trim()) &&
    parseFloat(item.quantity) > 0 &&
    parseFloat(item.weight) > 0 &&
    parseFloat(item.unitPrice) > 0

  useEffect(() => {
    const init = async () => {
      const [txnData, savedItems, customers] = await Promise.all([
        loadTransaction(),
        loadPreciousMetalItems(),
        loadCustomers(),
      ])
      if (txnData) setTxn(txnData)
      setPartiesCount(customers.length)
      const dir = defaultDirection(txnData?.scenario)
      setItems((prev) => {
        const initialItems = savedItems.length > 0 ? savedItems : prev.map((item) => ({ ...item, direction: dir }))
        setCollapsedIds(new Set(initialItems.filter(isItemComplete).map((i) => i.id)))
        return initialItems
      })
    }
    init()
  }, [])

  const updateItem = (index, updates) => {
    setItems((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...updates }
      const qty = parseFloat(next[index].quantity) || 0
      const weight = parseFloat(next[index].weight) || 0
      const price = parseFloat(next[index].unitPrice) || 0
      next[index].lineTotal = qty * weight * price
      return next
    })
  }

  const addItem = () => {
    setItems((prev) => {
      const completedIds = prev.filter(isItemComplete).map((i) => i.id)
      if (completedIds.length > 0) {
        setCollapsedIds((ids) => new Set([...ids, ...completedIds]))
      }
      return [...prev, newItem(defaultDirection(txn.scenario))]
    })
  }

  const removeItem = (index) => {
    setItems((prev) => {
      const removedId = prev[index]?.id
      if (removedId) {
        setCollapsedIds((ids) => {
          if (!ids.has(removedId)) return ids
          const next = new Set(ids)
          next.delete(removedId)
          return next
        })
      }
      return prev.filter((_, i) => i !== index)
    })
  }

  const toggleCollapsed = (id) => {
    setCollapsedIds((ids) => {
      const next = new Set(ids)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const validate = () => {
    const e = {}
    items.forEach((item, i) => {
      if (!item.metalType) e[`${i}_metalType`] = 'Select the metal type.'
      if (DESCRIPTION_REQUIRED_TYPES.includes(item.metalType) && !item.description.trim()) {
        e[`${i}_description`] = `Description is required when metal type is ${item.metalType}.`
      }
      if (item.description.length > MAX_DESCRIPTION_LENGTH) {
        e[`${i}_description`] = `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`
      }
      if (!item.quantity || parseFloat(item.quantity) <= 0) e[`${i}_quantity`] = 'Quantity must be greater than 0.'
      if (!item.weight || parseFloat(item.weight) <= 0) e[`${i}_weight`] = 'Weight must be greater than 0.'
      if (item.weightUnit === 'other' && !item.weightUnitOther.trim()) e[`${i}_weightUnitOther`] = 'Specify the unit.'
      if (!item.unitPrice || parseFloat(item.unitPrice) <= 0) e[`${i}_unitPrice`] = 'Unit price must be greater than 0.'
      if (item.serialNumber.length > MAX_SERIAL_NUMBER_LENGTH) {
        e[`${i}_serialNumber`] = `Serial number must be ${MAX_SERIAL_NUMBER_LENGTH} characters or fewer.`
      }
    })
    setErrors(e)
    const errorIndices = new Set(Object.keys(e).map((key) => parseInt(key.split('_')[0], 10)))
    if (errorIndices.size > 0) {
      setCollapsedIds((ids) => {
        const next = new Set(ids)
        errorIndices.forEach((i) => next.delete(items[i].id))
        return next
      })
    }
    return Object.keys(e).length === 0
  }

  const handleContinue = async () => {
    if (!validate()) return
    await savePreciousMetalItems(items)
    navigate('/review')
  }

  const itemSummary = (item) => {
    const unit = item.weightUnit === 'other' ? item.weightUnitOther || 'unit' : item.weightUnit
    const parts = [
      item.metalType,
      item.quantity && `Qty ${item.quantity}`,
      item.weight && `${item.weight} ${unit}`,
      item.lineTotal > 0 && `$${item.lineTotal.toFixed(2)}`,
    ].filter(Boolean)
    return parts.join(' · ')
  }

  const allComplete = items.length > 0 && items.every(isItemComplete)
  const totalQuantity = items.reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0)
  const totalValue = items.reduce((sum, item) => sum + item.lineTotal, 0)

  const scenarioLabel = txn.scenario === 'sell' ? 'Sell precious metal to customer' : 'Buy precious metal from customer'

  return (
    <WizardFrame
      title="Precious Metal Details"
      subtitle="Record the precious metal items involved in this transaction."
      onBack={() => navigate('/recipient-delivery')}
      onExit={() => setShowExitModal(true)}
      actions={<Button onClick={handleContinue}>Continue</Button>}
    >
      <div className={styles.card}>
        {/* Transaction summary */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Transaction summary</h2>
          <div className={styles.summaryGrid}>
            <div>
              <p className={styles.summaryLabel}>Transaction reference</p>
              <p className={styles.summaryValue}>{txn.transactionRef || '—'}</p>
            </div>
            <div>
              <p className={styles.summaryLabel}>Scenario</p>
              <p className={styles.summaryValue}>{scenarioLabel}</p>
            </div>
            <div>
              <p className={styles.summaryLabel}>Cash amount</p>
              <p className={styles.summaryValue}>
                {txn.cashCurrency || txn.currency || 'AUD'} {txn.cashAmount || '—'}
              </p>
            </div>
            <div>
              <p className={styles.summaryLabel}>Parties</p>
              <p className={styles.summaryValue}>{partiesCount} {partiesCount === 1 ? 'party' : 'parties'}</p>
            </div>
          </div>
        </div>

        {/* Precious metal items */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Precious metal items</h2>
            <Button variant="secondary" onClick={addItem}>
              <Plus size={16} aria-hidden="true" style={{ marginRight: '0.375rem' }} />
              Add item
            </Button>
          </div>

          {items.map((item, index) => {
            const isCollapsed = collapsedIds.has(item.id)
            return (
            <div key={item.id} className={styles.itemCard}>
              <div
                className={styles.itemHeader}
                role="button"
                tabIndex={0}
                onClick={() => toggleCollapsed(item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleCollapsed(item.id)
                  }
                }}
              >
                <div>
                  <p className={styles.itemTitle}>Item {index + 1}</p>
                  {isCollapsed && <p className={styles.itemSummary}>{itemSummary(item)}</p>}
                </div>
                <div className={styles.itemHeaderActions}>
                  {items.length > 1 && (
                    <button
                      className={styles.removeBtn}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeItem(index)
                      }}
                      aria-label={`Remove item ${index + 1}`}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  )}
                  {isCollapsed ? (
                    <ChevronDown size={18} aria-hidden="true" />
                  ) : (
                    <ChevronUp size={18} aria-hidden="true" />
                  )}
                </div>
              </div>

              {!isCollapsed && (
              <div className={styles.itemBody}>
                <FormField label="Metal type" error={errors[`${index}_metalType`]}>
                  <select
                    className={styles.select}
                    value={item.metalType}
                    onChange={(e) => updateItem(index, { metalType: e.target.value })}
                  >
                    <option value="">Select metal type…</option>
                    {METAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </FormField>

                <FormField label="Quantity" error={errors[`${index}_quantity`]}>
                  <input
                    className={styles.input}
                    type="number"
                    value={item.quantity}
                    min="0"
                    step="1"
                    onChange={(e) => updateItem(index, { quantity: e.target.value })}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </FormField>

                <FormField label="Weight" error={errors[`${index}_weight`]}>
                  <div className={styles.weightRow}>
                    <input
                      className={styles.input}
                      type="number"
                      value={item.weight}
                      min="0"
                      step="0.01"
                      placeholder="Value"
                      onChange={(e) => updateItem(index, { weight: e.target.value })}
                      onWheel={(e) => e.currentTarget.blur()}
                    />
                    <select
                      className={styles.select}
                      value={item.weightUnit}
                      onChange={(e) => updateItem(index, { weightUnit: e.target.value })}
                    >
                      {WEIGHT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </FormField>

                {item.weightUnit === 'other' && (
                  <FormField label="Specify unit" error={errors[`${index}_weightUnitOther`]}>
                    <input
                      className={styles.input}
                      type="text"
                      value={item.weightUnitOther}
                      onChange={(e) => updateItem(index, { weightUnitOther: e.target.value })}
                    />
                  </FormField>
                )}

                <FormField
                  label={`Unit price (AUD per ${item.weightUnit === 'other' && item.weightUnitOther ? item.weightUnitOther : item.weightUnit})`}
                  error={errors[`${index}_unitPrice`]}
                >
                  <input
                    className={styles.input}
                    type="number"
                    value={item.unitPrice}
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </FormField>

                <FormField label="Line total (AUD)">
                  <div className={styles.lineTotal}>${item.lineTotal.toFixed(2)}</div>
                </FormField>

                <FormField
                  label="Item description"
                  error={errors[`${index}_description`]}
                  helperText={DESCRIPTION_REQUIRED_TYPES.includes(item.metalType) ? 'Required for Alloy or Other metal types.' : undefined}
                >
                  <input
                    className={styles.input}
                    type="text"
                    value={item.description}
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    placeholder="e.g. 90% gold / 10% copper alloy ring"
                    onChange={(e) => updateItem(index, { description: e.target.value })}
                  />
                </FormField>

                <FormField label="Serial number (if any)" error={errors[`${index}_serialNumber`]}>
                  <input
                    className={styles.input}
                    type="text"
                    value={item.serialNumber}
                    maxLength={MAX_SERIAL_NUMBER_LENGTH}
                    onChange={(e) => updateItem(index, { serialNumber: e.target.value })}
                  />
                </FormField>
              </div>
              )}
            </div>
            )
          })}
        </div>

        {/* Totals */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Precious metal totals</h2>
          <div className={styles.totalsGrid}>
            <div>
              <p className={styles.totalLabel}>Number of items</p>
              <p className={styles.totalValue}>{items.length}</p>
            </div>
            <div>
              <p className={styles.totalLabel}>Total quantity</p>
              <p className={styles.totalValue}>{totalQuantity}</p>
            </div>
            <div>
              <p className={styles.totalLabel}>Total value</p>
              <p className={styles.totalValue}>${totalValue.toFixed(2)} AUD</p>
            </div>
          </div>
        </div>

        {/* Completion banner */}
        {allComplete && (
          <div className={styles.section}>
            <div className={styles.successBanner}>
              <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <p className={styles.successTitle}>Precious metal details complete</p>
                <ul className={styles.completionList}>
                  <li>{items.length} {items.length === 1 ? 'item' : 'items'} recorded</li>
                  <li>Total value: ${totalValue.toFixed(2)} AUD</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={showExitModal}
        onCancel={() => setShowExitModal(false)}
        onConfirm={async () => { await deleteTransaction(); navigate('/start') }}
      />
    </WizardFrame>
  )
}

export default PreciousMetalDetailsPage
