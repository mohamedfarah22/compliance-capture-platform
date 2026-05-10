import styles from './Button.module.css'

const Button = ({ children, variant = 'primary', className = '', type = 'button', ...props }) => {
  const classes = [styles.button, styles[variant], className].filter(Boolean).join(' ')

  return (
    <button className={classes} type={type} {...props}>
      {children}
    </button>
  )
}

export default Button
