import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import Button from '../../components/ui/Button.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import styles from './TransactionCompletePage.module.css'

const TransactionCompletePage = () => {
  const navigate = useNavigate()
  const { state } = useLocation()

  useEffect(() => {
    if (!state?.transactionRef) navigate('/', { replace: true })
  }, [state, navigate])

  if (!state?.transactionRef) return null

  const { transactionRef, completedAt } = state
  const formattedDate = new Date(completedAt ?? Date.now()).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <WizardFrame
      title="Transaction Complete"
      subtitle="The transaction report has been successfully submitted."
      actions={<Button onClick={() => navigate('/')}>Start New Transaction</Button>}
    >
      <div className={styles.card}>
        <div className={styles.iconWrap}>
          <CheckCircle2 size={48} className={styles.icon} aria-hidden="true" />
        </div>
        <h2 className={styles.heading}>Report submitted</h2>
        <dl className={styles.details}>
          <div className={styles.row}>
            <dt>Transaction reference</dt>
            <dd>{transactionRef}</dd>
          </div>
          <div className={styles.row}>
            <dt>Completed at</dt>
            <dd>{formattedDate}</dd>
          </div>
        </dl>
      </div>
    </WizardFrame>
  )
}

export default TransactionCompletePage
