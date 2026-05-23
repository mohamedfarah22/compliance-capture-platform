import styles from './FormField.module.css'

const FormField = ({ children, error, helperText, label, labelFor }) => {
  return (
    <div className={styles.field}>
      {label ? (
        <label className={styles.label} htmlFor={labelFor}>
          {label}
        </label>
      ) : null}
      {children}
      {helperText ? <p className={styles.helper}>{helperText}</p> : null}
      {error !== undefined ? <p className={styles.error}>{error}</p> : null}
    </div>
  )
}

export default FormField
