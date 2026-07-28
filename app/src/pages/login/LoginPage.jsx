import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button.jsx'
import FormField from '../../components/ui/FormField.jsx'
import TextInput from '../../components/ui/TextInput.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { supabase } from '../../lib/supabase.js'
import styles from './LoginPage.module.css'

const LoginPage = () => {
  const { session, loading, aal } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Where the user was heading before being sent here, so they land there rather
  // than on the wizard start once both factors are done.
  const requested = searchParams.get('redirect')
  const afterAuth = requested || '/start'
  // A password on its own only reaches aal1, so the second factor comes next.
  // Sending them to a protected route instead would trip ProtectedRoute's
  // partial-session check and sign them straight back out.
  const mfaStep = `/mfa?redirect=${encodeURIComponent(afterAuth)}`

  if (!loading && session) {
    return <Navigate to={aal?.currentLevel === 'aal2' ? afterAuth : mfaStep} replace />
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError('Invalid email or password.')
      setSubmitting(false)
    } else {
      navigate(mfaStep, { replace: true })
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>Sign in</h1>
          <p>Compliance Capture Platform — authorised staff only.</p>
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        <form className={styles.fields} onSubmit={handleSubmit}>
          <FormField label="Email address" labelFor="email">
            <TextInput
              autoComplete="email"
              id="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
          </FormField>

          <FormField label="Password" labelFor="password">
            <TextInput
              autoComplete="current-password"
              id="password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              type="password"
              value={password}
            />
          </FormField>

          <Button disabled={submitting} type="submit">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}

export default LoginPage
