import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button.jsx";
import WizardFrame from "../../components/layout/WizardFrame.jsx";
import { findOtherActiveDraft, openTransaction } from "../../lib/wizardApi.js";

// Opens a draft TTR by id (spec 3.2): the target of gold's "Start TTR" / "Resume TTR". If a different draft is
// already active in this session it warns first; that draft stays saved and can be reopened from the TTR start page.
const OpenTtrPage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const [otherDraft, setOtherDraft] = useState(null);
    const [error, setError] = useState("");
    const [checked, setChecked] = useState(false);

    const open = async () => {
        setError("");
        try {
            const { path } = await openTransaction(id);
            navigate(path, { replace: true });
        } catch (err) {
            setError(err?.message || "Could not open the AUSTRAC report.");
        }
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const other = await findOtherActiveDraft(id);
                if (cancelled) return;
                if (other) {
                    setOtherDraft(other);
                    setChecked(true);
                } else {
                    setChecked(true);
                    await open();
                }
            } catch (err) {
                if (!cancelled) setError(err?.message || "Could not open the AUSTRAC report.");
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    if (error) {
        return (
            <WizardFrame
                title="AUSTRAC report"
                subtitle={error}
                actions={<Button onClick={() => navigate("/start")}>TTR start</Button>}
            />
        );
    }
    if (otherDraft && checked) {
        return (
            <WizardFrame
                title="Another AUSTRAC report is in progress"
                subtitle={`You have another AUSTRAC report in progress (${otherDraft.transactionRef}). It stays saved; reopen it from the TTR start page.`}
                onExit={() => navigate("/start")}
                exitLabel="Cancel"
                actions={<Button onClick={open}>Open this report</Button>}
            />
        );
    }
    return <WizardFrame title="Opening AUSTRAC report" subtitle="One moment." />;
};

export default OpenTtrPage;
