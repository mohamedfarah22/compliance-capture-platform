import { useRef } from "react";
import styles from "./YesNo.module.css";

const OPTIONS = [
    [false, "No"],
    [true, "Yes"],
];
const STEP_BY_KEY = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

// A No / Yes radio group styled as two buttons. Arrow keys move the choice, as in a native radio group.
// value is true, false, or null while unanswered.
const YesNo = ({ value, onChange, labelledBy, describedBy }) => {
    const buttonRefs = useRef([]);
    const selected = OPTIONS.findIndex(([option]) => option === value);

    const handleKeyDown = (e) => {
        const step = STEP_BY_KEY[e.key];
        if (!step) return;
        e.preventDefault();
        const next = (Math.max(selected, 0) + step + OPTIONS.length) % OPTIONS.length;
        onChange(OPTIONS[next][0]);
        buttonRefs.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className={styles.group}>
            {OPTIONS.map(([option, label], index) => (
                <button
                    key={label}
                    ref={(el) => {
                        buttonRefs.current[index] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={value === option}
                    // With no answer yet the first option is the tab stop.
                    tabIndex={value === option || (selected === -1 && index === 0) ? 0 : -1}
                    className={`${styles.option} ${value === option ? styles.selected : ""}`}
                    onClick={() => onChange(option)}
                    onKeyDown={handleKeyDown}
                >
                    {label}
                </button>
            ))}
        </div>
    );
};

export default YesNo;
