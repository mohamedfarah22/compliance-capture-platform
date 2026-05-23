import WizardFrame from '../components/layout/WizardFrame.jsx'
import styles from './PlaceholderPage.module.css'

const PlaceholderPage = ({ description, title }) => {
  return (
    <WizardFrame title={title} subtitle={description}>
      <section className={styles.panel} aria-label={`${title} status`}>
        <p>Page conversion pending.</p>
      </section>
    </WizardFrame>
  )
}

export default PlaceholderPage
