import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [staffMember, setStaffMember] = useState(null)
  const [loading, setLoading] = useState(true)

  async function fetchStaffMember(userId) {
    const { data } = await supabase
      .from('staff_members')
      .select('id, full_name, email, reporting_entity_id, role, job_title, reporting_entities(legal_name, trading_name, abn, acn, address_street, address_suburb, address_state, address_postcode, address_country, austrac_re_number, idv_max_reliance_days, idv_block_on_expired)')
      .eq('id', userId)
      .single()
    setStaffMember(data ?? null)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchStaffMember(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) {
        fetchStaffMember(session.user.id).finally(() => setLoading(false))
      } else {
        setStaffMember(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // Mark loading done once staffMember resolves after initial session
  useEffect(() => {
    if (session && staffMember !== undefined) setLoading(false)
  }, [session, staffMember])

  async function signOut() {
    sessionStorage.removeItem('ttr.transactionId')
    await supabase.auth.signOut()
  }

  const reportingEntity = staffMember?.reporting_entities ?? null
  const canApproveReports = staffMember?.role === 'admin'

  return (
    <AuthContext.Provider value={{ session, staffMember, reportingEntity, canApproveReports, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
