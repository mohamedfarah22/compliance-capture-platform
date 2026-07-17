import { useState, useRef, useEffect } from 'react'
import { DayPicker } from 'react-day-picker'
import { format, parse, isValid } from 'date-fns'
import { Calendar } from 'lucide-react'
import 'react-day-picker/dist/style.css'
import styles from './DatePicker.module.css'

const formatValue = (value) => (value ? format(new Date(value + 'T00:00:00'), 'dd/MM/yyyy') : '')

const DatePicker = ({ id, onChange, placeholder = 'DD/MM/YYYY', value }) => {
  const [inputText, setInputText] = useState(() => formatValue(value))
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  if (value !== prevValue) {
    setPrevValue(value)
    setInputText(formatValue(value))
  }

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleInputChange = (e) => {
    const raw = e.target.value
    setInputText(raw)
    const parsed = parse(raw, 'dd/MM/yyyy', new Date())
    if (isValid(parsed) && raw.length === 10) {
      onChange(format(parsed, 'yyyy-MM-dd'))
    } else {
      onChange('')
    }
  }

  const handleDaySelect = (day) => {
    if (day) {
      onChange(format(day, 'yyyy-MM-dd'))
    }
    setOpen(false)
  }

  const selectedDate = value ? new Date(value + 'T00:00:00') : undefined

  return (
    <div ref={containerRef} className={styles.wrap}>
      <span className={styles.inputWrap}>
        <input
          id={id}
          type="text"
          className={styles.input}
          value={inputText}
          onChange={handleInputChange}
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          className={styles.calendarButton}
          onClick={() => setOpen((prev) => !prev)}
          aria-label="Open date picker"
          tabIndex={-1}
        >
          <Calendar aria-hidden="true" size={16} />
        </button>
      </span>
      {open ? (
        <div className={styles.popover}>
          <DayPicker mode="single" onSelect={handleDaySelect} selected={selectedDate} />
        </div>
      ) : null}
    </div>
  )
}

export default DatePicker
