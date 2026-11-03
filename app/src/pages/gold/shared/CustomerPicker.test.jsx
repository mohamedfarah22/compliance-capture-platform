import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { searchCustomers } from "../../../lib/goldApi.js";
import { useAuth } from "../../../context/AuthContext.jsx";
import { makeAuthValue } from "../../../test/testUtils.jsx";
import CustomerPicker from "./CustomerPicker.jsx";

vi.mock("../../../lib/goldApi.js", () => ({ searchCustomers: vi.fn() }));
vi.mock("../../../context/AuthContext.jsx", () => ({ useAuth: vi.fn() }));

const jane = {
    id: "c1",
    full_name: "Jane Citizen",
    date_of_birth: "1985-06-15",
    phone: "0412 345 678",
    current_id: {
        document_type: "Driver licence",
        document_number: "012345678",
        expiry_date: "2099-01-01",
        captured_at: new Date().toISOString(),
    },
};
const mark = {
    id: "c2",
    full_name: "Mark Nguyen",
    date_of_birth: "1990-01-02",
    phone: "0433 222 111",
    current_id: null,
};

const setup = (props = {}) => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onNew = vi.fn();
    render(<CustomerPicker onPick={onPick} onNew={onNew} {...props} />);
    return { user, onPick, onNew };
};
// The real 250 ms debounce, plus a little. Results arrive after it.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 400)));

beforeEach(() => {
    useAuth.mockReturnValue(makeAuthValue());
    searchCustomers.mockReset();
});

afterEach(cleanup);

describe("CustomerPicker", () => {
    it("focuses the search box", () => {
        setup();

        expect(screen.getByLabelText("Search")).toHaveFocus();
    });

    it("searches nothing for one character, and once for the whole term about 250 ms after the last key", async () => {
        searchCustomers.mockResolvedValue([jane]);
        const { user } = setup();

        await user.type(screen.getByLabelText("Search"), "j");
        await settle();
        expect(searchCustomers).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText("Search"), "ane ci");
        expect(searchCustomers).not.toHaveBeenCalled();
        await settle();

        expect(searchCustomers).toHaveBeenCalledTimes(1);
        expect(searchCustomers).toHaveBeenCalledWith("jane ci");
    });

    it("shows name, date of birth, ID, phone and the ID badge for each result", async () => {
        searchCustomers.mockResolvedValue([jane, mark]);
        const { user } = setup();

        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();

        const row = screen.getByRole("button", { name: /Jane Citizen/ });
        expect(row).toHaveTextContent(/Born 15 June? 1985/);
        expect(row).toHaveTextContent("Driver licence 012345678");
        expect(row).toHaveTextContent("0412 345 678");
        expect(row).toHaveTextContent(/ID valid to/);
        expect(screen.getByRole("button", { name: /Mark Nguyen/ })).toHaveTextContent("No ID on file");
    });

    it("picks on click", async () => {
        searchCustomers.mockResolvedValue([jane, mark]);
        const { user, onPick } = setup();
        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();

        await user.click(screen.getByRole("button", { name: /Mark Nguyen/ }));

        expect(onPick).toHaveBeenCalledWith(mark);
    });

    it("picks on Enter only when there is exactly one result", async () => {
        searchCustomers.mockResolvedValue([jane, mark]);
        const { user, onPick } = setup();
        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();
        await user.keyboard("{Enter}");
        expect(onPick).not.toHaveBeenCalled();

        searchCustomers.mockResolvedValue([jane]);
        await user.type(screen.getByLabelText("Search"), "n");
        await settle();
        await user.keyboard("{Enter}");
        expect(onPick).toHaveBeenCalledWith(jane);
    });

    it("shows a customer who cannot be picked as disabled with the reason", async () => {
        searchCustomers.mockResolvedValue([jane]);
        const { user, onPick } = setup({ excludeId: "c1", excludeNote: "Already the main seller" });
        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();

        expect(screen.getByRole("button", { name: /Jane Citizen/ })).toBeDisabled();
        expect(screen.getByText("Already the main seller")).toBeInTheDocument();
        await user.keyboard("{Enter}");
        expect(onPick).not.toHaveBeenCalled();
    });

    it("says so when nobody matches, and offers New customer", async () => {
        searchCustomers.mockResolvedValue([]);
        const { user, onNew } = setup();
        await user.type(screen.getByLabelText("Search"), "zzz");
        await settle();

        expect(screen.getByText(/No customer matches “zzz”/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "New customer" }));
        expect(onNew).toHaveBeenCalled();
    });

    it("shows an alert when the search fails, and recovers on the next search", async () => {
        searchCustomers.mockRejectedValueOnce(new Error("offline"));
        const { user } = setup();
        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();
        expect(screen.getByRole("alert")).toHaveTextContent("The search failed");

        searchCustomers.mockResolvedValue([jane]);
        await user.type(screen.getByLabelText("Search"), "n");
        await settle();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Jane Citizen/ })).toBeInTheDocument();
    });

    it("does not let a slow answer for an old term overwrite a newer one", async () => {
        let resolveSlow;
        searchCustomers.mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)));
        searchCustomers.mockResolvedValueOnce([mark]);
        const { user } = setup();

        await user.type(screen.getByLabelText("Search"), "ja");
        await settle();
        await user.type(screen.getByLabelText("Search"), "n");
        await settle();
        await act(async () => resolveSlow([jane]));

        expect(screen.getByRole("button", { name: /Mark Nguyen/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Jane Citizen/ })).not.toBeInTheDocument();
    });
});
