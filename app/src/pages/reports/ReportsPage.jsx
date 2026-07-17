import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase.js'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import styles from './ReportsPage.module.css'

const STATUS_LABEL = {
  pending_review: 'Pending review',
  submitted: 'Submitted',
  rejected: 'Rejected',
}

const ReportsPage = () => {
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const load = async () => {
      const { data, error: err } = await supabase
        .schema('ttr')
        .from('report_batches')
        .select('id, report_date, transaction_count, status, generated_at, approval_token')
        .order('report_date', { ascending: false })

      if (err) setError(err.message)
      else setBatches(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  return (
    <WizardFrame title="AUSTRAC Reports" subtitle="Review and approve pending TTR-FBS report batches.">
      {loading ? (
        <p className={styles.state}>Loading…</p>
      ) : error ? (
        <p className={styles.error}>{error}</p>
      ) : batches.length === 0 ? (
        <p className={styles.state}>No report batches yet. Batches are generated automatically after close of business each weekday.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Report date</th>
                <th>Transactions</th>
                <th>Status</th>
                <th>Generated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.report_date}</td>
                  <td>{batch.transaction_count}</td>
                  <td>
                    <span className={`${styles.badge} ${styles[`badge_${batch.status}`] ?? ''}`}>
                      {STATUS_LABEL[batch.status] ?? batch.status}
                    </span>
                  </td>
                  <td>{new Date(batch.generated_at).toLocaleString('en-AU')}</td>
                  <td>
                    <Link
                      className={styles.action}
                      to={`/review-batch/${batch.id}?token=${batch.approval_token}`}
                    >
                      {batch.status === 'pending_review' ? 'Review' : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WizardFrame>
  )
}

export default ReportsPage
