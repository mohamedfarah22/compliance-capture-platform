import { useEffect } from "react";
import Button from "../../../components/ui/Button.jsx";
import CustomerPicker from "./CustomerPicker.jsx";
import styles from "./JointSellerPanel.module.css";

// Modal for choosing the second person in a joint sale. Escape or a click on the backdrop closes it. The caller
// puts the focus back on its "Add second person" button when onClose runs.
const JointSellerPanel = ({ mainCustomer, onPick, onNew, onClose }) => {
    useEffect(() => {
        const handleKeyDown = (e) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    return (
        <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div role="dialog" aria-modal="true" aria-labelledby="joint-title" className={styles.dialog}>
                <div className={styles.header}>
                    <h2 id="joint-title" className={styles.title}>
                        Add second person
                    </h2>
                    <Button variant="secondary" onClick={onClose}>
                        Close
                    </Button>
                </div>
                <p className={styles.text}>
                    Find the second seller, or create them as a new customer. The purchase details you entered for{" "}
                    {mainCustomer.full_name} are kept.
                </p>
                <CustomerPicker
                    inputId="joint-q"
                    onPick={onPick}
                    onNew={onNew}
                    newLabel="New customer"
                    excludeId={mainCustomer.id}
                    excludeNote="Already the main seller"
                />
            </div>
        </div>
    );
};

export default JointSellerPanel;
