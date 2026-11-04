// UAT row 9.46 (docs/uat-gold-09a-ttr-handoff.md, spec 3.4): when saving a TTR fails because another report already
// holds the reference for the same scenario, staff are told that a reference is unique per scenario. The database
// side (the constraint and its SQLSTATE 23505) is proved in supabase/tests/13_gold09a_uat.test.sql, row 9.29.
import { describe, expect, it } from "vitest";
import { describeSaveError } from "./wizardApi.js";

describe("9.46 describeSaveError explains the per-scenario reference rule", () => {
    const WORDS =
        "That transaction reference is already in use for this scenario. A reference can be used once for each scenario";

    it("a 23505 from the database says so", () => {
        const message = describeSaveError({ code: "23505", message: "duplicate key value violates unique constraint" });
        expect(message.startsWith(WORDS)).toBe(true);
        expect(message).toContain("choose a different scenario");
    });

    it("the constraint name alone is enough", () => {
        const error = { message: 'duplicate key value violates unique constraint "uq_tx_ref_per_entity"' };
        expect(describeSaveError(error).startsWith(WORDS)).toBe(true);
    });

    it("another failure keeps its own message", () => {
        expect(describeSaveError({ message: "permission denied" })).toBe("permission denied");
        expect(describeSaveError({})).toBe("Failed to save. Please try again.");
    });
});
