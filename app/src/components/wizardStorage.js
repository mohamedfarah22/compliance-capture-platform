export const wizardStorageKeys = {
  transaction: 'ttr.transaction',
  customers: 'ttr.customers',
  conductingPerson: 'ttr.conductingPerson',
  idVerification: 'ttr.idVerification',
  recipientDelivery: 'ttr.recipientDelivery',
  bullionDetails: 'ttr.bullionDetails',
}

export function readWizardData(key, fallback = null) {
  const rawValue = window.sessionStorage.getItem(key)

  if (!rawValue) {
    return fallback
  }

  try {
    return JSON.parse(rawValue)
  } catch {
    return fallback
  }
}

export function writeWizardData(key, value) {
  window.sessionStorage.setItem(key, JSON.stringify(value))
}

export function clearWizardData() {
  Object.values(wizardStorageKeys).forEach((key) => {
    window.sessionStorage.removeItem(key)
  })
}
