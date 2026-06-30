import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

const ProtectedRoute = ({ children, requiredRole }) => {
  const { session, staffMember, loading } = useAuth()
  const location = useLocation()

  if (loading) return null
  if (!session) {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }
  if (requiredRole && staffMember?.role !== requiredRole) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>You are not authorised to view this page.</div>
  }
  return children
}

export default ProtectedRoute
