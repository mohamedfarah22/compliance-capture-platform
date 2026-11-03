import { useId, useRef, useState } from "react";
import Button from "../../../components/ui/Button.jsx";
import CameraCapture from "./CameraCapture.jsx";
import { blobToDataURL, compressImage } from "./format.js";
import styles from "./ImageField.module.css";

// One photo slot: take it with the camera or upload a file. value and onChange use { blob, preview }, where
// blob is always a JPEG of at most 1600 px (see compressImage) and preview is a data URL for the <img>.
const ImageField = ({ label, value, onChange, error }) => {
    const labelId = useId();
    const fileRef = useRef(null);
    const [isCameraOpen, setIsCameraOpen] = useState(false);
    const [readError, setReadError] = useState("");

    const accept = async (blobOrFile) => {
        try {
            const blob = await compressImage(blobOrFile);
            setReadError("");
            onChange({ blob, preview: await blobToDataURL(blob) });
        } catch (err) {
            setReadError(err.message);
        }
    };

    const handleFileChange = (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) accept(file);
    };

    const handleCapture = (blob) => {
        setIsCameraOpen(false);
        accept(blob);
    };

    const message = readError || error;

    return (
        <div role="group" aria-labelledby={labelId} className={styles.field}>
            <span id={labelId} className={styles.label}>
                {label}
            </span>
            <div className={`${styles.box} ${message ? styles.boxError : ""}`}>
                {value?.preview ? (
                    <img src={value.preview} alt={`${label} preview`} className={styles.preview} />
                ) : (
                    <div className={styles.empty}>No photo yet</div>
                )}
                <div className={styles.actions}>
                    <Button variant="secondary" onClick={() => setIsCameraOpen(true)}>
                        {value ? "Retake" : "Take photo"}
                    </Button>
                    <Button variant="secondary" onClick={() => fileRef.current.click()}>
                        Upload
                    </Button>
                </div>
            </div>
            {message ? (
                <p className={styles.error} role="alert">
                    {message}
                </p>
            ) : null}
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className={styles.fileInput}
                aria-label={`${label} file`}
                onChange={handleFileChange}
            />
            {isCameraOpen ? (
                <CameraCapture title={label} onCapture={handleCapture} onClose={() => setIsCameraOpen(false)} />
            ) : null}
        </div>
    );
};

export default ImageField;
