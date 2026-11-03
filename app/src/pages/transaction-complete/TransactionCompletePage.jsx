import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import Button from "../../components/ui/Button.jsx";
import WizardFrame from "../../components/layout/WizardFrame.jsx";
import { findWaitingReport } from "../../lib/wizardApi.js";
import { openTtrPath } from "../../lib/ttrRoutes.js";
import styles from "./TransactionCompletePage.module.css";

const TransactionCompletePage = () => {
    const navigate = useNavigate();
    const { state } = useLocation();
    const [fallbackNow] = useState(() => Date.now());

    // A mixed gold invoice has two reports on one reference (spec 3.4): offer the one still waiting.
    const [waiting, setWaiting] = useState(null);

    useEffect(() => {
        if (!state?.transactionRef) navigate("/start", { replace: true });
    }, [state, navigate]);

    useEffect(() => {
        if (!state?.transactionRef) return;
        let cancelled = false;
        findWaitingReport(state.transactionRef).then((other) => {
            if (!cancelled) setWaiting(other);
        });
        return () => {
            cancelled = true;
        };
    }, [state?.transactionRef]);

    if (!state?.transactionRef) return null;

    const { transactionRef, completedAt } = state;
    const formattedDate = new Date(completedAt ?? fallbackNow).toLocaleString("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    return (
        <WizardFrame
            title="Transaction Complete"
            subtitle="The transaction report has been successfully submitted."
            actions={<Button onClick={() => navigate("/start")}>Start New Transaction</Button>}
        >
            <div className={styles.card}>
                <div className={styles.iconWrap}>
                    <CheckCircle2 size={48} className={styles.icon} aria-hidden="true" />
                </div>
                <h2 className={styles.heading}>Report submitted</h2>
                <dl className={styles.details}>
                    <div className={styles.row}>
                        <dt>Transaction reference</dt>
                        <dd>{transactionRef}</dd>
                    </div>
                    <div className={styles.row}>
                        <dt>Completed at</dt>
                        <dd>{formattedDate}</dd>
                    </div>
                </dl>
            </div>
            {waiting && (
                <p className={styles.waiting}>
                    Another AUSTRAC report for {transactionRef} is waiting
                    <Button onClick={() => navigate(openTtrPath(waiting.id))}>Open it</Button>
                </p>
            )}
        </WizardFrame>
    );
};

export default TransactionCompletePage;
