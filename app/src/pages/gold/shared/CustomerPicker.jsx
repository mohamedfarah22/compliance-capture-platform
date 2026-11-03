import { useEffect, useRef, useState } from "react";
import Button from "../../../components/ui/Button.jsx";
import TextInput from "../../../components/ui/TextInput.jsx";
import { searchCustomers } from "../../../lib/goldApi.js";
import { formatDate } from "./format.js";
import IdStatusBadge from "./IdStatusBadge.jsx";
import styles from "./CustomerPicker.module.css";

const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

// Search by name, phone or ID number, then pick a customer or start a new one. Used on Find customer and in the
// joint-seller panel. excludeId is a customer who cannot be picked; they show disabled with excludeNote.
const CustomerPicker = ({ onPick, onNew, newLabel = "New customer", excludeId, excludeNote, inputId = "q" }) => {
    const inputRef = useRef(null);
    const [query, setQuery] = useState("");
    // The last finished search. Loading is derived: the term has changed since it finished.
    const [answer, setAnswer] = useState({ term: "", results: [], hasFailed: false });

    const term = query.trim();
    const hasSearched = term.length >= MIN_QUERY_LENGTH;
    const isLoading = hasSearched && answer.term !== term;
    const { results, hasFailed } = answer;

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (term.length < MIN_QUERY_LENGTH) return;
        // A later keystroke cancels this one, so a slow answer can never overwrite a newer one.
        let isCancelled = false;
        const timer = setTimeout(async () => {
            let next;
            try {
                next = { term, results: await searchCustomers(term), hasFailed: false };
            } catch {
                next = { term, results: [], hasFailed: true };
            }
            if (!isCancelled) setAnswer(next);
        }, DEBOUNCE_MS);
        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [term]);

    const handleKeyDown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault(); // never submit a surrounding form
        if (hasSearched && results.length === 1 && results[0].id !== excludeId) onPick(results[0]);
    };

    const renderResults = () => {
        if (isLoading) return <p className={styles.note}>Searching…</p>;
        if (hasFailed) {
            return (
                <p className={styles.errorNote} role="alert">
                    The search failed. Check the connection and try again.
                </p>
            );
        }
        if (results.length === 0) {
            return (
                <p className={styles.note}>
                    No customer matches “{term}”. Check the spelling or create a new customer.
                </p>
            );
        }
        return (
            <ul className={styles.list}>
                {results.map((customer) => {
                    const isExcluded = customer.id === excludeId;
                    return (
                        <li key={customer.id}>
                            <button
                                type="button"
                                className={styles.result}
                                onClick={() => onPick(customer)}
                                disabled={isExcluded}
                            >
                                <span className={styles.resultText}>
                                    <span className={styles.name}>{customer.full_name}</span>
                                    <span className={styles.detail}>
                                        Born {formatDate(customer.date_of_birth)}
                                        {customer.current_id
                                            ? ` | ${customer.current_id.document_type} ${customer.current_id.document_number}`
                                            : ""}
                                        {customer.phone ? ` | ${customer.phone}` : ""}
                                    </span>
                                    {isExcluded && excludeNote ? (
                                        <span className={styles.exclude}>{excludeNote}</span>
                                    ) : null}
                                </span>
                                <IdStatusBadge currentId={customer.current_id} />
                            </button>
                        </li>
                    );
                })}
            </ul>
        );
    };

    return (
        <div className={styles.picker}>
            <label className={styles.label} htmlFor={inputId}>
                Search
            </label>
            <TextInput
                id={inputId}
                ref={inputRef}
                placeholder="e.g. 012345678, Jane Citizen or 0412 345 678"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                autoComplete="off"
            />
            {hasSearched ? <div aria-live="polite">{renderResults()}</div> : null}
            <div className={styles.footer}>
                <Button onClick={onNew}>{newLabel}</Button>
            </div>
        </div>
    );
};

export default CustomerPicker;
