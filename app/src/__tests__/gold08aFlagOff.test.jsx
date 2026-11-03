import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { makeAuthValue } from "../test/testUtils.jsx";

// UAT 8a.1: with VITE_GOLD_JOURNEY_ENABLED unset, no gold URL renders a gold screen; each lands on the picker.

vi.mock("../context/AuthContext.jsx", () => ({
    AuthProvider: ({ children }) => children,
    useAuth: vi.fn(),
}));

vi.mock("../config/featureFlags.js", () => ({
    ITEM_AND_DELIVERY_CAPTURE_ENABLED: false,
    GOLD_JOURNEY_ENABLED: false,
}));

vi.mock("../lib/supabase.js", () => ({ supabase: {} }));

const ID = "174fb856-4049-4c1a-a4c7-5440940ff088";
const PATHS = [
    "/gold",
    "/gold/customers/new",
    `/gold/customers/${ID}`,
    `/gold/customers/${ID}/update-id`,
    `/gold/customers/${ID}/edit`,
    "/gold/nonsense",
];

describe("8a.1 gold routes with the flag off", () => {
    beforeEach(() => {
        useAuth.mockReturnValue(makeAuthValue());
    });

    afterEach(() => {
        cleanup();
    });

    it.each(PATHS)("%s redirects to the journey picker and renders no gold screen", (path) => {
        render(
            <MemoryRouter initialEntries={[path]}>
                <AppRoutes />
            </MemoryRouter>
        );

        expect(screen.getByRole("heading", { name: "What would you like to do?" })).toBeInTheDocument();
        for (const gold of ["Find customer", "New customer", "Update ID", "Edit details"]) {
            expect(screen.queryByRole("heading", { name: gold })).not.toBeInTheDocument();
        }
        expect(screen.queryByRole("link", { name: "Switch journey" })).not.toBeInTheDocument();
    });
});
