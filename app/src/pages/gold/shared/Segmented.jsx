import { useRef } from "react";
import styles from "./Segmented.module.css";

const STEP_BY_KEY = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

// A single choice among a few options, shown as buttons (a radio group). Arrow keys move the choice, as in a
// native radio group. options is [[value, label], ...].
const Segmented = ({ options, value, onChange, labelledBy, describedBy }) => {
    const buttonRefs = useRef([]);
    const selected = Math.max(
        0,
        options.findIndex(([option]) => option === value)
    );

    const handleKeyDown = (e) => {
        const step = STEP_BY_KEY[e.key];
        if (!step) return;
        e.preventDefault();
        const next = (selected + step + options.length) % options.length;
        onChange(options[next][0]);
        buttonRefs.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className={styles.group}>
            {options.map(([option, label], index) => (
                <button
                    key={option}
                    ref={(el) => {
                        buttonRefs.current[index] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={value === option}
                    tabIndex={index === selected ? 0 : -1}
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

export default Segmented;
