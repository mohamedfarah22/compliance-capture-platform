import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Lightbox from "./Lightbox.jsx";

afterEach(cleanup);

describe("Lightbox", () => {
    it("shows one image, and closes on Escape", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<Lightbox src="https://x/front.jpg" alt="ID front" onClose={onClose} />);

        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "ID front" })).toHaveAttribute("src", "https://x/front.jpg");

        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes from the Close button and from a click outside the picture, once each", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<Lightbox src="https://x/front.jpg" alt="ID front" onClose={onClose} />);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("dialog"));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("shows several images side by side with captions", () => {
        render(
            <Lightbox
                images={[
                    { src: "https://x/f.jpg", alt: "ID front" },
                    { src: "https://x/b.jpg", alt: "ID back" },
                ]}
                onClose={vi.fn()}
            />
        );

        expect(screen.getAllByRole("img")).toHaveLength(2);
        expect(screen.getAllByText("ID front")).toHaveLength(1);
    });

    it("renders nothing when there is nothing to show", () => {
        render(<Lightbox images={[{ src: null, alt: "ID back" }]} onClose={vi.fn()} />);

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("moves the focus into the dialog, and back to what opened it when it closes", () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();

        const { unmount } = render(<Lightbox src="https://x/f.jpg" alt="ID front" onClose={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

        unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });
});
