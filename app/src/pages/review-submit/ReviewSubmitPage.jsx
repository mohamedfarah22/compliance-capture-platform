import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Building2, CheckCircle2, Edit2, User, XCircle } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import {
  completeTransaction,
  loadBullionItems,
  loadConductingPerson,
  loadCustomers,
  loadIdVerifications,
  loadPreciousMetalItems,
  loadRecipientDelivery,
  loadTransaction,
} from '../../lib/wizardApi.js'
import styles from './ReviewSubmitPage.module.css'

const partyDisplayName = (party) => {
  if (party.type === 'individual') {
    return party.displayName || party.fullName || [party.firstName, party.middleName, party.lastName].filter(Boolean).join(' ') || 'Unknown'
  }
  return party.entityName || party.displayName || 'Unknown entity'
}

const fmtAmount = (amount) => {
  const num = parseFloat(amount)
  return isNaN(num) ? (amount || '—') : num.toFixed(2)
}

const ReviewSubmitPage = () => {
  const navigate = useNavigate()
  const { reportingEntity, staffMember } = useAuth()
  const [txn, setTxn] = useState({})
  const [parties, setParties] = useState([])
  const [conductingPerson, setConductingPerson] = useState(null)
  const [recipient, setRecipient] = useState(null)
  const [bullion, setBullion] = useState([])
  const [preciousMetal, setPreciousMetal] = useState([])
  const [idVerification, setIdVerification] = useState({})
  const [people, setPeople] = useState([])
  const [issues, setIssues] = useState([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    const init = async () => {
      const [txnData, customersData, cpData, recipientData, bullionData, preciousMetalData, idData] = await Promise.all([
        loadTransaction(),
        loadCustomers(),
        loadConductingPerson(),
        loadRecipientDelivery(),
        loadBullionItems(),
        loadPreciousMetalItems(),
        loadIdVerifications(),
      ])

      const txnSafe = txnData || {}
      const isPreciousMetal = txnSafe.serviceType === 'precious_metal'
      setTxn(txnSafe)
      setParties(customersData)
      setConductingPerson(cpData)
      setRecipient(recipientData)
      setBullion(bullionData)
      setPreciousMetal(preciousMetalData)
      setIdVerification(idData)

      const loadedPeople = []
      customersData.filter((p) => p.type === 'individual').forEach((p) => {
        loadedPeople.push({ id: `party-${p.id}`, displayName: p.displayName })
      })
      if (cpData?.hasConductingPerson === 'yes' && cpData.fullName) {
        loadedPeople.push({ id: 'conducting-person', displayName: cpData.fullName })
      }
      setPeople(loadedPeople)

      const v = []
      if (!txnSafe.scenario) v.push({ section: 'Transaction Details', message: 'Transaction scenario missing.', route: '/transaction-details', blocking: true })
      if (!txnSafe.cashAmount || parseFloat(txnSafe.cashAmount) <= 0) v.push({ section: 'Transaction Details', message: 'Cash amount missing or invalid.', route: '/transaction-details', blocking: true })
      if (!customersData.length) v.push({ section: 'Customers / Parties', message: 'At least one party is required.', route: '/customers', blocking: true })
      if (!recipientData?.recipientIsParty) v.push({ section: 'Recipient / Delivery', message: 'Recipient information incomplete.', route: '/recipient-delivery', blocking: true })
      if (!recipientData?.purposeOfTransfer?.trim()) v.push({ section: 'Recipient / Delivery', message: 'Purpose of transfer missing.', route: '/recipient-delivery', blocking: true })
      if (isPreciousMetal) {
        if (!preciousMetalData.length) v.push({ section: 'Precious Metal Details', message: 'At least one precious metal item is required.', route: '/precious-metal-details', blocking: true })
      } else {
        if (!bullionData.length) v.push({ section: 'Bullion Details', message: 'At least one bullion item is required.', route: '/bullion-details', blocking: true })
      }
      if (recipientData?.deliveryAddressDifferent === null) v.push({ section: 'Recipient / Delivery', message: 'Delivery address preference not specified.', route: '/recipient-delivery', blocking: false })
      setIssues(v)
    }
    init()
  }, [])

  const blockingIssues = issues.filter((i) => i.blocking)
  const warnings = issues.filter((i) => !i.blocking)
  const isComplete = blockingIssues.length === 0

  const handleComplete = async () => {
    if (!isComplete || isSubmitting) return
    setIsSubmitting(true)
    setSubmitError('')
    try {
      const result = await completeTransaction()
      if (result.ok) {
        navigate('/transaction-complete', {
            state: {
              transactionRef: txn.transactionRef,
              completedAt: result.completedAt,
            },
          })
      } else {
        setSubmitError(result.errors?.[0]?.message || 'Failed to complete transaction.')
      }
    } catch (err) {
      setSubmitError(err.message || 'Failed to complete transaction.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const isPreciousMetal = txn.serviceType === 'precious_metal'
  const bullionTotal = bullion.reduce((sum, item) => sum + (item.lineTotal || 0), 0)
  const preciousMetalTotal = preciousMetal.reduce((sum, item) => sum + (item.lineTotal || 0), 0)

  const recipientName = () => {
    if (!recipient) return '—'
    if (recipient.recipientIsParty === 'yes') {
      const party = parties.find((p) => p.id === recipient.selectedPartyId)
      return party ? partyDisplayName(party) : `Party ID: ${recipient.selectedPartyId}`
    }
    return recipient.recipientFullName || '—'
  }

  return (
    <WizardFrame
      title="Review / Validate / Submit"
      subtitle="Review the transaction and resolve any issues before completion."
      onBack={() => navigate(isPreciousMetal ? '/precious-metal-details' : '/bullion-details')}
      onExit={() => navigate('/start')}
      actions={
        <Button onClick={handleComplete} disabled={!isComplete || isSubmitting}>
          {isSubmitting ? 'Submitting…' : 'Complete / Reportable'}
        </Button>
      }
    >
      <div className={styles.content}>
        {/* Status banner */}
        {blockingIssues.length > 0 ? (
          <div className={`${styles.banner} ${styles.bannerError}`}>
            <XCircle size={20} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <div>
              <p className={styles.bannerTitle}>Cannot complete — required fields missing</p>
              <p className={styles.bannerSub}>
                {blockingIssues.length} required {blockingIssues.length === 1 ? 'field' : 'fields'} missing
              </p>
            </div>
          </div>
        ) : warnings.length > 0 ? (
          <div className={`${styles.banner} ${styles.bannerWarning}`}>
            <AlertCircle size={20} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <div>
              <p className={styles.bannerTitle}>
                Ready to complete — {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'} to review
              </p>
            </div>
          </div>
        ) : (
          <div className={`${styles.banner} ${styles.bannerSuccess}`}>
            <CheckCircle2 size={20} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <p className={styles.bannerTitle}>This transaction is ready to be completed.</p>
          </div>
        )}

        {submitError && (
          <div className={`${styles.banner} ${styles.bannerError}`}>
            <XCircle size={20} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <p className={styles.bannerTitle}>{submitError}</p>
          </div>
        )}

        {/* Validation issues */}
        {issues.length > 0 && (
          <div className={styles.card}>
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Validation</h2>
              {blockingIssues.length > 0 && (
                <div className={styles.issueGroup}>
                  <p className={styles.issueSectionLabel}>
                    <XCircle size={14} aria-hidden="true" />
                    Missing required fields
                  </p>
                  {blockingIssues.map((issue, i) => (
                    <button
                      key={i}
                      className={`${styles.issueCard} ${styles.issueCardBlocking}`}
                      onClick={() => navigate(issue.route)}
                    >
                      <span className={styles.issueSection}>{issue.section}</span>
                      <span className={styles.issueMessage}>{issue.message}</span>
                    </button>
                  ))}
                </div>
              )}
              {warnings.length > 0 && (
                <div className={styles.issueGroup}>
                  <p className={styles.issueSectionLabel}>
                    <AlertCircle size={14} aria-hidden="true" />
                    Warnings
                  </p>
                  {warnings.map((issue, i) => (
                    <button
                      key={i}
                      className={`${styles.issueCard} ${styles.issueCardWarning}`}
                      onClick={() => navigate(issue.route)}
                    >
                      <span className={styles.issueSection}>{issue.section}</span>
                      <span className={styles.issueMessage}>{issue.message}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Summary card */}
        <div className={styles.card}>
          {/* Transaction */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Transaction summary</h2>
              <button className={styles.editBtn} onClick={() => navigate('/transaction-details')}>
                <Edit2 size={14} aria-hidden="true" /> Edit
              </button>
            </div>
            <div className={styles.detailGrid}>
              <div>
                <p className={styles.detailLabel}>Transaction reference</p>
                <p className={styles.detailValue}>{txn.transactionRef || '—'}</p>
              </div>
              <div>
                <p className={styles.detailLabel}>Date / time</p>
                <p className={styles.detailValue}>{txn.dateTime || '—'}</p>
              </div>
              <div>
                <p className={styles.detailLabel}>Scenario</p>
                <p className={styles.detailValue}>
                  {txn.scenario === 'sell'
                    ? `Sell ${isPreciousMetal ? 'precious metal' : 'bullion'} to customer`
                    : `Buy ${isPreciousMetal ? 'precious metal' : 'bullion'} from customer`}
                </p>
              </div>
              <div>
                <p className={styles.detailLabel}>Staff member</p>
                <p className={styles.detailValue}>{txn.staffMember || '—'}</p>
              </div>
              <div>
                <p className={styles.detailLabel}>Cash amount</p>
                <p className={styles.detailValue}>
                  {txn.cashCurrency || 'AUD'} {fmtAmount(txn.cashAmount)}
                </p>
              </div>
              {txn.cashCurrency && txn.cashCurrency !== 'AUD' && (
                <>
                  <div>
                    <p className={styles.detailLabel}>AUD value</p>
                    <p className={styles.detailValue}>AUD {fmtAmount(txn.audValue)}</p>
                  </div>
                  <div>
                    <p className={styles.detailLabel}>FX rate</p>
                    <p className={styles.detailValue}>{txn.foreignCurrency?.fxRate || '—'}</p>
                  </div>
                </>
              )}
              <div>
                <p className={styles.detailLabel}>Designated service</p>
                <p className={styles.detailValue}>{txn.designatedService || 'Auto-derived'}</p>
              </div>
            </div>
          </div>

          {/* Parties */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Parties ({parties.length})</h2>
              <button className={styles.editBtn} onClick={() => navigate('/party-details')}>
                <Edit2 size={14} aria-hidden="true" /> Edit
              </button>
            </div>
            {parties.length === 0 ? (
              <p className={styles.empty}>No parties recorded.</p>
            ) : (
              <div className={styles.itemList}>
                {parties.map((party) => (
                  <div key={party.id} className={styles.partyCard}>
                    {party.type === 'individual'
                      ? <User size={18} className={styles.partyIcon} aria-hidden="true" />
                      : <Building2 size={18} className={styles.partyIcon} aria-hidden="true" />
                    }
                    <div>
                      <p className={styles.partyName}>{partyDisplayName(party)}</p>
                      <p className={styles.partySub}>
                        {party.type === 'individual' ? 'Individual' : 'Company'}
                        {party.dateOfBirth ? ` · DOB: ${party.dateOfBirth}` : ''}
                      </p>
                    </div>
                    <CheckCircle2 size={18} className={styles.checkIcon} aria-hidden="true" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Conducting person */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Conducting person</h2>
              <button className={styles.editBtn} onClick={() => navigate('/conducting-person')}>
                <Edit2 size={14} aria-hidden="true" /> Edit
              </button>
            </div>
            {conductingPerson?.hasConductingPerson === 'yes' ? (
              <div className={styles.detailGrid}>
                <div>
                  <p className={styles.detailLabel}>Full name</p>
                  <p className={styles.detailValue}>{conductingPerson.fullName || '—'}</p>
                </div>
                <div>
                  <p className={styles.detailLabel}>Relationship</p>
                  <p className={styles.detailValue}>{conductingPerson.relationship || '—'}</p>
                </div>
                <div>
                  <p className={styles.detailLabel}>Authority to act</p>
                  <p className={styles.detailValue}>{conductingPerson.authorityToAct || '—'}</p>
                </div>
              </div>
            ) : (
              <p className={styles.empty}>The conducting person is the same as the customer / party.</p>
            )}
          </div>

          {/* Recipient / delivery */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Recipient / Delivery</h2>
              <button className={styles.editBtn} onClick={() => navigate('/recipient-delivery')}>
                <Edit2 size={14} aria-hidden="true" /> Edit
              </button>
            </div>
            {recipient ? (
              <div className={styles.detailGrid}>
                <div>
                  <p className={styles.detailLabel}>Recipient</p>
                  <p className={styles.detailValue}>{recipientName()}</p>
                </div>
                <div>
                  <p className={styles.detailLabel}>Delivery method</p>
                  <p className={styles.detailValue}>{recipient.deliveryMethod || '—'}</p>
                </div>
                <div className={styles.spanFull}>
                  <p className={styles.detailLabel}>Purpose of transfer</p>
                  <p className={styles.detailValue}>{recipient.purposeOfTransfer || '—'}</p>
                </div>
                {recipient.handoverNotes && (
                  <div className={styles.spanFull}>
                    <p className={styles.detailLabel}>Handover notes</p>
                    <p className={styles.detailValue}>{recipient.handoverNotes}</p>
                  </div>
                )}
              </div>
            ) : (
              <p className={styles.empty}>No recipient information recorded.</p>
            )}
          </div>

          {/* Bullion */}
          {!isPreciousMetal && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  Bullion ({bullion.length} {bullion.length === 1 ? 'item' : 'items'})
                </h2>
                <button className={styles.editBtn} onClick={() => navigate('/bullion-details')}>
                  <Edit2 size={14} aria-hidden="true" /> Edit
                </button>
              </div>
              {bullion.length === 0 ? (
                <p className={styles.empty}>No bullion items recorded.</p>
              ) : (
                <div className={styles.itemList}>
                  {bullion.map((item, i) => (
                    <div key={i} className={styles.bullionCard}>
                      <p className={styles.bullionTitle}>
                        {item.metalType} {item.productType} — {item.purity}
                      </p>
                      <div className={styles.bullionMeta}>
                        <span>Qty: {item.quantity}</span>
                        <span>Weight: {item.weight} {item.weightUnit === 'other' ? item.weightUnitOther : item.weightUnit}</span>
                        <span>Unit price: ${fmtAmount(item.unitPrice)}</span>
                        <span>Line total: ${(item.lineTotal || 0).toFixed(2)}</span>
                      </div>
                      {item.description && <p className={styles.bullionDesc}>{item.description}</p>}
                    </div>
                  ))}
                  <div className={styles.bullionTotals}>
                    Total bullion value: <strong>${bullionTotal.toFixed(2)} AUD</strong>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Precious metal */}
          {isPreciousMetal && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  Precious metal ({preciousMetal.length} {preciousMetal.length === 1 ? 'item' : 'items'})
                </h2>
                <button className={styles.editBtn} onClick={() => navigate('/precious-metal-details')}>
                  <Edit2 size={14} aria-hidden="true" /> Edit
                </button>
              </div>
              {preciousMetal.length === 0 ? (
                <p className={styles.empty}>No precious metal items recorded.</p>
              ) : (
                <div className={styles.itemList}>
                  {preciousMetal.map((item, i) => (
                    <div key={i} className={styles.bullionCard}>
                      <p className={styles.bullionTitle}>{item.metalType}</p>
                      <div className={styles.bullionMeta}>
                        <span>Qty: {item.quantity}</span>
                        <span>Weight: {item.weight} {item.weightUnit === 'other' ? item.weightUnitOther : item.weightUnit}</span>
                        <span>Unit price: ${fmtAmount(item.unitPrice)}</span>
                        <span>Line total: ${(item.lineTotal || 0).toFixed(2)}</span>
                        {item.serialNumber && <span>Serial: {item.serialNumber}</span>}
                      </div>
                      {item.description && <p className={styles.bullionDesc}>{item.description}</p>}
                    </div>
                  ))}
                  <div className={styles.bullionTotals}>
                    Total precious metal value: <strong>${preciousMetalTotal.toFixed(2)} AUD</strong>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ID verification */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>ID verification</h2>
              <button className={styles.editBtn} onClick={() => navigate('/id-verification')}>
                <Edit2 size={14} aria-hidden="true" /> Edit
              </button>
            </div>
            {Object.keys(idVerification).length === 0 ? (
              <p className={styles.empty}>No ID verification data recorded.</p>
            ) : (
              <div className={styles.itemList}>
                {Object.entries(idVerification).map(([personId, data]) => {
                  const person = people.find((p) => p.id === personId)
                  return (
                    <div key={personId} className={styles.idCard}>
                      <p className={styles.idName}>{person?.displayName || personId}</p>
                      {data.verificationMethod === 'Relied on prior identification' ? (
                        <div className={styles.relianceBadge}>
                          Relied on prior verification ·{' '}
                          {data.priorVerificationSummary?.documentType} {data.priorVerificationSummary?.documentNumber}
                          {data.priorVerificationSummary?.verifiedDate && ` · verified ${data.priorVerificationSummary.verifiedDate}`}
                        </div>
                      ) : (
                        <div className={styles.bullionMeta}>
                          <span>Method: {data.verificationMethod || '—'}</span>
                          <span>Document: {data.documentType || '—'}</span>
                          {data.documentNumber && <span>Number: {data.documentNumber}</span>}
                          {data.issuer && <span>Issuer: {data.issuer}</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Reporting details */}
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Reporting details</h2>
            <div className={styles.reportingGrid}>
              <div className={styles.reportingBox}>
                <h3 className={styles.reportingSubtitle}>Reporting entity</h3>
                <div className={styles.detailGrid}>
                  <div>
                    <p className={styles.detailLabel}>Entity name</p>
                    <p className={styles.detailValue}>{reportingEntity?.legal_name || '—'}</p>
                  </div>
                  <div>
                    <p className={styles.detailLabel}>ABN</p>
                    <p className={styles.detailValue}>{reportingEntity?.abn || '—'}</p>
                  </div>
                  <div>
                    <p className={styles.detailLabel}>AUSTRAC Account Number (AAN)</p>
                    <p className={styles.detailValue}>
                      {reportingEntity?.austrac_account_number || <span style={{ color: 'var(--c-warning, #b45309)' }}>Not configured — contact your system administrator</span>}
                    </p>
                  </div>
                  <div className={styles.spanFull}>
                    <p className={styles.detailLabel}>Branch address</p>
                    <p className={styles.detailValue}>
                      {reportingEntity
                        ? [reportingEntity.address_street, reportingEntity.address_suburb, reportingEntity.address_state, reportingEntity.address_postcode].filter(Boolean).join(', ')
                        : '—'}
                    </p>
                  </div>
                </div>
              </div>
              <div className={styles.reportingBox}>
                <h3 className={styles.reportingSubtitle}>Person completing report</h3>
                <div className={styles.detailGrid}>
                  <div>
                    <p className={styles.detailLabel}>Full name</p>
                    <p className={styles.detailValue}>{staffMember?.full_name || txn.staffMember || '—'}</p>
                  </div>
                  <div>
                    <p className={styles.detailLabel}>Job title</p>
                    <p className={styles.detailValue}>{staffMember?.job_title || '—'}</p>
                  </div>
                  <div>
                    <p className={styles.detailLabel}>Email</p>
                    <p className={styles.detailValue}>{staffMember?.email || '—'}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </WizardFrame>
  )
}

export default ReviewSubmitPage
