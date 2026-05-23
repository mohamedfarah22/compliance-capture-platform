import styles from './TextInput.module.css'

const TextInput = ({ icon, className = '', ...props }) => {
  const classes = [styles.input, icon ? styles.withIcon : '', className].filter(Boolean).join(' ')

  return (
    <span className={styles.wrap}>
      <input className={classes} {...props} />
      {icon ? <span className={styles.icon}>{icon}</span> : null}
    </span>
  )
}

export default TextInput
