import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CameraCapture from "./CameraCapture.jsx";

const stopTrack = vi.fn();
let drawImage;
let canvasSizes;

beforeEach(() => {
    stopTrack.mockClear();
    drawImage = vi.fn();
    canvasSizes = [];
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    // A 4K iPad / webcam frame.
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, value: 3840 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, value: 2160 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback, type) {
        canvasSizes.push([this.width, this.height]);
        callback(new Blob(["frame"], { type }));
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("CameraCapture", () => {
    it("hands on a JPEG of at most 1600 px on the long side when a frame is taken", async () => {
        const user = userEvent.setup();
        const onCapture = vi.fn();
        render(<CameraCapture title="ID front" onCapture={onCapture} onClose={vi.fn()} />);

        const take = screen.getByRole("button", { name: "Take photo" });
        await waitFor(() => expect(take).toBeEnabled());
        await user.click(take);

        await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
        const blob = onCapture.mock.calls[0][0];
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe("image/jpeg");
        expect(canvasSizes).toEqual([[1600, 900]]);
    });

    it("keeps Take photo disabled until the camera is running", async () => {
        navigator.mediaDevices.getUserMedia.mockReturnValue(new Promise(() => {}));
        render(<CameraCapture title="ID front" onCapture={vi.fn()} onClose={vi.fn()} />);

        expect(screen.getByRole("button", { name: "Take photo" })).toBeDisabled();
    });

    it("says the camera is unavailable and points to Upload when access is refused", async () => {
        navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error("denied"));
        render(<CameraCapture title="ID front" onCapture={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByRole("alert")).toHaveTextContent("choose Upload");
        expect(screen.getByRole("button", { name: "Take photo" })).toBeDisabled();
    });

    it("closes on Escape and on Cancel, and stops the camera", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const { unmount } = render(<CameraCapture title="ID front" onCapture={vi.fn()} onClose={onClose} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Take photo" })).toBeEnabled());

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(2);

        unmount();
        expect(stopTrack).toHaveBeenCalled();
    });
});
