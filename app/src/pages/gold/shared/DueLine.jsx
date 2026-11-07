import { austracDueDate } from "@gold-rules";
import { businessDaysUntil, formatDate } from "./format.js";
import styles from "./DueLine.module.css";

const days = (count) => `${count} business day${count === 1 ? "" : "s"}`;

// "AUSTRAC report due 12 Oct 2026 · 3 business days left". Red when 2 or fewer days are left, or overdue.
// purchase is { created_at }; the deadline is 10 business days after it (spec 3.3).
const DueLine = ({ purchase }) => {
    const due = austracDueDate(purchase).toISOString().slice(0, 10);
    const left = businessDaysUntil(due);
    const text = left < 0 ? `Overdue by ${days(-left)}` : left === 0 ? "Due today" : `${days(left)} left`;

    return (
        <p className={`${styles.line} ${left <= 2 ? styles.urgent : styles.soon}`}>
            AUSTRAC report due {formatDate(due)} · {text}
        </p>
    );
};

export default DueLine;
