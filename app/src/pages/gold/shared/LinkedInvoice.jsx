import { CASH_REPORT_THRESHOLD, typeLabel } from "@gold-rules";
import FormField from "../../../components/ui/FormField.jsx";
import TextInput from "../../../components/ui/TextInput.jsx";
import { formatAud, formatDateTime } from "./format.js";
import styles from "./LinkedInvoice.module.css";

// Shown instead of the cash question when the invoice number matches purchases recorded the same day for the
// same customer (spec 3.4). Asks for this part's cash (and any earlier part's cash that was never saved) and
// shows the total. onChange receives { partAmount } or { linkedAmounts }. cash is the evaluateCash() result.
// isPartFixed shows this part's cash read-only: it was saved with the purchase.
const LinkedInvoice = ({
    idPrefix,
    invoice,
    linked,
    partAmount,
    linkedAmounts = {},
    cash,
    errors = {},
    isPartFixed = false,
    onChange,
}) => (
    <div className={styles.panel}>
        <p className={styles.title}>
            Same invoice as {linked.length === 1 ? "an earlier purchase" : `${linked.length} earlier purchases`} today
            for this customer
        </p>
        <p className={styles.text}>
            The cash across the whole invoice decides AUSTRAC reporting. The app adds the parts up.
        </p>

        <ul className={styles.parts}>
            {linked.map((part) => {
                const id = `${idPrefix}-linked-${part.id}`;
                return (
                    <li key={part.id}>
                        <p className={styles.text}>
                            <strong>{typeLabel(part.purchase_type)}</strong>, recorded {formatDateTime(part.created_at)}
                            {part.cash_amount != null ? (
                                <>
                                    : <strong>{formatAud(part.cash_amount)}</strong> cash
                                </>
                            ) : null}
                            {part.ttr_transaction_id ? (
                                <strong className={styles.reported}> (AUSTRAC report started)</strong>
                            ) : null}
                        </p>
                        {part.cash_amount == null ? (
                            <FormField
                                label="Cash paid on that part (AUD)"
                                labelFor={id}
                                error={errors[`linked_${part.id}`] || undefined}
                            >
                                <TextInput
                                    id={id}
                                    inputMode="decimal"
                                    placeholder="e.g. 6,000"
                                    autoComplete="off"
                                    value={linkedAmounts[part.id] || ""}
                                    aria-invalid={Boolean(errors[`linked_${part.id}`])}
                                    onChange={(e) =>
                                        onChange({ linkedAmounts: { ...linkedAmounts, [part.id]: e.target.value } })
                                    }
                                />
                            </FormField>
                        ) : null}
                    </li>
                );
            })}
        </ul>

        <FormField
            label="Cash paid for this part (AUD)"
            labelFor={`${idPrefix}-part`}
            helperText={errors.partAmount ? undefined : "Enter 0 if this part wasn’t paid in cash."}
            error={errors.partAmount || undefined}
        >
            <TextInput
                id={`${idPrefix}-part`}
                inputMode="decimal"
                placeholder="e.g. 6,000"
                autoComplete="off"
                value={partAmount || ""}
                disabled={isPartFixed}
                aria-invalid={Boolean(errors.partAmount)}
                onChange={(e) => onChange({ partAmount: e.target.value })}
            />
        </FormField>

        {cash.total !== null ? (
            <p className={styles.total} role="status">
                Cash on {invoice.trim()} today: {formatAud(cash.total)}.{" "}
                {cash.alreadyReported
                    ? "An earlier part of this type already has an AUSTRAC report. This part joins it while it is a draft."
                    : cash.reportable
                      ? `That’s ${formatAud(CASH_REPORT_THRESHOLD)} or more, so the invoice will be reported to AUSTRAC once.`
                      : `Under ${formatAud(CASH_REPORT_THRESHOLD)}: no AUSTRAC report.`}
            </p>
        ) : null}
    </div>
);

export default LinkedInvoice;
