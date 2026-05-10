import styles from './WizardFrame.module.css'

const WizardFrame = ({ actions, children, helperText, subtitle, title }) => {
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          {helperText ? <p className={styles.helper}>{helperText}</p> : null}
        </header>
        {children}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </main>
  )
}

export default WizardFrame
