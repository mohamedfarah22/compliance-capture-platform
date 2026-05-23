import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, CheckCircle2, AlertCircle, Circle, Camera } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import ConfirmModal from '../../components/ui/ConfirmModal.jsx'
import DatePicker from '../../components/ui/DatePicker.jsx'
import FormField from '../../components/ui/FormField.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import { wizardStorageKeys, readWizardData, writeWizardData } from '../../components/wizardStorage.js'
import styles from './IdVerificationPage.module.css'

const VERIFICATION_METHODS = [
  'Sighted original document',
  'Sighted certified copy',
  'Electronic data source',
  'Other',
]

const DOCUMENT_TYPES = [
  'Driver licence',
  'Passport',
  'Proof of age card',
  'National identity card',
  'Medicare card',
  'Other government document',
  'Electronic verification source',
  'Other',
]

// Physical card-style documents where a back side is meaningful to capture
const BACK_REQUIRED_TYPES = new Set(['Driver licence'])

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
  frontImage: null,
  backImage: null,
  isComplete: false,
})

const loadPeople = () => {
  const result = []
  const customers = readWizardData(wizardStorageKeys.customers, [])
  customers
    .filter((p) => p.type === 'individual')
    .forEach((p) => result.push({ id: `party-${p.id}`, displayName: p.displayName, role: 'party' }))
  const cp = readWizardData(wizardStorageKeys.conductingPerson, null)
  if (cp?.hasConductingPerson === 'yes' && cp.fullName) {
    result.push({
      id: 'conducting-person',
      displayName: cp.fullName,
      role: 'conducting-person',
      linkedParty: cp.representedPartyId,
    })
  }
  return result
}

const IdVerificationPage = () => {
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)

  // Initialised once from storage — no effects needed
  const [people] = useState(loadPeople)
  const [verificationData, setVerificationData] = useState(() => {
    const saved = readWizardData(wizardStorageKeys.idVerification, null)
    if (saved) return saved
    const initial = {}
    people.forEach((p) => { initial[p.id] = emptyVerification() })
    return initial
  })

  const [currentPersonIndex, setCurrentPersonIndex] = useState(0)
  const [errors, setErrors] = useState({})
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const [showSwitchModal, setShowSwitchModal] = useState(false)
  const [pendingPersonIndex, setPendingPersonIndex] = useState(null)
  const [continueError, setContinueError] = useState('')
  const [showExitModal, setShowExitModal] = useState(false)

  const [cameraError, setCameraError] = useState('')
  const [capturingFor, setCapturingFor] = useState(null)
  // Pending captures: the just-taken photo before the user accepts it.
  // Separate from currentData.frontImage / backImage (the accepted images).
  const [pendingFrontCapture, setPendingFrontCapture] = useState(null)
  const [pendingBackCapture, setPendingBackCapture] = useState(null)

  const currentPerson = people[currentPersonIndex]
  const currentData = currentPerson
    ? verificationData[currentPerson.id] ?? emptyVerification()
    : emptyVerification()

  const updateCurrentData = (updates) => {
    if (!currentPerson) return
    setVerificationData((prev) => ({
      ...prev,
      [currentPerson.id]: { ...(prev[currentPerson.id] ?? emptyVerification()), ...updates },
    }))
    setHasUnsavedChanges(true)
    setContinueError('')
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
    updateCurrentData({ frontImage: pendingFrontCapture })
    setPendingFrontCapture(null)
  }

  const acceptBackImage = () => {
    updateCurrentData({ backImage: pendingBackCapture })
    setPendingBackCapture(null)
  }

  const retakeFront = () => {
    setPendingFrontCapture(null)
    updateCurrentData({ frontImage: null })
    setCapturingFor('front')
    startCamera()
  }

  const retakeBack = () => {
    setPendingBackCapture(null)
    updateCurrentData({ backImage: null })
    setCapturingFor('back')
    startCamera()
  }

  const validateCurrentPerson = () => {
    const e = {}
    if (!currentData.verificationMethod) e.verificationMethod = 'Select how the ID was verified'
    if (currentData.verificationMethod === 'Other' && !currentData.verificationMethodOther.trim())
      e.verificationMethodOther = 'Describe the verification method'
    if (!currentData.documentType) e.documentType = 'Select the document or data-source type'
    if (currentData.documentType === 'Other' && !currentData.documentTypeOther.trim())
      e.documentTypeOther = 'Describe the document or data source'
    if (!currentData.documentNumber.trim()) e.documentNumber = 'Enter the document or reference number'
    if (!currentData.verificationDescription.trim())
      e.verificationDescription = 'Describe the document or data used for verification'
    if (currentData.hasExpiry === 'yes' && !currentData.expiryDate) e.expiryDate = 'Enter the expiry date'
    if (!currentData.frontImage) e.frontImage = 'Capture and accept the front of the ID'
    if (BACK_REQUIRED_TYPES.has(currentData.documentType) && !currentData.backImage)
      e.backImage = 'Capture and accept the back of the ID'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const saveCurrentPerson = () => {
    if (!validateCurrentPerson()) return false
    setVerificationData((prev) => ({
      ...prev,
      [currentPerson.id]: { ...(prev[currentPerson.id] ?? emptyVerification()), ...currentData, isComplete: true },
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

  const handleContinue = () => {
    if (!saveCurrentPerson()) return
    const updated = {
      ...verificationData,
      [currentPerson.id]: { ...(verificationData[currentPerson.id] ?? emptyVerification()), ...currentData, isComplete: true },
    }
    const allComplete = people.every((p) => updated[p.id]?.isComplete)
    if (!allComplete) {
      setContinueError('Complete ID verification for all people before continuing.')
      return
    }
    writeWizardData(wizardStorageKeys.idVerification, updated)
    navigate('/recipient-delivery')
  }

  const getCompletionStatus = (person) => {
    const data = verificationData[person.id]
    if (!data) return 'not-started'
    if (data.isComplete) return 'complete'
    const hasAny = data.verificationMethod || data.documentType || data.frontImage || data.backImage
    return hasAny ? 'in-progress' : 'not-started'
  }

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
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Right: form panel */}
        {currentPerson && (
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
                  onChange={(e) => updateCurrentData({ verificationMethod: e.target.value })}
                  className={styles.select}
                >
                  <option value="">Select method…</option>
                  {VERIFICATION_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </FormField>

              {currentData.verificationMethod === 'Other' && (
                <FormField
                  label="Describe verification method"
                  labelFor="verificationMethodOther"
                  error={errors.verificationMethodOther}
                  required
                >
                  <input
                    id="verificationMethodOther"
                    type="text"
                    value={currentData.verificationMethodOther}
                    onChange={(e) => updateCurrentData({ verificationMethodOther: e.target.value })}
                    className={styles.input}
                  />
                </FormField>
              )}

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

              <FormField
                label="Description of reliable and independent document or data used for verification"
                labelFor="verificationDescription"
                helperText="Examples: Australian driver licence sighted in person, Passport sighted at counter, Electronic verification against approved source"
                error={errors.verificationDescription}
                required
              >
                <textarea
                  id="verificationDescription"
                  value={currentData.verificationDescription}
                  onChange={(e) => updateCurrentData({ verificationDescription: e.target.value })}
                  rows={3}
                  placeholder="Describe the document or data relied on to verify this person."
                  className={styles.textarea}
                />
              </FormField>
            </div>

            {/* Front ID capture */}
            <div className={styles.formSection}>
              <h2 className={styles.sectionTitle}>Capture front of ID</h2>

              {!pendingFrontCapture && !currentData.frontImage && capturingFor !== 'front' && (
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

              {currentData.frontImage && !pendingFrontCapture && (
                <div className={styles.previewSection}>
                  <img src={currentData.frontImage} alt="Front of ID accepted" className={styles.imagePreview} />
                  <div className={styles.successBanner}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>Front image accepted</span>
                  </div>
                  <Button variant="secondary" onClick={retakeFront}>Retake front</Button>
                </div>
              )}
            </div>

            {/* Back ID capture */}
            <div className={styles.formSection}>
              <h2 className={styles.sectionTitle}>
                Capture back of ID
                {!BACK_REQUIRED_TYPES.has(currentData.documentType) && (
                  <span className={styles.optionalLabel}> (optional)</span>
                )}
              </h2>

              {!pendingBackCapture && !currentData.backImage && capturingFor !== 'back' && (
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

              {currentData.backImage && !pendingBackCapture && (
                <div className={styles.previewSection}>
                  <img src={currentData.backImage} alt="Back of ID accepted" className={styles.imagePreview} />
                  <div className={styles.successBanner}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span>Back image accepted</span>
                  </div>
                  <Button variant="secondary" onClick={retakeBack}>Retake back</Button>
                </div>
              )}
            </div>

            {/* Completion summary */}
            {currentData.isComplete && (
              <div className={styles.completionBanner}>
                <CheckCircle2 size={18} aria-hidden="true" />
                <div>
                  <p className={styles.completionTitle}>ID verification complete</p>
                  <ul className={styles.completionList}>
                    <li>Verification method completed</li>
                    <li>Document type completed</li>
                    <li>Document number completed</li>
                    <li>Verification material description completed</li>
                    <li>Front image accepted</li>
                    <li>Back image accepted</li>
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
                  <Button onClick={handleContinue}>Continue</Button>
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
        onConfirm={() => navigate('/')}
      />

      <canvas ref={canvasRef} className={styles.hiddenCanvas} />
    </WizardFrame>
  )
}

export default IdVerificationPage
