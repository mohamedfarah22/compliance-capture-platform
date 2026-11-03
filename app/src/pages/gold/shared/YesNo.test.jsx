import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import YesNo from "./YesNo.jsx";

afterEach(cleanup);

describe("YesNo", () => {
    it("is a radio group named by its label, with No and Yes as radios", () => {
        render(
            <>
                <span id="q">Does the ID have an expiry date?</span>
                <YesNo value={true} onChange={vi.fn()} labelledBy="q" />
            </>
        );

        const group = screen.getByRole("radiogroup", { name: "Does the ID have an expiry date?" });
        expect(group).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "Yes" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "No" })).not.toBeChecked();
    });

    it("reports a click", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<YesNo value={null} onChange={onChange} />);

        await user.click(screen.getByRole("radio", { name: "No" }));

        expect(onChange).toHaveBeenCalledWith(false);
    });

    it("moves with the arrow keys and wraps, as a native radio group does", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<YesNo value={true} onChange={onChange} />);

        screen.getByRole("radio", { name: "Yes" }).focus();
        await user.keyboard("{ArrowRight}");
        expect(onChange).toHaveBeenLastCalledWith(false);

        await user.keyboard("{ArrowLeft}");
        expect(onChange).toHaveBeenLastCalledWith(false);
    });

    it("has one tab stop: the chosen option, or the first while unanswered", () => {
        const { rerender } = render(<YesNo value={null} onChange={vi.fn()} />);
        expect(screen.getByRole("radio", { name: "No" })).toHaveAttribute("tabindex", "0");
        expect(screen.getByRole("radio", { name: "Yes" })).toHaveAttribute("tabindex", "-1");

        rerender(<YesNo value={true} onChange={vi.fn()} />);
        expect(screen.getByRole("radio", { name: "Yes" })).toHaveAttribute("tabindex", "0");
        expect(screen.getByRole("radio", { name: "No" })).toHaveAttribute("tabindex", "-1");
    });
});
