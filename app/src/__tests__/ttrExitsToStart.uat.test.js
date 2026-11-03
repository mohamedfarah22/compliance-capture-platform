// UAT row 9.49 (docs/uat-gold-09a-ttr-handoff.md, spec 7 "TTR pages that navigate('/') and expect the TTR start"):
// `/` is the journey picker, so no TTR page may send staff there expecting the TTR start. Each TTR page's exits
// (Exit, Cancel, Start New Transaction, and the pages' own redirects) must name /start. The screens themselves are
// checked in app/e2e/gold09a/05-wizard-pickup.e2e.js.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = path.resolve(__dirname, "..", "pages");
const TTR_DIRS = [
    "bullion-details",
    "conducting-person",
    "customers",
    "id-verification",
    "open-ttr",
    "party-details",
    "precious-metal-details",
    "recipient-delivery",
    "reports",
    "review-batch",
    "review-submit",
    "start",
    "transaction-complete",
    "transaction-details",
];

const sources = (dir) =>
    readdirSync(path.join(PAGES, dir))
        .filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f))
        .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(path.join(PAGES, dir, f), "utf8") }));

const ROOT = /(navigate\(\s*["'`]\/["'`]|<Navigate[^>]*\bto=["'`]\/["'`]|\bto=["'`]\/["'`]|history\.(push|replace)\(\s*["'`]\/["'`]|location\.(href|assign)\s*=?\s*\(?["'`]\/["'`])/;

describe("9.49 no TTR page sends staff to / expecting the TTR start", () => {
    it("the directories listed are the TTR pages (every page directory except gold, journey, login, mfa)", () => {
        const all = readdirSync(PAGES, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        expect(all.filter((d) => !TTR_DIRS.includes(d)).sort()).toEqual(["gold", "journey", "login", "mfa"]);
    });

    it.each(TTR_DIRS)("%s never navigates to /", (dir) => {
        for (const { file, text } of sources(dir)) expect(text, file).not.toMatch(ROOT);
    });

    it("the exits that leave a wizard page name /start", () => {
        const text = TTR_DIRS.flatMap(sources)
            .map((s) => s.text)
            .join("\n");
        expect(text).toMatch(/navigate\(\s*["'`]\/start["'`]/);
    });
});
