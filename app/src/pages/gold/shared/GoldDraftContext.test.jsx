import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GoldDraftProvider, useGoldDraft } from "./GoldDraftContext.jsx";

afterEach(cleanup);

const renderDraft = () => renderHook(() => useGoldDraft(), { wrapper: GoldDraftProvider });

describe("GoldDraftContext", () => {
    it("throws outside its provider", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});

        expect(() => renderHook(() => useGoldDraft())).toThrow("inside GoldDraftProvider");
    });

    it("keeps a draft per customer and merges patches", () => {
        const { result } = renderDraft();

        act(() => result.current.setDraft("c1", { invoice: "INV-1" }));
        act(() => result.current.setDraft("c1", { phone: "0412" }));
        act(() => result.current.setDraft("c2", { invoice: "INV-2" }));

        expect(result.current.drafts).toEqual({
            c1: { invoice: "INV-1", phone: "0412" },
            c2: { invoice: "INV-2" },
        });
    });

    it("clears one customer's draft", () => {
        const { result } = renderDraft();
        act(() => result.current.setDraft("c1", { invoice: "INV-1" }));
        act(() => result.current.setDraft("c2", { invoice: "INV-2" }));

        act(() => result.current.clearDraft("c1"));

        expect(result.current.drafts).toEqual({ c2: { invoice: "INV-2" } });
    });

    it("reset() returns to the initial state", () => {
        const { result } = renderDraft();
        act(() => result.current.setDraft("c1", { invoice: "INV-1" }));

        act(() => result.current.reset());

        expect(result.current.drafts).toEqual({});
    });

    it("drops every draft when the provider unmounts, as GoldLayout does on sign-out", () => {
        const first = renderDraft();
        act(() => first.result.current.setDraft("c1", { invoice: "INV-1" }));
        first.unmount();

        const second = renderDraft();

        expect(second.result.current.drafts).toEqual({});
    });

    it("keeps nothing in browser storage", () => {
        const { result } = renderDraft();

        act(() => result.current.setDraft("c1", { phone: "0412 345 678" }));

        expect(JSON.stringify({ ...localStorage })).not.toContain("0412");
        expect(JSON.stringify({ ...sessionStorage })).not.toContain("0412");
    });
});
