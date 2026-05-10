import { ChevronLeft } from 'lucide-react'
import styles from './WizardFrame.module.css'

const WizardFrame = ({ actions, backLabel = 'Back', children, helperText, onBack, subtitle, title, wide }) => {
  return (
    <main className={styles.page}>
      <div className={[styles.container, wide ? styles.wide : ''].filter(Boolean).join(' ')}>
        {onBack ? (
          <button className={styles.back} type="button" onClick={onBack}>
            <ChevronLeft aria-hidden="true" size={16} />
            {backLabel}
          </button>
        ) : null}
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
