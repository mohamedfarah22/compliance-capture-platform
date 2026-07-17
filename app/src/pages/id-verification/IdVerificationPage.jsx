import { useState, useRef, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Circle, Camera, User } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import {
  deleteTransaction,
  fetchPriorVerifications,
  getIdImageSignedUrls,
  getTransactionId,
  loadCustomers,
  loadConductingPerson,
  loadIdVerifications,
  saveIdVerifications,
  uploadIdImage,
} from '../../lib/wizardApi.js'
import styles from './IdVerificationPage.module.css'

const VERIFICATION_METHODS = [
  'Sighted original document',
  'Sighted certified copy',
  'Electronic data source',
  'Relied on prior identification',
]

const DOCUMENT_TYPES = [
  'Driver licence',
  'Passport',
  'Proof of age card',
  'National identity card',
  'Medicare card',
  'Birth certificate',
  'Other government document',
  'Electronic verification source',
  'Other',
]

const BACK_REQUIRED_TYPES = new Set(['Driver licence'])

const RELIANCE_REASONS = [
  { value: 'customer_known_to_business',         label: 'Customer known to business' },
  { value: 'prior_id_reviewed_still_valid',      label: 'Prior ID reviewed and still valid' },
  { value: 'customer_confirmed_details_unchanged', label: 'Customer confirmed details unchanged' },
  { value: 'manager_approved',                   label: 'Manager approved reliance' },
  { value: 'other',                              label: 'Other' },
]

function evaluateReliance(prior, policy) {
  const daysSince = Math.floor((Date.now() - new Date(prior.created_at)) / 86400000)
  const isExpired = prior.has_expiry && prior.expiry_date && new Date(prior.expiry_date) < new Date()
  if ((isExpired && policy.blockOnExpired) || daysSince > policy.maxRelianceDays) return 'blocked'
  if (isExpired) return 'warned'
  return 'eligible'
}

function generateVerificationDescription(data) {
  const docType = data.documentTypeOther?.trim() || data.documentType
  switch (data.verificationMethod) {
    case 'Sighted original document':
      return `Original ${docType} sighted in person`
    case 'Sighted certified copy':
      return `Certified copy of ${docType} sighted`
    case 'Electronic data source':
      return `Electronic verification via ${data.elecDataSrc || 'approved data source'}`
    case 'Relied on prior identification': {
      const s = data.priorVerificationSummary
      return s
        ? `Relied on prior identification — ${s.documentType} ${s.documentNumber} verified ${s.verifiedDate} by ${s.verifiedBy}`
        : 'Relied on prior identification'
    }
    default:
      return data.verificationMethod || ''
  }
}

const emptyVerification = () => ({
  verificationMethod: '',
  verificationMethodOther: '',
  documentType: '',
  documentTypeOther: '',
  documentNumber: '',
  issuer: '',
  hasExpiry: null,
  expiryDate: '',
  verificationDescription: '',
  elecDataSrc: '',
  frontImageId: null,
  frontImageBlob: null,
  backImageId: null,
  backImageBlob: null,
  isComplete: false,
  priorVerificationId: null,
  priorVerificationSummary: null,
  relianceReason: null,
  imageApproved: false,
  idCountryCode: 'AU',
})

function base64ToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)[1]
  const binary = atob(data)
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ─── Prior verification picker ────────────────────────────────────────────────

const ELIGIBILITY_BADGE = {
  eligible: { className: 'badgeEligible', label: '✓ Valid' },
  warned:   { className: 'badgeWarned',   label: '⚠ Expired' },
  blocked:  { className: 'badgeBlocked',  label: '✕ Blocked' },
}

const PriorVerificationPicker = ({ records, loading, onSelect, imageUrlMap, onImageClick }) => {
  const [query, setQuery] = useState('')
  const filtered = query.trim()
    ? records.filter(
        (r) =>
          r.document_number.toLowerCase().includes(query.toLowerCase()) ||
          r.document_type.toLowerCase().includes(query.toLowerCase()),
      )
    : records

  if (loading) return <p className={styles.priorPickerEmpty}>Loading prior records…</p>

  return (
    <div className={styles.priorPicker}>
      <input
        type="text"
        placeholder="Search by document number or type…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={styles.priorPickerSearch}
        aria-label="Search prior verifications"
      />
      {filtered.length === 0 ? (
        <p className={styles.priorPickerEmpty}>
          {records.length === 0
            ? 'No prior verification records found for this person.'
            : 'No records match your search.'}
        </p>
      ) : (
        <div className={styles.priorPickerList}>
          {filtered.map((record) => {
            const badge = ELIGIBILITY_BADGE[record.eligibility] ?? ELIGIBILITY_BADGE.eligible
            const verifiedDate = new Date(record.created_at).toLocaleDateString('en-AU')
            const expiryText = record.has_expiry && record.expiry_date
              ? ` · Expires ${new Date(record.expiry_date + 'T00:00:00').toLocaleDateString('en-AU')}`
              : ''
            return (
              <button
                key={record.id}
                type="button"
                className={styles.priorPickerItem}
                onClick={() => onSelect(record)}
              >
                <div className={styles.priorPickerItemHeader}>
                  <p className={styles.priorPickerName}>
                    {record.document_type} · {record.document_number}
                  </p>
                  <span className={`${styles.badge} ${styles[badge.className]}`}>{badge.label}</span>
                </div>
                <p className={styles.priorPickerMeta}>
                  Verified {verifiedDate} by {record.verified_by_name} · Ref: {record.transaction_ref}{expiryText}
                </p>
                {(imageUrlMap[record.front_image_id] || imageUrlMap[record.back_image_id]) && (
                  <div className={styles.priorPickerImages}>
                    {imageUrlMap[record.front_image_id] && (
                      <img src={imageUrlMap[record.front_image_id]} alt="Front of ID" className={styles.priorPickerThumbnail} onClick={(e) => { e.stopPropagation(); onImageClick(imageUrlMap[record.front_image_id]) }} />
                    )}
                    {imageUrlMap[record.back_image_id] && (
                      <img src={imageUrlMap[record.back_image_id]} alt="Back of ID" className={styles.priorPickerThumbnail} onClick={(e) => { e.stopPropagation(); onImageClick(imageUrlMap[record.back_image_id]) }} />
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const IdVerificationPage = () => {
  const navigate = useNavigate()
  const { reportingEntity } = useAuth()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)

  const policy = {
    maxRelianceDays: reportingEntity?.idv_max_reliance_days ?? 730,
    blockOnExpired: reportingEntity?.idv_block_on_expired ?? false,
  }

  const [loading, setLoading] = useState(true)
  const [people, setPeople] = useState([])
  const [verificationData, setVerificationData] = useState({})
  const [currentPersonIndex, setCurrentPersonIndex] = useState(0)
  const [errors, setErrors] = useState({})
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const [showSwitchModal, setShowSwitchModal] = useState(false)
  const [pendingPersonIndex, setPendingPersonIndex] = useState(null)
  const [continueError, setContinueError] = useState('')
  const [showExitModal, setShowExitModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [priorVerificationsMap, setPriorVerificationsMap] = useState({})

  const [imageUrlMap, setImageUrlMap] = useState({})
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const [cameraError, setCameraError] = useState('')
  const [capturingFor, setCapturingFor] = useState(null)
  const [pendingFrontCapture, setPendingFrontCapture] = useState(null)
  const [pendingBackCapture, setPendingBackCapture] = useState(null)

  useEffect(() => {
    const init = async () => {
      try {
        const [customers, cp] = await Promise.all([loadCustomers(), loadConductingPerson()])
        const loaded = []
        customers
          .filter((p) => p.type === 'individual')
          .forEach((p) => loaded.push({
            id: `party-${p.id}`,
            displayName: p.displayName,
            role: 'party',
            type: p.type,
            firstName: p.firstName,
            lastName: p.lastName,
            dateOfBirth: p.dateOfBirth,
          }))
        if (cp?.hasConductingPerson === 'yes' && cp.fullName) {
          loaded.push({
            id: 'conducting-person',
            displayName: cp.fullName,
            role: 'conducting-person',
            linkedParty: cp.representedPartyId,
            cpDbId: cp.id,
          })
        }
        setPeople(loaded)

        const [saved, priorsEntries] = await Promise.all([
          loadIdVerifications(),
          Promise.all(
            loaded.map(async (p) => {
              try { return [p.id, await fetchPriorVerifications(p)] }
              catch { return [p.id, []] }
            })
          ),
        ])
        setPriorVerificationsMap(Object.fromEntries(priorsEntries))

        const imageIds = []
        Object.values(saved).forEach((v) => {
          if (v.frontImageId) imageIds.push(v.frontImageId)
          if (v.backImageId) imageIds.push(v.backImageId)
        })
        priorsEntries.forEach(([, records]) =>
          records.forEach((r) => {
            if (r.front_image_id) imageIds.push(r.front_image_id)
            if (r.back_image_id) imageIds.push(r.back_image_id)
          })
        )
        if (imageIds.length) setImageUrlMap(await getIdImageSignedUrls(imageIds))

        const priorsById = Object.fromEntries(priorsEntries)
        const autoPolicy = {
          maxRelianceDays: reportingEntity?.idv_max_reliance_days ?? 730,
          blockOnExpired: reportingEntity?.idv_block_on_expired ?? false,
        }
        const initial = {}
        loaded.forEach((p) => {
          if (saved[p.id]) {
            initial[p.id] = saved[p.id]
          } else {
            const eligiblePrior = (priorsById[p.id] ?? [])
              .map((r) => ({ ...r, eligibility: evaluateReliance(r, autoPolicy) }))
              .find((r) => r.eligibility === 'eligible')
            if (eligiblePrior) {
              initial[p.id] = {
                ...emptyVerification(),
                verificationMethod: 'Relied on prior identification',
                priorVerificationId: eligiblePrior.id,
                priorVerificationSummary: {
                  documentType: eligiblePrior.document_type,
                  documentNumber: eligiblePrior.document_number,
                  verifiedDate: new Date(eligiblePrior.created_at).toLocaleDateString('en-AU'),
                  verifiedBy: eligiblePrior.verified_by_name,
                  transactionRef: eligiblePrior.transaction_ref,
                },
                documentType: eligiblePrior.document_type,
                documentNumber: eligiblePrior.document_number,
                issuer: eligiblePrior.issuer,
                relianceReason: 'prior_id_reviewed_still_valid',
                imageApproved: false,
              }
            } else {
              initial[p.id] = emptyVerification()
            }
          }
        })
        setVerificationData(initial)
      } finally {
        setLoading(false)
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentPerson = people[currentPersonIndex]
  const currentData = currentPerson
    ? verificationData[currentPerson.id] ?? emptyVerification()
    : emptyVerification()

  const isRelianceMode = currentData.verificationMethod === 'Relied on prior identification'

  const enrichedPriorsMap = useMemo(() => {
    const p = policy
    const result = {}
    for (const [id, records] of Object.entries(priorVerificationsMap)) {
      result[id] = records.map((r) => ({ ...r, eligibility: evaluateReliance(r, p) }))
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priorVerificationsMap, policy.maxRelianceDays, policy.blockOnExpired])

  const peopleWithPriorRecords = useMemo(
    () => new Set(
      Object.entries(enrichedPriorsMap)
        .filter(([, records]) => records.length > 0)
        .map(([id]) => id),
    ),
    [enrichedPriorsMap],
  )

  const currentPriors = currentPerson ? (enrichedPriorsMap[currentPerson.id] ?? []) : []
  const selectedPrior = currentData.priorVerificationId
    ? currentPriors.find((r) => r.id === currentData.priorVerificationId) ?? null
    : null
  const selectedEligibility = selectedPrior?.eligibility ?? null
  const availableReasons = selectedEligibility === 'blocked'
    ? RELIANCE_REASONS.filter((r) => r.value === 'manager_approved')
    : RELIANCE_REASONS

  const updateCurrentData = (updates) => {
    if (!currentPerson) return
    setVerificationData((prev) => ({
      ...prev,
      [currentPerson.id]: { ...(prev[currentPerson.id] ?? emptyVerification()), ...updates },
    }))
    setHasUnsavedChanges(true)
    setContinueError('')
  }

  const handleMethodChange = (method) => {
    const wasReliance = currentData.verificationMethod === 'Relied on prior identification'
    const nowReliance = method === 'Relied on prior identification'

    if (nowReliance && !wasReliance) {
      stopCamera()
      setPendingFrontCapture(null)
      setPendingBackCapture(null)
      updateCurrentData({
        verificationMethod: method,
        frontImageId: null,
        frontImageBlob: null,
        backImageId: null,
        backImageBlob: null,
      })
    } else if (!nowReliance && wasReliance) {
      updateCurrentData({
        verificationMethod: method,
        priorVerificationId: null,
        priorVerificationSummary: null,
        relianceReason: null,
      })
    } else {
      updateCurrentData({ verificationMethod: method })
    }
  }

  const switchToIndex = (index) => {
    setCurrentPersonIndex(index)
    setPendingFrontCapture(null)
    setPendingBackCapture(null)
    setErrors({})
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        setCameraError('')
      }
    } catch {
      setCameraError('Camera access is required to capture ID images. Enable camera access and try again.')
    }
  }

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop())
      videoRef.current.srcObject = null
    }
    setCapturingFor(null)
  }

  const captureImage = () => {
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
    const imageData = canvas.toDataURL('image/jpeg', 0.8)
    if (capturingFor === 'front') setPendingFrontCapture(imageData)
    else if (capturingFor === 'back') setPendingBackCapture(imageData)
    stopCamera()
  }

  const beginCapture = (side) => {
    setCapturingFor(side)
    startCamera()
  }

  const acceptFrontImage = () => {
    if (!pendingFrontCapture) return
    updateCurrentData({ frontImageBlob: pendingFrontCapture, frontImageId: null })
    setPendingFrontCapture(null)
  }

  const acceptBackImage = () => {
    if (!pendingBackCapture) return
    updateCurrentData({ backImageBlob: pendingBackCapture, backImageId: null })
    setPendingBackCapture(null)
  }

  const retakeFront = () => {
    setPendingFrontCapture(null)
    updateCurrentData({ frontImageId: null, frontImageBlob: null })
    setCapturingFor('front')
    startCamera()
  }

  const retakeBack = () => {
    setPendingBackCapture(null)
    updateCurrentData({ backImageId: null, backImageBlob: null })
    setCapturingFor('back')
    startCamera()
  }

  const validateCurrentPerson = () => {
    const e = {}
    const reliance = currentData.verificationMethod === 'Relied on prior identification'

    if (!currentData.verificationMethod) e.verificationMethod = 'Select how the ID was verified'

    if (!reliance) {
      if (!currentData.documentType) e.documentType = 'Select the document or data-source type'
      if (currentData.documentType === 'Other' && !currentData.documentTypeOther.trim())
        e.documentTypeOther = 'Describe the document or data source'
    }

    if (!currentData.documentNumber.trim()) e.documentNumber = 'Enter the document or reference number'
    if (!reliance && currentData.hasExpiry === 'yes' && !currentData.expiryDate)
      e.expiryDate = 'Enter the expiry date'

    if (reliance) {
      if (!currentData.relianceReason) e.relianceReason = 'Select a reason for reliance'
      if (!currentData.priorVerificationId)
        e.priorVerificationId = 'Select a prior verification record to rely on'
      const prior = currentPriors.find((r) => r.id === currentData.priorVerificationId)
      if (prior?.front_image_id && !currentData.imageApproved)
        e.imageApproval = 'Confirm the ID images match the person present'
    } else {
      if (!currentData.frontImageId && !currentData.frontImageBlob) e.frontImage = 'Capture and accept the front of the ID'
      if (BACK_REQUIRED_TYPES.has(currentData.documentType) && !currentData.backImageId && !currentData.backImageBlob)
        e.backImage = 'Capture and accept the back of the ID'
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  const saveCurrentPerson = () => {
    if (!validateCurrentPerson()) return false
    setVerificationData((prev) => ({
      ...prev,
      [currentPerson.id]: {
        ...(prev[currentPerson.id] ?? emptyVerification()),
        ...currentData,
        verificationDescription: generateVerificationDescription(currentData),
        isComplete: true,
      },
    }))
    setHasUnsavedChanges(false)
    return true
  }

  const handleSwitchPerson = (index) => {
    if (index === currentPersonIndex) return
    if (hasUnsavedChanges) {
      setPendingPersonIndex(index)
      setShowSwitchModal(true)
    } else {
      switchToIndex(index)
    }
  }

  const confirmDiscard = () => {
    switchToIndex(pendingPersonIndex)
    setPendingPersonIndex(null)
    setShowSwitchModal(false)
    setHasUnsavedChanges(false)
  }

  const confirmSaveAndSwitch = () => {
    if (saveCurrentPerson()) {
      switchToIndex(pendingPersonIndex)
      setPendingPersonIndex(null)
    }
    setShowSwitchModal(false)
  }

  const handleSaveAndNext = () => {
    if (saveCurrentPerson()) {
      switchToIndex(currentPersonIndex + 1)
    }
  }

  const handleContinue = async () => {
    if (people.length === 0) {
      navigate('/recipient-delivery')
      return
    }
    if (!saveCurrentPerson()) return
    let updated = {
      ...verificationData,
      [currentPerson.id]: {
        ...(verificationData[currentPerson.id] ?? emptyVerification()),
        ...currentData,
        verificationDescription: generateVerificationDescription(currentData),
        isComplete: true,
      },
    }
    const allComplete = people.every((p) => updated[p.id]?.isComplete)
    if (!allComplete) {
      setContinueError('Complete ID verification for all people before continuing.')
      return
    }
    setSaving(true)
    try {
      const transactionId = getTransactionId()
      for (const person of people) {
        const data = updated[person.id]
        if (!data) continue
        const personType = person.role === 'party' ? 'party' : 'conducting-person'
        const personId = person.role === 'party' ? person.id.replace('party-', '') : person.cpDbId
        if (data.frontImageBlob && !data.frontImageId) {
          const result = await uploadIdImage({ transactionId, personType, personId, side: 'front', blob: base64ToBlob(data.frontImageBlob) })
          updated = { ...updated, [person.id]: { ...updated[person.id], frontImageId: result.id } }
        }
        if (data.backImageBlob && !data.backImageId) {
          const result = await uploadIdImage({ transactionId, personType, personId, side: 'back', blob: base64ToBlob(data.backImageBlob) })
          updated = { ...updated, [person.id]: { ...updated[person.id], backImageId: result.id } }
        }
      }
      await saveIdVerifications(updated)
      navigate('/recipient-delivery')
    } catch (err) {
      setContinueError(err.message || 'Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const getCompletionStatus = (person) => {
    const data = verificationData[person.id]
    if (!data) return 'not-started'
    if (data.isComplete) return 'complete'
    const hasAny =
      data.verificationMethod || data.documentType || data.frontImageId || data.backImageId || data.priorVerificationId
    return hasAny ? 'in-progress' : 'not-started'
  }

  if (loading) return null

  return (
    <WizardFrame
      title="ID Verification Details & Capture"
      subtitle="Record ID verification details and store front/back ID images for each relevant person."
      helperText="Step 5"
      onBack={() => navigate('/conducting-person')}
      onExit={() => setShowExitModal(true)}
      wide
    >
      <div className={styles.layout}>
        {/* Left: person navigator */}
        <div className={styles.personList}>
          <p className={styles.panelHeading}>People ({people.length})</p>
          <div className={styles.personCards}>
            {people.map((person, index) => {
              const status = getCompletionStatus(person)
              const isActive = index === currentPersonIndex
              const hasPriorRecord = peopleWithPriorRecords.has(person.id)
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => handleSwitchPerson(index)}
                  className={[styles.personCard, isActive ? styles.personCardActive : ''].filter(Boolean).join(' ')}
                >
                  <div className={styles.personCardInner}>
                    <User className={styles.personIcon} aria-hidden="true" size={20} />
                    <div className={styles.personMeta}>
                      <p className={styles.personName}>{person.displayName}</p>
                      <p className={styles.personRole}>
                        {person.role === 'party' ? 'Customer / Party' : 'Conducting Person'}
                      </p>
                      <div className={styles.statusRow}>
                        {status === 'complete' && (
                          <>
                            <CheckCircle2 size={14} className={styles.statusComplete} aria-hidden="true" />
                            <span className={styles.statusComplete}>Complete</span>
                          </>
                        )}
                        {status === 'in-progress' && (
                          <>
                            <AlertCircle size={14} className={styles.statusInProgress} aria-hidden="true" />
                            <span className={styles.statusInProgress}>In progress</span>
                          </>
                        )}
                        {status === 'not-started' && (
                          <>
                            <Circle size={14} className={styles.statusNotStarted} aria-hidden="true" />
                            <span className={styles.statusNotStarted}>Not started</span>
                          </>
                        )}
                      </div>
                      {hasPriorRecord && status !== 'complete' && (
                        <p className={styles.priorRecordHint}>Prior record available</p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Right: form panel */}
        {people.length === 0 ? (
          <div className={styles.formPanel}>
            <p>No individual identification is required for this transaction.</p>
            <div className={styles.footerActions}>
              <div>
                <Button onClick={handleContinue} disabled={saving}>
                  {saving ? 'Saving…' : 'Continue'}
                </Button>
              </div>
            </div>
          </div>
        ) : currentPerson && (
          <div className={styles.formPanel}>
            {/* Summary */}
            <div className={styles.summaryCard}>
              <p className={styles.summaryLabel}>Capturing ID for</p>
              <div className={styles.summaryRow}>
                <span className={styles.summaryName}>{currentPerson.displayName}</span>
                <span className={styles.summaryRole}>
                  {currentPerson.role === 'party' ? 'Customer / Party' : 'Conducting Person'}
                </span>
              </div>
            </div>

            {/* Verification details */}
            <div className={styles.formSection}>
              <h2 className={styles.sectionTitle}>Verification details</h2>

              <FormField
                label="Verification method"
                labelFor="verificationMethod"
                error={errors.verificationMethod}
                required
              >
                <select
                  id="verificationMethod"
                  value={currentData.verificationMethod}
                  onChange={(e) => handleMethodChange(e.target.value)}
                  className={styles.select}
                >
                  <option value="">Select method…</option>
                  {VERIFICATION_METHODS
                    .filter((m) => m !== 'Relied on prior identification' || currentPriors.length > 0)
                    .map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </FormField>

              {currentData.verificationMethod === 'Electronic data source' && (
                <FormField
                  label="Electronic data source"
                  labelFor="elecDataSrc"
                  helperText="Name the electronic source used, e.g. ABR, Australian Electoral Roll, World-Check, Equifax."
                >
                  <input
                    id="elecDataSrc"
                    type="text"
                    value={currentData.elecDataSrc}
                    onChange={(e) => updateCurrentData({ elecDataSrc: e.target.value })}
                    className={styles.input}
                    placeholder="Enter electronic data source name"
                  />
                </FormField>
              )}

              {!isRelianceMode && (
                <>
                  <FormField
                    label="Document or data-source type"
                    labelFor="documentType"
                    error={errors.documentType}
                    required
                  >
                    <select
                      id="documentType"
                      value={currentData.documentType}
                      onChange={(e) => updateCurrentData({ documentType: e.target.value })}
                      className={styles.select}
                    >
                      <option value="">Select type…</option>
                      {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </FormField>

                  {currentData.documentType === 'Other' && (
                    <FormField
                      label="Describe document or data source"
                      labelFor="documentTypeOther"
                      error={errors.documentTypeOther}
                      required
                    >
                      <input
                        id="documentTypeOther"
                        type="text"
                        value={currentData.documentTypeOther}
                        onChange={(e) => updateCurrentData({ documentTypeOther: e.target.value })}
                        className={styles.input}
                      />
                    </FormField>
                  )}
                </>
              )}

              <FormField
                label="Document or reference number"
                labelFor="documentNumber"
                error={errors.documentNumber}
                required
              >
                <input
                  id="documentNumber"
                  type="text"
                  value={currentData.documentNumber}
                  onChange={(e) => updateCurrentData({ documentNumber: e.target.value })}
                  onBlur={(e) => updateCurrentData({ documentNumber: e.target.value.trim() })}
                  className={styles.input}
                />
              </FormField>

              <FormField label="Issuer" labelFor="issuer">
                <input
                  id="issuer"
                  type="text"
                  value={currentData.issuer}
                  onChange={(e) => updateCurrentData({ issuer: e.target.value })}
                  placeholder="e.g. VicRoads, Australian Passport Office"
                  className={styles.input}
                />
              </FormField>

              {!isRelianceMode && (
                <FormField
                  label="Country of issue"
                  labelFor="idCountryCode"
                  helperText="ISO 2-letter country code, e.g. AU"
                >
                  <input
                    id="idCountryCode"
                    type="text"
                    value={currentData.idCountryCode}
                    onChange={(e) => updateCurrentData({ idCountryCode: e.target.value.toUpperCase().slice(0, 2) })}
                    className={styles.input}
                    placeholder="AU"
                    maxLength={2}
                  />
                </FormField>
              )}

              {!isRelianceMode && (
                <>
                  <FormField label="Is there an expiry date?">
                    <div className={styles.radioGroup}>
                      <label className={styles.radioLabel}>
                        <input
                          type="radio"
                          name={`hasExpiry-${currentPerson.id}`}
                          checked={currentData.hasExpiry === 'yes'}
                          onChange={() => updateCurrentData({ hasExpiry: 'yes' })}
                        />
                        Yes
                      </label>
                      <label className={styles.radioLabel}>
                        <input
                          type="radio"
                          name={`hasExpiry-${currentPerson.id}`}
                          checked={currentData.hasExpiry === 'no'}
                          onChange={() => updateCurrentData({ hasExpiry: 'no', expiryDate: '' })}
                        />
                        No
                      </label>
                    </div>
                  </FormField>

                  {currentData.hasExpiry === 'yes' && (
                    <FormField label="Expiry date" labelFor="expiryDate" error={errors.expiryDate} required>
                      <DatePicker
                        id="expiryDate"
                        value={currentData.expiryDate}
                        onChange={(date) => updateCurrentData({ expiryDate: date })}
                      />
                    </FormField>
                  )}
                </>
              )}

              {currentData.verificationMethod && (
                <FormField label="Verification description">
                  <p className={styles.inferredValue}>
                    {generateVerificationDescription(currentData)}
                  </p>
                </FormField>
              )}

            </div>

            {/* Prior verification picker — only in reliance mode */}
            {isRelianceMode && (
              <div className={styles.formSection}>
                <h2 className={styles.sectionTitle}>Prior verification record</h2>

                <div className={styles.relianceInfo}>
                  <AlertCircle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    Ensure reliance on prior identification is permitted under your AML/CTF program before
                    proceeding. Document the reason in the verification description above.
                  </span>
                </div>

                <FormField label="Reason for reliance" labelFor="relianceReason" error={errors.relianceReason} required>
                  <select
                    id="relianceReason"
                    className={styles.select}
                    value={currentData.relianceReason ?? ''}
                    onChange={(e) => updateCurrentData({ relianceReason: e.target.value || null })}
                  >
                    <option value="">Select a reason…</option>
                    {availableReasons.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </FormField>

                {selectedEligibility === 'blocked' && (
                  <div className={styles.relianceInfo}>
                    <AlertCircle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      Manager approval is required —{' '}
                      {selectedPrior?.has_expiry && selectedPrior.expiry_date && new Date(selectedPrior.expiry_date) < new Date()
                        ? 'this document has expired.'
                        : `this record was verified more than ${policy.maxRelianceDays} days ago.`}
                    </span>
                  </div>
                )}

                {currentData.priorVerificationSummary ? (
                  <>
                    <div className={styles.priorVerificationCard}>
                      <div className={styles.priorVerificationMeta}>
                        <p className={styles.priorVerificationTitle}>
                          {currentData.priorVerificationSummary.documentType} ·{' '}
                          {currentData.priorVerificationSummary.documentNumber}
                        </p>
                        <p className={styles.priorVerificationDetail}>
                          Verified {currentData.priorVerificationSummary.verifiedDate} by{' '}
                          {currentData.priorVerificationSummary.verifiedBy}
                        </p>
                        <p className={styles.priorVerificationDetail}>
                          Transaction: {currentData.priorVerificationSummary.transactionRef}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          updateCurrentData({ priorVerificationId: null, priorVerificationSummary: null, imageApproved: false })
                        }
                      >
                        Change
                      </Button>
                    </div>

                    {(imageUrlMap[selectedPrior?.front_image_id] || imageUrlMap[selectedPrior?.back_image_id]) && (
                      <div className={styles.priorPickerImages}>
                        {imageUrlMap[selectedPrior?.front_image_id] && (
                          <img src={imageUrlMap[selectedPrior.front_image_id]} alt="Front of ID" className={styles.priorPickerThumbnail} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(imageUrlMap[selectedPrior.front_image_id])} />
                        )}
                        {imageUrlMap[selectedPrior?.back_image_id] && (
                          <img src={imageUrlMap[selectedPrior.back_image_id]} alt="Back of ID" className={styles.priorPickerThumbnail} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(imageUrlMap[selectedPrior.back_image_id])} />
                        )}
                      </div>
                    )}

                    {selectedPrior?.front_image_id && (
                      <label className={styles.priorImageApproval}>
                        <input
                          type="checkbox"
                          checked={!!currentData.imageApproved}
                          onChange={(e) => updateCurrentData({ imageApproved: e.target.checked })}
                        />
                        I confirm the person presenting today matches these ID images
                      </label>
                    )}
                    {errors.imageApproval && (
                      <p className={styles.fieldError}>{errors.imageApproval}</p>
                    )}
                  </>
                ) : (
                  <PriorVerificationPicker
                    records={currentPriors}
                    loading={loading}
                    imageUrlMap={imageUrlMap}
                    onImageClick={setLightboxUrl}
                    onSelect={(record) =>
                      updateCurrentData({
                        priorVerificationId: record.id,
                        priorVerificationSummary: {
                          documentType: record.document_type,
                          documentNumber: record.document_number,
                          verifiedDate: new Date(record.created_at).toLocaleDateString('en-AU'),
                          verifiedBy: record.verified_by_name,
                          transactionRef: record.transaction_ref,
                        },
                        documentType: record.document_type,
                        documentNumber: record.document_number,
                        issuer: record.issuer,
                        imageApproved: false,
                      })
                    }
                  />
                )}

                {errors.priorVerificationId && (
                  <p className={styles.fieldError}>{errors.priorVerificationId}</p>
                )}
              </div>
            )}

            {/* Front ID capture — hidden in reliance mode */}
            {!isRelianceMode && (
              <div className={styles.formSection}>
                <h2 className={styles.sectionTitle}>Capture front of ID</h2>

                {!pendingFrontCapture && !currentData.frontImageId && capturingFor !== 'front' && (
                  <div>
                    <Button onClick={() => beginCapture('front')}>
                      <Camera size={16} aria-hidden="true" />
                      Start camera for front
                    </Button>
                    {errors.frontImage && <p className={styles.fieldError}>{errors.frontImage}</p>}
                  </div>
                )}

                {capturingFor === 'front' && (
                  <div className={styles.cameraSection}>
                    {cameraError ? (
                      <p className={styles.cameraError}>{cameraError}</p>
                    ) : (
                      <>
                        <div className={styles.cameraOuter}>
                          <video ref={videoRef} autoPlay playsInline className={styles.cameraVideo} />
                          <div className={styles.cameraGuide} aria-hidden="true">
                            <div className={styles.cameraGuideFrame} />
                          </div>
                        </div>
                        <p className={styles.cameraHint}>Place the front of the ID inside the frame.</p>
                        <div className={styles.cameraActions}>
                          <Button onClick={captureImage}>Capture front</Button>
                          <Button variant="secondary" onClick={stopCamera}>Cancel</Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {pendingFrontCapture && (
                  <div className={styles.previewSection}>
                    <img src={pendingFrontCapture} alt="Front of ID preview" className={styles.imagePreview} />
                    <div className={styles.previewActions}>
                      <Button onClick={acceptFrontImage}>Accept front image</Button>
                      <Button variant="secondary" onClick={retakeFront}>Retake</Button>
                    </div>
                  </div>
                )}

                {(currentData.frontImageId || currentData.frontImageBlob) && !pendingFrontCapture && (
                  <div className={styles.previewSection}>
                    {currentData.frontImageBlob ? (
                      <img src={currentData.frontImageBlob} alt="Front of ID accepted" className={styles.imagePreview} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(currentData.frontImageBlob)} />
                    ) : imageUrlMap[currentData.frontImageId] ? (
                      <img src={imageUrlMap[currentData.frontImageId]} alt="Front of ID accepted" className={styles.imagePreview} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(imageUrlMap[currentData.frontImageId])} />
                    ) : (
                      <div className={styles.imageOnFile}>Front image on file</div>
                    )}
                    <div className={styles.successBanner}>
                      <CheckCircle2 size={18} aria-hidden="true" />
                      <span>Front image accepted</span>
                    </div>
                    <Button variant="secondary" onClick={retakeFront}>Retake front</Button>
                  </div>
                )}
              </div>
            )}

            {/* Back ID capture — hidden in reliance mode */}
            {!isRelianceMode && (
              <div className={styles.formSection}>
                <h2 className={styles.sectionTitle}>
                  Capture back of ID
                  {!BACK_REQUIRED_TYPES.has(currentData.documentType) && (
                    <span className={styles.optionalLabel}> (optional)</span>
                  )}
                </h2>

                {!pendingBackCapture && !currentData.backImageId && capturingFor !== 'back' && (
                  <div>
                    <Button onClick={() => beginCapture('back')}>
                      <Camera size={16} aria-hidden="true" />
                      Start camera for back
                    </Button>
                    {errors.backImage && <p className={styles.fieldError}>{errors.backImage}</p>}
                  </div>
                )}

                {capturingFor === 'back' && (
                  <div className={styles.cameraSection}>
                    {cameraError ? (
                      <p className={styles.cameraError}>{cameraError}</p>
                    ) : (
                      <>
                        <div className={styles.cameraOuter}>
                          <video ref={videoRef} autoPlay playsInline className={styles.cameraVideo} />
                          <div className={styles.cameraGuide} aria-hidden="true">
                            <div className={styles.cameraGuideFrame} />
                          </div>
                        </div>
                        <p className={styles.cameraHint}>Place the back of the ID inside the frame.</p>
                        <div className={styles.cameraActions}>
                          <Button onClick={captureImage}>Capture back</Button>
                          <Button variant="secondary" onClick={stopCamera}>Cancel</Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {pendingBackCapture && (
                  <div className={styles.previewSection}>
                    <img src={pendingBackCapture} alt="Back of ID preview" className={styles.imagePreview} />
                    <div className={styles.previewActions}>
                      <Button onClick={acceptBackImage}>Accept back image</Button>
                      <Button variant="secondary" onClick={retakeBack}>Retake</Button>
                    </div>
                  </div>
                )}

                {(currentData.backImageId || currentData.backImageBlob) && !pendingBackCapture && (
                  <div className={styles.previewSection}>
                    {currentData.backImageBlob ? (
                      <img src={currentData.backImageBlob} alt="Back of ID accepted" className={styles.imagePreview} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(currentData.backImageBlob)} />
                    ) : imageUrlMap[currentData.backImageId] ? (
                      <img src={imageUrlMap[currentData.backImageId]} alt="Back of ID accepted" className={styles.imagePreview} style={{ cursor: 'pointer' }} onClick={() => setLightboxUrl(imageUrlMap[currentData.backImageId])} />
                    ) : (
                      <div className={styles.imageOnFile}>Back image on file</div>
                    )}
                    <div className={styles.successBanner}>
                      <CheckCircle2 size={18} aria-hidden="true" />
                      <span>Back image accepted</span>
                    </div>
                    <Button variant="secondary" onClick={retakeBack}>Retake back</Button>
                  </div>
                )}
              </div>
            )}

            {/* Completion summary */}
            {currentData.isComplete && (
              <div className={styles.completionBanner}>
                <CheckCircle2 size={18} aria-hidden="true" />
                <div>
                  <p className={styles.completionTitle}>ID verification complete</p>
                  <ul className={styles.completionList}>
                    <li>Verification method completed</li>
                    <li>Document number completed</li>
                    <li>Verification material description completed</li>
                    {currentData.verificationMethod === 'Relied on prior identification' ? (
                      <li>Prior verification record referenced</li>
                    ) : (
                      <>
                        <li>Document type completed</li>
                        <li>Front image accepted</li>
                        {currentData.backImageId && <li>Back image accepted</li>}
                      </>
                    )}
                  </ul>
                </div>
              </div>
            )}

            {/* Footer actions */}
            {continueError && <p className={styles.continueError}>{continueError}</p>}
            <div className={styles.footerActions}>
              <Button variant="secondary" onClick={() => saveCurrentPerson()}>Save</Button>
              <div>
                {currentPersonIndex < people.length - 1 ? (
                  <Button onClick={handleSaveAndNext}>Save and next person</Button>
                ) : (
                  <Button onClick={handleContinue} disabled={saving}>
                    {saving ? 'Saving…' : 'Continue'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Person-switch modal */}
      {showSwitchModal && (
        <div className={styles.overlay}>
          <div role="dialog" aria-labelledby="switch-modal-title" aria-modal="true" className={styles.modal}>
            <h3 id="switch-modal-title" className={styles.modalTitle}>Unsaved changes</h3>
            <p className={styles.modalBody}>
              You have unsaved changes for this person. What would you like to do?
            </p>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setShowSwitchModal(false)}>Cancel</Button>
              <Button variant="secondary" onClick={confirmDiscard}>Discard and switch</Button>
              <Button onClick={confirmSaveAndSwitch}>Save and switch</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={showExitModal}
        onCancel={() => setShowExitModal(false)}
        onConfirm={async () => { await deleteTransaction(); navigate('/start') }}
      />

      <canvas ref={canvasRef} className={styles.hiddenCanvas} />

      {lightboxUrl && (
        <div className={styles.lightboxOverlay} onClick={() => setLightboxUrl(null)}>
          <img
            src={lightboxUrl}
            alt="ID document enlarged"
            className={styles.lightboxImage}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </WizardFrame>
  )
}

export default IdVerificationPage
