import { assert, assertEquals } from "std/assert";
import {
  BUSINESS_TIMEZONE,
  evaluateCash,
  isReportable,
  LOCATION_SNAPSHOT,
  ttrCase,
  validatePurchase,
} from "./goldRules.js";

// Smoke tests: prove Deno loads the shared module and the main rules run.
// The full rule set is tested in app/src/lib/goldRules.test.js.

Deno.test("goldRules loads in Deno and exports the shared constants", () => {
  assertEquals(BUSINESS_TIMEZONE, "Australia/Melbourne");
  assertEquals(LOCATION_SNAPSHOT, "Coburg, VIC");
});

Deno.test("exactly $10,000 cash is reportable and $9,999.99 is not", () => {
  assert(isReportable({ type: "scrap", cash10k: true, cashAmount: "10000" }));
  assert(!isReportable({ type: "scrap", cash10k: true, cashAmount: "9,999.99" }));
});

Deno.test("a reportable sale to a customer with details missing is case B and needs an invoice", () => {
  const draft = { type: "scrap", cash10k: true, photos: ["p"], idSighted: true };
  const cash = evaluateCash(draft);
  assertEquals(ttrCase({ cash, isJoint: false, readiness: ["dob"], answers: {} }), {
    case: "B",
    invoiceRequired: true,
  });
  const result = validatePurchase(draft, {
    mainCustomer: { id: "c1", first_name: "Jane", last_name: "Citizen" },
    readiness: ["dob"],
  });
  assert(result.errors.erp_invoice_no.includes("Jane Citizen"));
});
