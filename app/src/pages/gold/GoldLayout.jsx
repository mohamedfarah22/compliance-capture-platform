import { LogOut } from "lucide-react";
import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { GOLD_ROUTES, GoldDraftProvider } from "./shared/index.js";
import styles from "./GoldLayout.module.css";

// The gold shell: header, then the routed screen. GoldDraftProvider lives here, so unsaved purchase drafts
// go when staff switch journey or sign out.
// TODO(8b): "To complete (n)" and "Purchases" join the header with their screens.
const GoldLayout = () => {
    const { staffMember, signOut } = useAuth();

    return (
        <GoldDraftProvider>
            <header className={styles.header}>
                <Link className={styles.brand} to={GOLD_ROUTES.search}>
                    Gold due diligence
                </Link>
                <nav className={styles.nav} aria-label="Gold">
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
                <Outlet />
            </main>
        </GoldDraftProvider>
    );
};

export default GoldLayout;
