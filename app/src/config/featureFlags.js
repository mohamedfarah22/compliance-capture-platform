// Client no longer wants to collect bullion/precious-metal item details or the
// delivery/handover fields on Recipient / Delivery. Flip this back to true to
// re-introduce those wizard steps — the pages, DB schema, and edge function
// validation all still support it unchanged.
export const ITEM_AND_DELIVERY_CAPTURE_ENABLED = false;
