import styles from './ChoiceCard.module.css'

const ChoiceCard = ({ checked, description, label, name, onChange, value }) => {
  return (
    <label className={`${styles.card} ${checked ? styles.selected : ''}`}>
      <input
        checked={checked}
        className={styles.input}
        name={name}
        onChange={onChange}
        type="radio"
        value={value}
      />
      <span className={styles.content}>
        <span className={styles.title}>{label}</span>
        <span className={styles.description}>{description}</span>
      </span>
    </label>
  )
}

export default ChoiceCard
