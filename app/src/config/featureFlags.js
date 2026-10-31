// Client no longer wants to collect bullion/precious-metal item details or the
// delivery/handover fields on Recipient / Delivery. Flip this back to true to
// re-introduce those wizard steps — the pages, DB schema, and edge function
// validation all still support it unchanged.
export const ITEM_AND_DELIVERY_CAPTURE_ENABLED = false;

// Gold due diligence journey. A build-time flag: on for Vercel previews, off in
// production until go-live. While it is off the journey picker hides the Gold card
// and /gold redirects to the picker. The gold edge functions have their own server
// secret, GOLD_JOURNEY_ENABLED.
export const GOLD_JOURNEY_ENABLED = import.meta.env.VITE_GOLD_JOURNEY_ENABLED === "true";
