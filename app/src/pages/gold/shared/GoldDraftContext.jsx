import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Unsaved purchase forms, keyed by the main seller's customer ID. In memory only, so no ID data is left on
// the device. It goes when GoldLayout unmounts (Switch journey, sign-out, idle sign-out) and on save.
const INITIAL_STATE = { drafts: {} };

const GoldDraftContext = createContext(null);

export const GoldDraftProvider = ({ children }) => {
    const [state, setState] = useState(INITIAL_STATE);

    const setDraft = useCallback(
        (customerId, patch) =>
            setState((prev) => ({
                ...prev,
                drafts: { ...prev.drafts, [customerId]: { ...prev.drafts[customerId], ...patch } },
            })),
        []
    );
    const clearDraft = useCallback(
        (customerId) =>
            setState((prev) => ({
                ...prev,
                drafts: Object.fromEntries(Object.entries(prev.drafts).filter(([id]) => id !== customerId)),
            })),
        []
    );
    const reset = useCallback(() => setState(INITIAL_STATE), []);

    const value = useMemo(
        () => ({ drafts: state.drafts, setDraft, clearDraft, reset }),
        [state.drafts, setDraft, clearDraft, reset]
    );

    return <GoldDraftContext.Provider value={value}>{children}</GoldDraftContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- context + hook live together by convention
export const useGoldDraft = () => {
    const context = useContext(GoldDraftContext);
    if (!context) throw new Error("useGoldDraft must be used inside GoldDraftProvider");
    return context;
};
