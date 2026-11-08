import { LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { countIncompleteTransactions } from "../../lib/goldApi.js";
import { GOLD_ROUTES, GoldDraftProvider } from "./shared/index.js";
import styles from "./GoldLayout.module.css";

// The gold shell: header, then the routed screen. GoldDraftProvider lives here, so unsaved purchase drafts
// go when staff switch journey or sign out. "To complete (n)" counts the purchases on that screen; it is counted
// again on every screen change, and when a screen calls refreshToComplete() from the outlet context.
const GoldLayout = () => {
    const { staffMember, signOut } = useAuth();
    const { pathname } = useLocation();
    const [toCompleteCount, setToCompleteCount] = useState(null);
    const [refreshCount, setRefreshCount] = useState(0);
    const refreshToComplete = useCallback(() => setRefreshCount((count) => count + 1), []);

    useEffect(() => {
        let isCancelled = false;
        countIncompleteTransactions()
            .then((count) => !isCancelled && setToCompleteCount(count))
            .catch(() => {});
        return () => {
            isCancelled = true;
        };
    }, [pathname, refreshCount]);

    return (
        <GoldDraftProvider>
            <header className={styles.header}>
                <Link className={styles.brand} to={GOLD_ROUTES.search}>
                    Gold due diligence
                </Link>
                <nav className={styles.nav} aria-label="Gold">
                    <Link className={styles.link} to={GOLD_ROUTES.toComplete}>
                        To complete{toCompleteCount === null ? "" : ` (${toCompleteCount})`}
                    </Link>
                    <Link className={styles.link} to={GOLD_ROUTES.purchases}>
                        Purchases
                    </Link>
                    <span className={styles.user}>{staffMember?.full_name ?? ""}</span>
                    <Link className={styles.link} to="/">
                        Switch journey
                    </Link>
                    <button className={styles.signOut} type="button" onClick={signOut}>
                        <LogOut aria-hidden="true" size={15} />
                        Sign out
                    </button>
                </nav>
            </header>
            <main className={styles.main}>
                <Outlet context={{ refreshToComplete }} />
            </main>
        </GoldDraftProvider>
    );
};

export default GoldLayout;
