import { ChevronLeft, LogOut } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import Button from '../ui/Button.jsx'
import styles from './WizardFrame.module.css'

const WizardFrame = ({ actions, backLabel = 'Back', children, exitLabel = 'Exit', helperText, onBack, onExit, subtitle, title, wide }) => {
  const { staffMember, canApproveReports, signOut } = useAuth()

  return (
    <main className={styles.page}>
      <div className={styles.topBar}>
        <span className={styles.topBarUser}>{staffMember?.full_name ?? ''}</span>
        <div className={styles.topBarActions}>
          {canApproveReports ? (
            <Link className={styles.reportsLink} to="/reports">Reports</Link>
          ) : null}
          <button className={styles.signOut} onClick={signOut} title="Sign out" type="button">
            <LogOut aria-hidden="true" size={15} />
            Sign out
          </button>
        </div>
      </div>
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
        {(actions || onExit) ? (
          <div className={styles.actions}>
            {onExit ? (
              <Button variant="secondary" onClick={onExit}>{exitLabel}</Button>
            ) : null}
            <div className={styles.actionsRight}>{actions}</div>
          </div>
        ) : null}
      </div>
    </main>
  )
}

export default WizardFrame
