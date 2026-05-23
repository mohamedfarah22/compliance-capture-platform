import Button from './Button.jsx'
import styles from './ConfirmModal.module.css'

const ConfirmModal = ({ isOpen, onCancel, onConfirm }) => {
  if (!isOpen) return null

  return (
    <div className={styles.overlay}>
      <div
        aria-labelledby="confirm-modal-title"
        aria-modal="true"
        className={styles.modal}
        role="dialog"
      >
        <h2 className={styles.title} id="confirm-modal-title">
          Exit transaction?
        </h2>
        <p className={styles.body}>
          Any unsaved data will be lost.
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Exit</Button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmModal
