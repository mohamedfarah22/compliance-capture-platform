import { assertEquals } from "std/assert";
import { idKey, nameKey, phoneKey } from "./goldKeys.ts";

// These fixtures are the same strings the pgTAP tests (01 customers, 04 id store) use against the SQL.

Deno.test("phoneKey: +61 becomes a leading 0", () => {
  assertEquals(phoneKey("+61 412 345 678"), "0412345678");
});

Deno.test("phoneKey: dashes are stripped", () => {
  assertEquals(phoneKey("0412-345-678"), "0412345678");
});

Deno.test("phoneKey: an already-local number is unchanged", () => {
  assertEquals(phoneKey("0412345678"), "0412345678");
});

Deno.test("phoneKey: empty or no digits gives null", () => {
  assertEquals(phoneKey(""), null);
  assertEquals(phoneKey(null), null);
  assertEquals(phoneKey(undefined), null);
  assertEquals(phoneKey("n/a"), null);
});

Deno.test("nameKey: collapses whitespace, lower-cases, null middle name", () => {
  assertEquals(nameKey("  Mary  Anne ", null, " SMITH "), "mary anne smith");
  assertEquals(nameKey("  Mary", null, "Anne   SMITH "), "mary anne smith");
});

Deno.test("nameKey: includes the middle name", () => {
  assertEquals(nameKey("Jane", "Q", "Citizen"), "jane q citizen");
});

Deno.test("nameKey: a null first name leaves no stray space", () => {
  assertEquals(nameKey(null, null, "Citizen"), "citizen");
  assertEquals(nameKey(null, null, null), "");
});

Deno.test("idKey: upper-case, spaces and dashes removed", () => {
  assertEquals(idKey("ab-12 34"), "AB1234");
  assertEquals(idKey(" p 123-456 "), "P123456");
  assertEquals(idKey(null), "");
});
