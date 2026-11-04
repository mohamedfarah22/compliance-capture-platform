import { isIncomplete } from "@gold-rules";
import styles from "./PurchaseTags.module.css";

// The status tags of a purchase (spec 3.2): its type, "Incomplete" until it has an ERP invoice number, and for a
// reportable purchase "AUSTRAC pending" until its TTR is complete, then "AUSTRAC".
// purchase is { purchase_type, erp_invoice_no, cash_10k_or_more, ttr_status }; ttr_status is the TTR's status, or
// null when there is none.
const PurchaseTags = ({ purchase }) => (
    <>
        <span className={`${styles.tag} ${styles.neutral}`}>
            {purchase.purchase_type === "bullion" ? "Bullion" : "Scrap"}
        </span>
        {isIncomplete(purchase) ? <span className={`${styles.tag} ${styles.attention}`}>Incomplete</span> : null}
        {purchase.cash_10k_or_more && purchase.ttr_status !== "complete" ? (
            <span className={`${styles.tag} ${styles.blockingSolid}`}>AUSTRAC pending</span>
        ) : null}
        {purchase.cash_10k_or_more && purchase.ttr_status === "complete" ? (
            <span className={`${styles.tag} ${styles.blocking}`}>AUSTRAC</span>
        ) : null}
    </>
);

export default PurchaseTags;
