import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobToDataURL, compressImage, daysUntil, fitWithin, formatDate, formatDateTime } from "./format.js";

// jsdom decodes no images and draws on no canvas, so both are stood in for. What is tested is the decision the
// code makes: the size it draws at, and that what comes out is a JPEG whatever went in.
const stubImage = ({ width, height, fails = false }) => {
    vi.stubGlobal(
        "Image",
        class {
            constructor() {
                this.width = width;
                this.height = height;
            }
            set src(_value) {
                queueMicrotask(() => (fails ? this.onerror() : this.onload()));
            }
        }
    );
};

describe("compressImage", () => {
    let drawImage;
    let canvasSizes;

    beforeEach(() => {
        drawImage = vi.fn();
        canvasSizes = [];
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage });
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback, type) {
            canvasSizes.push([this.width, this.height]);
            callback(new Blob(["jpeg-bytes"], { type }));
        });
        URL.createObjectURL = vi.fn(() => "blob:photo");
        URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("hands on a JPEG of at most 1600 px on the long side, keeping the aspect ratio", async () => {
        stubImage({ width: 4000, height: 3000 });

        const blob = await compressImage(new File(["png"], "id.png", { type: "image/png" }));

        expect(blob.type).toBe("image/jpeg");
        expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.82);
        expect(canvasSizes).toEqual([[1600, 1200]]);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 1200);
    });

    it("scales a portrait photo by its height", async () => {
        stubImage({ width: 2400, height: 3200 });

        await compressImage(new File(["x"], "id.webp", { type: "image/webp" }));

        expect(canvasSizes).toEqual([[1200, 1600]]);
    });

    it("converts a HEIC photo, as an iPad or iPhone camera can produce, to a JPEG", async () => {
        stubImage({ width: 4032, height: 3024 });

        const blob = await compressImage(new File(["heic"], "IMG_0001.HEIC", { type: "image/heic" }));

        expect(blob.type).toBe("image/jpeg");
        expect(canvasSizes).toEqual([[1600, 1200]]);
    });

    it("does not enlarge a photo that is already small", async () => {
        stubImage({ width: 800, height: 600 });

        await compressImage(new File(["x"], "small.jpg", { type: "image/jpeg" }));

        expect(canvasSizes).toEqual([[800, 600]]);
    });

    it("reads a data URL", async () => {
        stubImage({ width: 3200, height: 1800 });

        const blob = await compressImage("data:image/png;base64,AAAA");

        expect(blob.type).toBe("image/jpeg");
        expect(canvasSizes).toEqual([[1600, 900]]);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("takes a frame from a live video at its own size, scaled down", async () => {
        const video = { videoWidth: 3840, videoHeight: 2160 };

        const blob = await compressImage(video);

        expect(blob.type).toBe("image/jpeg");
        expect(canvasSizes).toEqual([[1600, 900]]);
        expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1600, 900);
    });

    it("rejects a file the browser cannot decode, and still releases the object URL", async () => {
        stubImage({ width: 0, height: 0, fails: true });

        await expect(compressImage(new File(["nope"], "x.heic", { type: "image/heic" }))).rejects.toThrow(
            "That photo could not be read"
        );
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo");
    });

    it("rejects when the canvas cannot produce a JPEG", async () => {
        stubImage({ width: 100, height: 100 });
        HTMLCanvasElement.prototype.toBlob.mockImplementation((callback) => callback(null));

        await expect(compressImage(new File(["x"], "x.png", { type: "image/png" }))).rejects.toThrow(
            "That photo could not be read"
        );
    });
});

describe("fitWithin", () => {
    it.each([
        [4000, 3000, 1600, 1200],
        [3000, 4000, 1200, 1600],
        [1600, 1000, 1600, 1000],
        [1601, 1000, 1600, 999],
        [800, 600, 800, 600],
    ])("%i x %i fits as %i x %i", (width, height, expectedWidth, expectedHeight) => {
        expect(fitWithin(width, height)).toEqual({ width: expectedWidth, height: expectedHeight });
    });
});

describe("dates", () => {
    afterEach(() => vi.useRealTimers());

    it("shows a calendar date as written, en-AU", () => {
        expect(formatDate("2026-11-02")).toBe("02 Nov 2026");
        expect(formatDate(null)).toBe("—");
    });

    it("shows a timestamp as its date and time in the shop's time zone", () => {
        // 01:30 UTC is 12:30 pm in Melbourne (UTC+11) on 2 Nov.
        expect(formatDate("2026-11-01T14:00:00Z")).toBe("02 Nov 2026");
        expect(formatDateTime("2026-11-02T01:30:00Z")).toMatch(/02 Nov 2026.*12:30/);
    });

    it("counts days from today's date in the shop's time zone", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-02T01:00:00Z"));

        expect(daysUntil("2026-11-02")).toBe(0);
        expect(daysUntil("2026-11-12")).toBe(10);
        expect(daysUntil("2026-11-01")).toBe(-1);
        expect(daysUntil(null)).toBeNull();
    });
});

describe("blobToDataURL", () => {
    it("reads a blob as a data URL", async () => {
        const url = await blobToDataURL(new Blob(["hi"], { type: "image/jpeg" }));

        expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    });
});
