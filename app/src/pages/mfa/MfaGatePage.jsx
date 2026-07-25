import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { supabase } from '../../lib/supabase.js'
import styles from './MfaGatePage.module.css'

// Shown as the account issuer in the staff member's authenticator app. Set
// explicitly — Supabase otherwise derives it from the site URL host ("localhost"
// in development). Changing this only affects enrollments made after the change.
const MFA_ISSUER = 'Compliance Capture Platform'

const MfaGatePage = () => {
  const { session, loading, refreshAal } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirectTo = searchParams.get('redirect') || '/start'

  const [checking, setChecking] = useState(true)
  const [mode, setMode] = useState(null)
  const [factorId, setFactorId] = useState(null)
  const [qrCode, setQrCode] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!session) return
    let cancelled = false

    async function init() {
      const { data, error: listError } = await supabase.auth.mfa.listFactors()
      if (cancelled) return
      if (listError) {
        setError('Could not load your security settings. Please try signing in again.')
        setChecking(false)
        return
      }

      const verifiedTotp = data.totp.find((f) => f.status === 'verified')
      if (verifiedTotp) {
        setMode('challenge')
        setFactorId(verifiedTotp.id)
        setChecking(false)
        return
      }

      const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: MFA_ISSUER,
      })
      if (cancelled) return
      if (enrollError) {
        setError('Could not start MFA enrollment. Please try signing in again.')
        setChecking(false)
        return
      }

      setMode('enroll')
      setFactorId(enrollData.id)
      setQrCode(enrollData.totp.qr_code)
      setSecret(enrollData.totp.secret)
      setChecking(false)
    }

    init()
    return () => {
      cancelled = true
    }
  }, [session])

  if (loading) return null
  if (!session) return <Navigate to="/login" replace />

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    if (mode === 'enroll') {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
      if (challengeError) {
        setError('Could not verify that code. Please try again.')
        setSubmitting(false)
        return
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      })
      if (verifyError) {
        setError('Invalid code. Please check your authenticator app and try again.')
        setSubmitting(false)
        return
      }
    } else {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (verifyError) {
        setError('Invalid code. Please try again.')
        setSubmitting(false)
        return
      }
    }

    await refreshAal()
    navigate(redirectTo, { replace: true })
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>{mode === 'enroll' ? 'Set up two-factor authentication' : 'Enter your authentication code'}</h1>
          <p>
            {mode === 'enroll'
              ? 'Scan this QR code with an authenticator app, then enter the 6-digit code it shows.'
              : 'Enter the 6-digit code from your authenticator app to continue.'}
          </p>
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        {checking ? (
          <p className={styles.helper}>Loading…</p>
        ) : (
          <form className={styles.fields} onSubmit={handleSubmit}>
            {mode === 'enroll' && qrCode ? (
              <div className={styles.qrBlock}>
                <img alt="Scan this QR code with your authenticator app" className={styles.qrImage} src={qrCode} />
                <p className={styles.secret}>
                  Can&apos;t scan it? Enter this code manually: <strong>{secret}</strong>
                </p>
              </div>
            ) : null}

            <FormField label="6-digit code" labelFor="mfa-code">
              <TextInput
                autoComplete="one-time-code"
                autoFocus
                id="mfa-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                required
                value={code}
              />
            </FormField>

            <Button disabled={submitting} type="submit">
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

export default MfaGatePage
