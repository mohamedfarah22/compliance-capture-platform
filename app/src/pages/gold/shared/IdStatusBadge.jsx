import { idStatus } from "@gold-rules";
import { useAuth } from "../../../context/AuthContext.jsx";
import { daysUntil, formatDate } from "./format.js";
import styles from "./IdStatusBadge.module.css";

// currentId is { expiry_date, captured_at } or null (no ID on file). Colour carries the meaning:
// valid, attention (expiring, re-verify) and blocking (expired).
const IdStatusBadge = ({ currentId }) => {
    const { reportingEntity } = useAuth();
    const status = currentId ? idStatus(currentId, reportingEntity?.idv_max_reliance_days) : "none";
    const days = daysUntil(currentId?.expiry_date);

    const BADGES = {
        valid: [styles.valid, currentId?.expiry_date ? `ID valid to ${formatDate(currentId.expiry_date)}` : "ID valid"],
        expiring: [styles.attention, `ID expires in ${days} day${days === 1 ? "" : "s"}`],
        expired: [styles.blocking, `ID expired ${formatDate(currentId?.expiry_date)}`],
        reverify: [styles.attention, "Re-verify ID"],
        unknown: [styles.neutral, "No expiry on file"],
        none: [styles.neutral, "No ID on file"],
    };
    const [tone, text] = BADGES[status];

    return <span className={`${styles.badge} ${tone}`}>{text}</span>;
};

export default IdStatusBadge;
