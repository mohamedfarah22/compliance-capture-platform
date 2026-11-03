import { useEffect, useRef, useState } from "react";
import Button from "../../../components/ui/Button.jsx";
import { compressImage } from "./format.js";
import styles from "./CameraCapture.module.css";

const CAMERA_UNAVAILABLE =
    "The camera is unavailable. Check it is connected and that this site is allowed to use it, or close this and choose Upload.";

// Camera modal: a live preview, and "Take photo" grabs one frame. onCapture always receives a JPEG Blob of at
// most 1600 px on the long side. Camera access needs HTTPS (or localhost).
const CameraCapture = ({ title, onCapture, onClose }) => {
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const [error, setError] = useState("");
    const [isReady, setIsReady] = useState(false);
    const [isBusy, setIsBusy] = useState(false);

    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const opener = document.activeElement;
        let isCancelled = false;

        const start = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
                    audio: false,
                });
                if (isCancelled) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }
                streamRef.current = stream;
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
                setIsReady(true);
            } catch {
                if (!isCancelled) setError(CAMERA_UNAVAILABLE);
            }
        };
        start();

        const handleKeyDown = (e) => {
            if (e.key === "Escape") onCloseRef.current();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            isCancelled = true;
            window.removeEventListener("keydown", handleKeyDown);
            streamRef.current?.getTracks().forEach((track) => track.stop());
            opener?.focus?.();
        };
    }, []);

    const handleTake = async () => {
        setIsBusy(true);
        try {
            onCapture(await compressImage(videoRef.current));
        } catch (err) {
            setError(err.message);
            setIsBusy(false);
        }
    };

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={title}>
            <div className={styles.modal}>
                <h2 className={styles.title}>{title}</h2>
                {error ? (
                    <p className={styles.error} role="alert">
                        {error}
                    </p>
                ) : (
                    <div className={styles.viewfinder}>
                        <video ref={videoRef} playsInline muted className={styles.video} />
                        <div className={styles.guide} />
                    </div>
                )}
                <p className={styles.hint}>Fill the frame, avoid glare, and make sure every character is readable.</p>
                <div className={styles.actions}>
                    <Button variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={handleTake} disabled={!isReady || isBusy}>
                        Take photo
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default CameraCapture;
