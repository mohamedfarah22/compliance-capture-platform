import { BUSINESS_TIMEZONE, businessDate } from "@gold-rules";

export const MAX_IMAGE_SIDE = 1600;
const JPEG_QUALITY = 0.82;
const DAY_MS = 86400000;

const dateFormat = new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIMEZONE,
});

// "2026-11-02" is a calendar date and is shown as written. A timestamp is shown as its date in the shop's time zone.
export const formatDate = (value) => {
    if (!value) return "—";
    const day = value.length === 10 ? value : businessDate(value);
    return dateFormat.format(new Date(`${day}T12:00:00`));
};

export const formatDateTime = (value) => (value ? dateTimeFormat.format(new Date(value)) : "—");

// Whole days from today (the shop's date) to a YYYY-MM-DD date. Negative once it has passed.
export const daysUntil = (iso) => {
    if (!iso) return null;
    const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
    return Math.round(dayNumber(iso) - dayNumber(businessDate()));
};

// Scale (width, height) down so the long side is at most maxSide. Never scales up.
export const fitWithin = (width, height, maxSide = MAX_IMAGE_SIDE) => {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

const UNREADABLE_PHOTO = "That photo could not be read. Take it again, or choose a JPEG.";

const loadImage = (source) =>
    new Promise((resolve, reject) => {
        const isUrl = typeof source === "string";
        const url = isUrl ? source : URL.createObjectURL(source);
        const release = () => {
            if (!isUrl) URL.revokeObjectURL(url);
        };
        const image = new Image();
        image.onload = () => {
            release();
            resolve(image);
        };
        image.onerror = () => {
            release();
            reject(new Error(UNREADABLE_PHOTO));
        };
        image.src = url;
    });

// Always returns a JPEG Blob of at most maxSide pixels on the long side, drawn in the browser. Accepts a
// File or Blob, a data URL, or a live <video>. A HEIC photo from an iPad or iPhone is decoded by the browser
// (Safari does) and re-encoded here; a browser that cannot decode it rejects, and the caller shows the message.
export const compressImage = async (source, { maxSide = MAX_IMAGE_SIDE, quality = JPEG_QUALITY } = {}) => {
    const isVideo = typeof source === "object" && "videoWidth" in source;
    const drawable = isVideo ? source : await loadImage(source);
    const { width, height } = fitWithin(
        isVideo ? source.videoWidth : drawable.width,
        isVideo ? source.videoHeight : drawable.height,
        maxSide
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(drawable, 0, 0, width, height);
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(UNREADABLE_PHOTO))), "image/jpeg", quality);
    });
};

export const blobToDataURL = (blob) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
