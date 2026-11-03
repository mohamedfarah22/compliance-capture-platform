import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldLayout from "./GoldLayout.jsx";
import { useGoldDraft } from "./shared/index.js";

vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

const DraftProbe = () => {
    const { drafts, setDraft } = useGoldDraft();
    return (
        <>
            <p>screen body</p>
            <p data-testid="drafts">{JSON.stringify(drafts)}</p>
            <button onClick={() => setDraft("c1", { invoice: "INV-1" })}>Add draft</button>
        </>
    );
};

const open = () =>
    render(
        <MemoryRouter initialEntries={["/gold"]}>
            <Routes>
                <Route path="/" element={<h1>Journey picker</h1>} />
                <Route path="/gold" element={<GoldLayout />}>
                    <Route index element={<DraftProbe />} />
                </Route>
            </Routes>
        </MemoryRouter>
    );

const signOut = vi.fn();
beforeEach(() => {
    signOut.mockReset();
    useAuth.mockReturnValue(makeAuthValue({ signOut }));
});
afterEach(cleanup);

describe("GoldLayout", () => {
    it("shows the staff name, Switch journey and Sign out around the routed screen", () => {
        open();

        expect(screen.getByText("Jane Staff")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Switch journey" })).toHaveAttribute("href", "/");
        expect(screen.getByText("screen body")).toBeInTheDocument();
    });

    it("Sign out signs out, and Switch journey leaves for the picker", async () => {
        const user = userEvent.setup();
        open();

        await user.click(screen.getByRole("button", { name: /Sign out/ }));
        expect(signOut).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("link", { name: "Switch journey" }));
        expect(await screen.findByRole("heading", { name: "Journey picker" })).toBeInTheDocument();
    });

    it("gives its screens the purchase drafts, and starts each visit with none", async () => {
        const user = userEvent.setup();
        open();
        expect(screen.getByTestId("drafts")).toHaveTextContent("{}");

        await user.click(screen.getByRole("button", { name: "Add draft" }));
        expect(screen.getByTestId("drafts")).toHaveTextContent('{"c1":{"invoice":"INV-1"}}');

        cleanup(); // leaving the layout, as Switch journey and sign-out do
        open();
        expect(screen.getByTestId("drafts")).toHaveTextContent("{}");
    });
});
