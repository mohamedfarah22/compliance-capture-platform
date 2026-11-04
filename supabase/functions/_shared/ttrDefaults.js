// What the TTR wizard (app/src/lib/wizardApi.js) and gold-start-ttr both write onto a new ttr.transactions row, so a
// TTR started from gold reads the same as one started in the wizard. The location is LOCATION_SNAPSHOT in goldRules.js.
// Plain JS with no imports: the browser (through the @ttr-defaults alias) and the Deno edge functions import it.

export const TTR_DESIGNATED_SERVICES = {
    bullion_sell: "Sale of bullion for physical cash",
    bullion_buy: "Purchase of bullion for physical cash",
    precious_metal_sell: "Sale of precious metal for physical cash",
    precious_metal_buy: "Purchase of precious metal for physical cash",
};
