import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import { supabase } from '../../lib/supabase.js'
import Button from '../../components/ui/Button.jsx'
import WizardFrame from '../../components/layout/WizardFrame.jsx'
import styles from './ReviewBatchPage.module.css'

const STATUS_LABEL = {
  pending_review: 'Pending review',
  submitted: 'Submitted',
  rejected: 'Rejected',
}

const SCENARIO_LABEL = {
  bullion_sell: 'Sell bullion',
  bullion_buy: 'Buy bullion',
  precious_metal_sell: 'Sell precious metal',
  precious_metal_buy: 'Buy precious metal',
}

const ReviewBatchPage = () => {
  const { batchId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const { session } = useAuth()
  const navigate = useNavigate()

  const [batch, setBatch] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [actionDone, setActionDone] = useState(null) // 'submit' | 'reject'

  useEffect(() => {
    const load = async () => {
      const { data: batchData, error: batchErr } = await supabase
        .schema('ttr')
        .from('report_batches')
        .select('id, report_date, transaction_count, status, generated_at, approval_token')
        .eq('id', batchId)
        .single()

      if (batchErr) {
        setError(batchErr.message)
        setLoading(false)
        return
      }
      setBatch(batchData)

      const { data: txLinks } = await supabase
        .schema('ttr')
        .from('transaction_reports')
        .select('transactions!inner(id, transaction_ref, transaction_datetime, aud_value, scenario)')
        .eq('batch_id', batchId)

      setTransactions((txLinks ?? []).map((r) => r.transactions))
      setLoading(false)
    }
    load()
  }, [batchId])

  // Fetched on demand rather than loaded with the batch: the XML holds the same
  // personal information as the underlying records, so it reaches the browser
  // only when actually exported — and that export is logged server-side.
  const handleDownload = async () => {
    if (!session) return
    setDownloading(true)
    setError(null)
    try {
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/approve-batch`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ batchId, token, action: 'download' }),
        },
      )
      const result = await resp.json()
      if (!resp.ok) {
        setError(result.error ?? 'Download failed')
        return
      }
      const blob = new Blob([result.xmlContent], { type: 'application/xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.fileName
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloading(false)
    }
  }

  const handleAction = async (action) => {
    if (!session) return
    setSubmitting(true)
    setError(null)
    try {
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/approve-batch`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ batchId, token, action }),
        },
      )
      const result = await resp.json()
      if (!resp.ok) {
        setError(result.error ?? 'Action failed')
      } else if (action === 'regenerate') {
        navigate(`/review-batch/${result.newBatch.id}?token=${result.newBatch.approvalToken}`)
      } else {
        setActionDone(action)
        setBatch((prev) => ({
          ...prev,
          status: action === 'submit' ? 'submitted' : 'rejected',
        }))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <WizardFrame title="Review Report Batch" subtitle="Loading…">
        <p className={styles.state}>Loading…</p>
      </WizardFrame>
    )
  }

  if (!batch) {
    return (
      <WizardFrame title="Review Report Batch" subtitle="Batch not found.">
        <p className={styles.state}>Report batch not found.</p>
      </WizardFrame>
    )
  }

  const tokenValid = Boolean(token && token === batch.approval_token)
  const isPending = batch.status === 'pending_review'
  const canRegenerate = batch.status !== 'submitted'
  const txCount = batch.transaction_count

  return (
    <WizardFrame
      title={`TTR-FBS Report — ${batch.report_date}`}
      subtitle={`${txCount} transaction${txCount !== 1 ? 's' : ''} · ${STATUS_LABEL[batch.status] ?? batch.status}`}
    >
      {actionDone && (
        <p className={styles.success}>
          {actionDone === 'submit'
            ? 'Report marked as submitted to AUSTRAC. Download the XML and upload it via AUSTRAC Online.'
            : 'Report rejected.'}
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {!tokenValid && canRegenerate && (
        <p className={styles.warning}>
          This page is view-only. Open the link from the approval email to enable approve/reject/regenerate actions.
        </p>
      )}

      <div className={styles.batchActions}>
        <Button disabled={downloading} onClick={handleDownload} variant="secondary">
          {downloading ? 'Preparing…' : 'Download XML'}
        </Button>
        {isPending && (
          <>
            <Button
              disabled={!tokenValid || submitting}
              onClick={() => handleAction('submit')}
            >
              {submitting ? 'Saving…' : 'Approve & mark submitted'}
            </Button>
            <Button
              disabled={!tokenValid || submitting}
              variant="secondary"
              onClick={() => handleAction('reject')}
            >
              Reject
            </Button>
          </>
        )}
        {canRegenerate && (
          <Button
            disabled={!tokenValid || submitting}
            variant="secondary"
            onClick={() => handleAction('regenerate')}
          >
            {submitting ? 'Regenerating…' : 'Regenerate'}
          </Button>
        )}
      </div>

      <h3 className={styles.sectionHeading}>
        Transactions in this batch
      </h3>

      {transactions.length === 0 ? (
        <p className={styles.state}>No transactions found.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Date / time</th>
                <th>AUD value</th>
                <th>Scenario</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.transaction_ref}</td>
                  <td>{new Date(tx.transaction_datetime).toLocaleString('en-AU')}</td>
                  <td className={styles.amount}>
                    ${Number(tx.aud_value).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                  </td>
                  <td>{SCENARIO_LABEL[tx.scenario] || tx.scenario}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WizardFrame>
  )
}

export default ReviewBatchPage
