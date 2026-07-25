import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [staffMember, setStaffMember] = useState(null)
  const [aal, setAal] = useState({ currentLevel: null, nextLevel: null })
  const [loading, setLoading] = useState(true)

  async function fetchStaffMember(userId) {
    const { data } = await supabase
      .from('staff_members')
      .select('id, full_name, email, reporting_entity_id, role, job_title, reporting_entities(legal_name, trading_name, abn, acn, address_street, address_suburb, address_state, address_postcode, address_country, austrac_account_number, idv_max_reliance_days, idv_block_on_expired)')
      .eq('id', userId)
      .single()
    setStaffMember(data ?? null)
  }

  async function refreshAal() {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    setAal({ currentLevel: data?.currentLevel ?? null, nextLevel: data?.nextLevel ?? null })
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) Promise.all([fetchStaffMember(session.user.id), refreshAal()]).finally(() => setLoading(false))
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) {
        Promise.all([fetchStaffMember(session.user.id), refreshAal()]).finally(() => setLoading(false))
      } else {
        setStaffMember(null)
        setAal({ currentLevel: null, nextLevel: null })
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signOut() {
    sessionStorage.removeItem('ttr.transactionId')
    await supabase.auth.signOut()
  }

  const reportingEntity = staffMember?.reporting_entities ?? null
  const canApproveReports = staffMember?.role === 'admin'

  return (
    <AuthContext.Provider value={{ session, staffMember, aal, refreshAal, reportingEntity, canApproveReports, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- context + hook live together by convention
export function useAuth() {
  return useContext(AuthContext)
}
