import { useEffect, useRef } from "react";
import styles from "./Lightbox.module.css";

// One image (src + alt), or several side by side (images: [{ src, alt }]). Escape, the Close button or a click
// outside the picture closes it, and the focus goes back to what opened it.
const Lightbox = ({ src, alt, images, onClose }) => {
    const closeRef = useRef(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const opener = document.activeElement;
        closeRef.current?.focus();
        const handleKeyDown = (e) => {
            if (e.key === "Escape") onCloseRef.current();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            opener?.focus?.();
        };
    }, []);

    const list = (images ?? [{ src, alt }]).filter((image) => image.src);
    if (list.length === 0) return null;

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose}>
            {/* The click reaches the overlay, which closes. */}
            <button ref={closeRef} type="button" className={styles.close}>
                Close
            </button>
            <div className={list.length > 1 ? styles.pair : styles.single}>
                {list.map((image) => (
                    <figure key={image.alt} className={styles.figure}>
                        <img src={image.src} alt={image.alt} className={styles.image} />
                        {list.length > 1 ? <figcaption className={styles.caption}>{image.alt}</figcaption> : null}
                    </figure>
                ))}
            </div>
        </div>
    );
};

export default Lightbox;
