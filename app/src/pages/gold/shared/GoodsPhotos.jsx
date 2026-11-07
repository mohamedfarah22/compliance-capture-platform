import Button from "../../../components/ui/Button.jsx";
import ImageField from "./ImageField.jsx";
import styles from "./GoodsPhotos.module.css";

export const MAX_GOODS_PHOTOS = 10;

// The goods photos of a purchase: a row of thumbnails with Remove, and one slot to add the next. value is a list of
// { blob, preview } where blob is always a JPEG of at most 1600 px (ImageField converts whatever it is given).
const GoodsPhotos = ({ label, value, onChange, error }) => {
    const isFull = value.length >= MAX_GOODS_PHOTOS;

    return (
        <div className={styles.photos}>
            {value.length > 0 ? (
                <ul className={styles.list}>
                    {value.map((photo, index) => (
                        <li key={photo.preview} className={styles.item}>
                            <img src={photo.preview} alt={`Goods photo ${index + 1}`} className={styles.thumb} />
                            <Button
                                variant="secondary"
                                aria-label={`Remove goods photo ${index + 1}`}
                                onClick={() => onChange(value.filter((_, i) => i !== index))}
                            >
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : null}
            {isFull ? (
                <p className={styles.full}>You can add up to {MAX_GOODS_PHOTOS} photos.</p>
            ) : (
                <ImageField
                    label={label}
                    value={null}
                    onChange={(photo) => onChange([...value, photo])}
                    error={error}
                />
            )}
        </div>
    );
};

export default GoodsPhotos;
