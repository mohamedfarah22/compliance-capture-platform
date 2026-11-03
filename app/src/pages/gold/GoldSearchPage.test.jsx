import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { searchCustomers } from "../../lib/goldApi.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { makeAuthValue } from "../../test/testUtils.jsx";
import GoldSearchPage from "./GoldSearchPage.jsx";

vi.mock("../../lib/goldApi.js", () => ({ searchCustomers: vi.fn() }));
vi.mock("../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

const jane = {
    id: "c1",
    full_name: "Jane Citizen",
    date_of_birth: "1985-06-15",
    phone: "0412 345 678",
    current_id: null,
};

const open = () =>
    render(
        <MemoryRouter initialEntries={["/gold"]}>
            <Routes>
                <Route path="/gold" element={<GoldSearchPage />} />
                <Route path="/gold/customers/new" element={<h1>New customer screen</h1>} />
                <Route path="/gold/customers/:customerId" element={<h1>Customer screen</h1>} />
            </Routes>
        </MemoryRouter>
    );

beforeEach(() => {
    useAuth.mockReturnValue(makeAuthValue());
    searchCustomers.mockResolvedValue([jane]);
});
afterEach(cleanup);

describe("GoldSearchPage", () => {
    it("is Find customer, with the search box focused", () => {
        open();

        expect(screen.getByRole("heading", { name: "Find customer" })).toBeInTheDocument();
        expect(screen.getByLabelText("Search")).toHaveFocus();
    });

    it("opens the customer picked, and keeps the search text out of the URL", async () => {
        const user = userEvent.setup();
        open();

        await user.type(screen.getByLabelText("Search"), "jane");
        await user.click(await screen.findByRole("button", { name: /Jane Citizen/ }));

        expect(await screen.findByRole("heading", { name: "Customer screen" })).toBeInTheDocument();
        expect(window.location.search).toBe("");
    });

    it("opens New customer", async () => {
        const user = userEvent.setup();
        open();

        await user.click(screen.getByRole("button", { name: "New customer" }));

        expect(await screen.findByRole("heading", { name: "New customer screen" })).toBeInTheDocument();
    });
});
