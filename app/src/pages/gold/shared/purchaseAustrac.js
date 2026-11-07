// Whether a purchase part is reportable to AUSTRAC (spec 3.2, 3.4). It is per sale, not per row: gold-save-purchase
// flags only the part that tips the invoice total over the threshold, so the earlier part of a mixed invoice is
// unflagged but linked to its own TTR. A part is reportable when it is flagged or linked to a TTR.
// purchase is { cash_10k_or_more, ttr_status }; ttr_status is the linked TTR's status, or null when there is none.
export const isAustracReportable = (purchase) => Boolean(purchase.cash_10k_or_more) || purchase.ttr_status != null;
