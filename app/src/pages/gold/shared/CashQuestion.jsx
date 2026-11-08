import { BULLION_BANDS, CASH_REPORT_THRESHOLD, claimsCash10k } from "@gold-rules";
import { useId } from "react";
import FormField from "../../../components/ui/FormField.jsx";
import TextInput from "../../../components/ui/TextInput.jsx";
import Segmented from "./Segmented.jsx";
import YesNo from "./YesNo.jsx";
import styles from "./CashQuestion.module.css";

// The cash question, which depends on the purchase type:
//   Scrap jewellery: "Paid in cash of $10,000 or more?" No / Yes
//   Bullion: "Cash paid": Under $5,000 / $5,000 to $9,999 / $10,000 or more
// The optional cash amount appears for $10,000 or more. onChange receives a patch
// ({ cash10k } | { bullionBand } | { cashAmount }).
const CashQuestion = ({ idPrefix, type, cash10k, bullionBand, cashAmount, onChange, error }) => {
    const questionId = useId();
    const hintId = useId();
    const threshold = CASH_REPORT_THRESHOLD.toLocaleString("en-AU");
    const isBullion = type === "bullion";

    return (
        <div className={styles.question}>
            {isBullion ? (
                <>
                    <span id={questionId} className={styles.label}>
                        Cash paid
                    </span>
                    <Segmented
                        options={BULLION_BANDS}
                        value={bullionBand}
                        onChange={(value) => onChange({ bullionBand: value })}
                        labelledBy={questionId}
                        describedBy={hintId}
                    />
                    <p id={hintId} className={styles.hint}>
                        {bullionBand === "5k_to_10k"
                            ? "Needs this customer’s current ID. No AUSTRAC report."
                            : "Count only the cash part of the payment. Bank transfers don’t count."}
                    </p>
                </>
            ) : (
                <>
                    <span id={questionId} className={styles.label}>
                        Paid in cash of ${threshold} or more?
                    </span>
                    <YesNo
                        value={!!cash10k}
                        onChange={(value) => onChange({ cash10k: value })}
                        labelledBy={questionId}
                        describedBy={hintId}
                    />
                    <p id={hintId} className={styles.hint}>
                        Includes exactly ${threshold}.
                    </p>
                </>
            )}
            {claimsCash10k({ type, cash10k, bullionBand }) ? (
                <FormField
                    label="Cash amount (AUD, optional)"
                    labelFor={`${idPrefix}-amount`}
                    helperText="Leave blank if you are not sure. The amount, if entered, decides whether a report is needed."
                    error={error || undefined}
                >
                    <TextInput
                        id={`${idPrefix}-amount`}
                        inputMode="decimal"
                        placeholder="e.g. 12,500"
                        autoComplete="off"
                        value={cashAmount}
                        aria-invalid={Boolean(error)}
                        onChange={(e) => onChange({ cashAmount: e.target.value })}
                    />
                </FormField>
            ) : null}
        </div>
    );
};

export default CashQuestion;
