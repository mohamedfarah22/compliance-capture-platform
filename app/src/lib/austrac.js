// AUSTRAC TTR-1-0 field mappings and utilities.
// Keys must match the enum values stored in the DB (from 20260621000003_enums.sql).

export const ID_TYPE_MAP = {
  'Driver licence':            'D',
  'Passport':                  'P',
  'Proof of age card':         'PHOT',
  'National identity card':    'PHOT',
  'Medicare card':             'BENE',
  'Other government document': 'PHOT',
  'Electronic verification source': 'ELEC',
}

export const BUSINESS_STRUCT_MAP = {
  'Company':     'C',
  'Partnership': 'P',
  'Trust':       'T',
  'Sole trader': 'I',
  'Association': 'A',
}

// BullionType enum — only these four are valid in TTR-1-0
export const BULLION_TYPE_MAP = {
  'Gold':      'GOLD',
  'Silver':    'SILVER',
  'Platinum':  'PLATINUM',
  'Palladium': 'PALLADIUM',
}

// Designated service codes for TTR-1-0
export const DESIGNATED_SERVICE_MAP = {
  'bullion_sell': 'BULSER',
  'bullion_buy':  'BULSER',
}

export const MAX_TRN_LENGTH    = 40
export const MAX_NAME_LENGTH   = 140
export const MAX_PHONE_LENGTH  = 20
export const MAX_SUBURB_LENGTH = 35

// Returns true if the metal type can be reported in AUSTRAC TTR-1-0
export function isBullionTypeReportable(metalType) {
  return Object.prototype.hasOwnProperty.call(BULLION_TYPE_MAP, metalType)
}

// Convert datetime-local or ISO string → YYYY-MM-DD (AUSTRAC Date type).
export function formatAUSTRACDate(iso) {
  return iso ? iso.slice(0, 10) : null
}

// Returns the AUSTRAC money flow model for a transaction (TTR-1-0 structure).
// scenario: 'bullion_sell' (RE sells bullion, receives cash) | 'bullion_buy' (RE buys bullion, pays cash)
export function deriveMoneyFlow({ scenario, cashAmount, cashCurrency, fxAmount, fxCode, bullionItems }) {
  const cash = cashCurrency === 'AUD'
    ? { ausCash: cashAmount }
    : { foreignCash: { amount: fxAmount, currency: fxCode, audEquivalent: cashAmount } }

  const bullionElements = (bullionItems ?? []).map(item => ({
    amount: item.line_total_aud,
    type: BULLION_TYPE_MAP[item.metal_type],
    description: item.description ?? null,
  }))

  return scenario === 'bullion_sell'
    ? {
        moneyReceived: { cash },
        moneyProvided: { otherMoneyProvided: { buo: bullionElements } },
        physicalCurrencyDirection: 'RECEIVED',
      }
    : {
        moneyReceived: { otherMoneyReceived: { bui: bullionElements } },
        moneyProvided: { cash },
        physicalCurrencyDirection: 'PROVIDED',
      }
}
