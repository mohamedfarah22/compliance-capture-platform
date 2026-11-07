// TEST ONLY: sample data for the "Fill with test data" buttons. Gated by import.meta.env.DEV, which is false in
// `npm run build`, so the buttons and this code are left out of production.
import { blobToDataURL } from "./format.js";

export const DEV_FILL = import.meta.env.DEV;

const randomDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const FIRST_NAMES = ["Alex", "Sam", "Chris", "Jordan", "Taylor", "Morgan"];

// Random ID number and phone, so the duplicate prompts do not fire. The ID expires three years from today.
export const sampleIdDetails = () => {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 3);
    return {
        documentType: "Driver licence",
        documentNumber: randomDigits(9),
        issuer: "VIC",
        idCountryCode: "AU",
        hasExpiry: true,
        expiryDate: expiry.toISOString().slice(0, 10),
    };
};

export const samplePerson = () => ({
    firstName: FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)],
    middleName: "",
    lastName: `Test${randomDigits(4)}`,
    dateOfBirth: "1985-06-15",
    phone: `04${randomDigits(2)} ${randomDigits(3)} ${randomDigits(3)}`,
    street: "1 Test Street",
    suburb: "Coburg",
    state: "VIC",
    postcode: "3058",
    ...sampleIdDetails(),
});

/** A labelled grey test photo in the same { blob, preview } shape as a real one. */
export const sampleImage = async (label) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 500;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e5e7eb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#6b7280";
    context.font = "40px sans-serif";
    context.textAlign = "center";
    context.fillText(`TEST - ${label}`, canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    return { blob, preview: await blobToDataURL(blob) };
};

export const sampleInvoice = () => `TEST-${randomDigits(5)}`;
