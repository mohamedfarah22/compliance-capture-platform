import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { clearWizardData } from "../components/wizardStorage.js";
import { supabase } from "../lib/supabase.js";

const AuthContext = createContext(null);

// Staff are signed out after this long without a click, key press or touch. The last
// activity time lives in localStorage so every tab of the app shares one clock: working
// in one tab keeps the others signed in.
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVITY_KEY = "ccp.lastActivity";
const ACTIVITY_WRITE_THROTTLE_MS = 5 * 1000;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"];

export function AuthProvider({ children }) {
    const [session, setSession] = useState(null);
    const [staffMember, setStaffMember] = useState(null);
    const [aal, setAal] = useState({ currentLevel: null, nextLevel: null });
    const [loading, setLoading] = useState(true);
    // True after an idle sign-out, so the login page can explain why. Cleared on the next sign-in.
    const [signedOutForIdle, setSignedOutForIdle] = useState(false);

    async function fetchStaffMember(userId) {
        const { data } = await supabase
            .from("staff_members")
            .select(
                "id, full_name, email, reporting_entity_id, role, job_title, reporting_entities(legal_name, trading_name, abn, acn, address_street, address_suburb, address_state, address_postcode, address_country, austrac_account_number, idv_max_reliance_days, idv_block_on_expired)"
            )
            .eq("id", userId)
            .single();
        setStaffMember(data ?? null);
    }

    async function refreshAal() {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        setAal({ currentLevel: data?.currentLevel ?? null, nextLevel: data?.nextLevel ?? null });
    }

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            if (session)
                Promise.all([fetchStaffMember(session.user.id), refreshAal()]).finally(() => setLoading(false));
            else setLoading(false);
        });

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            if (session) {
                setSignedOutForIdle(false);
                Promise.all([fetchStaffMember(session.user.id), refreshAal()]).finally(() => setLoading(false));
            } else {
                // Also covers other tabs and expired sessions, which never call signOut() below.
                clearWizardData();
                localStorage.removeItem(ACTIVITY_KEY);
                setStaffMember(null);
                setAal({ currentLevel: null, nextLevel: null });
                setLoading(false);
            }
        });

        return () => subscription.unsubscribe();
    }, []);

    const signOut = useCallback(async () => {
        // Customer details and ID photos from an unfinished transaction sit in
        // sessionStorage; on a shared counter PC they must not outlive the session.
        clearWizardData();
        sessionStorage.removeItem("ttr.transactionId");
        localStorage.removeItem(ACTIVITY_KEY);
        await supabase.auth.signOut();
    }, []);

    const signedIn = Boolean(session);

    useEffect(() => {
        if (!signedIn) return;

        let lastWrite = 0;
        const markActive = () => {
            lastWrite = Date.now();
            localStorage.setItem(ACTIVITY_KEY, String(lastWrite));
        };

        const checkIdle = () => {
            const lastActivity = Number(localStorage.getItem(ACTIVITY_KEY));
            if (!lastActivity) {
                markActive();
                return;
            }
            if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
                setSignedOutForIdle(true);
                signOut();
            }
        };

        const handleActivity = () => {
            if (Date.now() - lastWrite >= ACTIVITY_WRITE_THROTTLE_MS) markActive();
        };
        const handleVisibility = () => {
            if (document.visibilityState === "visible") checkIdle();
        };
        const handleStorage = (event) => {
            if (event.key === ACTIVITY_KEY) checkIdle();
        };

        // A session restored after the browser was closed has an old timestamp: end it
        // rather than start a fresh 10 minutes.
        checkIdle();
        const timer = setInterval(checkIdle, IDLE_CHECK_INTERVAL_MS);
        ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, handleActivity, true));
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("storage", handleStorage);

        return () => {
            clearInterval(timer);
            ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, handleActivity, true));
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("storage", handleStorage);
        };
    }, [signedIn, signOut]);

    const reportingEntity = staffMember?.reporting_entities ?? null;
    const canApproveReports = staffMember?.role === "admin";

    return (
        <AuthContext.Provider
            value={{
                session,
                staffMember,
                aal,
                refreshAal,
                reportingEntity,
                canApproveReports,
                loading,
                signOut,
                signedOutForIdle,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- context + hook live together by convention
export function useAuth() {
    return useContext(AuthContext);
}
