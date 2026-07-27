import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

const ProtectedRoute = ({ children, requiredRole }) => {
  const { session, staffMember, aal, loading, signOut } = useAuth()
  const location = useLocation()
  const redirect = encodeURIComponent(location.pathname + location.search)

  // A session that has not cleared MFA has no business on a protected route.
  // Rather than hand it a shortcut to the code entry, the session is ended and
  // the user re-authenticates from scratch — a half-authenticated session that
  // went looking at protected URLs is not one to keep alive.
  //
  // Gated on !loading because AuthContext sets the session before it has
  // resolved the assurance level; acting during that window would sign everyone
  // out on every page load.
  const abandonPartialSession = !loading && Boolean(session) && aal?.currentLevel !== 'aal2'

  useEffect(() => {
    if (abandonPartialSession) signOut()
  }, [abandonPartialSession, signOut])

  if (loading) return null
  if (!session || abandonPartialSession) {
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }
  if (requiredRole && staffMember?.role !== requiredRole) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>You are not authorised to view this page.</div>
  }
  return children
}

export default ProtectedRoute
