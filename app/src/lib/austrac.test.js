import { describe, it, expect } from 'vitest'
import { deriveMoneyFlow } from './austrac.js'

const bullionItem = (overrides = {}) => ({
  metal_type: 'Gold',
  line_total_aud: 1000,
  description: null,
  ...overrides,
})

const preciousMetalItem = (overrides = {}) => ({
  metal_type: 'Gold',
  line_total_aud: 1000,
  description: null,
  serial_number: null,
  ...overrides,
})

describe('deriveMoneyFlow — bullion', () => {
  it('"Sell bullion to customer" scenario maps cash to moneyReceived.cash and bullion aggregate to moneyProvided.otherMoneyProvided.buo', () => {
    const result = deriveMoneyFlow({
      scenario: 'bullion_sell',
      cashAmount: 15000,
      cashCurrency: 'AUD',
      bullionItems: [bullionItem()],
    })

    expect(result.moneyReceived).toEqual({ cash: { ausCash: 15000 } })
    expect(result.moneyProvided.otherMoneyProvided.buo).toEqual([
      { amount: 1000, type: 'GOLD', description: null },
    ])
  })

  it('"Buy bullion from customer" scenario maps bullion to moneyReceived.otherMoneyReceived.bui and cash to moneyProvided.cash', () => {
    const result = deriveMoneyFlow({
      scenario: 'bullion_buy',
      cashAmount: 15000,
      cashCurrency: 'AUD',
      bullionItems: [bullionItem()],
    })

    expect(result.moneyReceived.otherMoneyReceived.bui).toEqual([
      { amount: 1000, type: 'GOLD', description: null },
    ])
    expect(result.moneyProvided).toEqual({ cash: { ausCash: 15000 } })
  })

  it('aggregate AUD value in buo or bui equals the sum of all bullion line item totals', () => {
    const items = [bullionItem({ line_total_aud: 1000 }), bullionItem({ metal_type: 'Silver', line_total_aud: 250 })]

    const sellResult = deriveMoneyFlow({ scenario: 'bullion_sell', cashAmount: 1250, cashCurrency: 'AUD', bullionItems: items })
    const buoTotal = sellResult.moneyProvided.otherMoneyProvided.buo.reduce((sum, el) => sum + el.amount, 0)
    expect(buoTotal).toBe(1250)

    const buyResult = deriveMoneyFlow({ scenario: 'bullion_buy', cashAmount: 1250, cashCurrency: 'AUD', bullionItems: items })
    const buiTotal = buyResult.moneyReceived.otherMoneyReceived.bui.reduce((sum, el) => sum + el.amount, 0)
    expect(buiTotal).toBe(1250)
  })

  it('reported buo amount equals quantity × weight × unitPrice for a bullion item (medium: TC-236)', () => {
    const quantity = 2
    const weight = 5
    const unitPrice = 10
    const lineTotal = quantity * weight * unitPrice

    const result = deriveMoneyFlow({
      scenario: 'bullion_sell',
      cashAmount: lineTotal,
      cashCurrency: 'AUD',
      bullionItems: [bullionItem({ line_total_aud: lineTotal })],
    })

    expect(result.moneyProvided.otherMoneyProvided.buo[0].amount).toBe(quantity * weight * unitPrice)
  })
})

describe('deriveMoneyFlow — precious metal', () => {
  it('"Sell precious metal to customer" scenario maps cash to moneyReceived.cash and precious metal aggregate to moneyProvided.otherMoneyProvided.pmo', () => {
    const result = deriveMoneyFlow({
      scenario: 'precious_metal_sell',
      cashAmount: 15000,
      cashCurrency: 'AUD',
      preciousMetalItems: [preciousMetalItem()],
    })

    expect(result.moneyReceived).toEqual({ cash: { ausCash: 15000 } })
    expect(result.moneyProvided.otherMoneyProvided.pmo).toEqual([
      { amount: 1000, metal: 'GOLD', description: null, serialNumber: null },
    ])
  })

  it('"Buy precious metal from customer" scenario maps precious metal to moneyReceived.otherMoneyReceived.pmi and cash to moneyProvided.cash', () => {
    const result = deriveMoneyFlow({
      scenario: 'precious_metal_buy',
      cashAmount: 15000,
      cashCurrency: 'AUD',
      preciousMetalItems: [preciousMetalItem()],
    })

    expect(result.moneyReceived.otherMoneyReceived.pmi).toEqual([
      { amount: 1000, metal: 'GOLD', description: null, serialNumber: null },
    ])
    expect(result.moneyProvided).toEqual({ cash: { ausCash: 15000 } })
  })

  it('pmo/pmi use "metal" — not "type" — for the metal code, matching the PRECIOUS_METAL_TYPE_MAP used during report generation', () => {
    const result = deriveMoneyFlow({
      scenario: 'precious_metal_sell',
      cashAmount: 1000,
      cashCurrency: 'AUD',
      preciousMetalItems: [preciousMetalItem({ metal_type: 'Alloy' })],
    })

    const [element] = result.moneyProvided.otherMoneyProvided.pmo
    expect(element).toHaveProperty('metal', 'ALLOY')
    expect(element).not.toHaveProperty('type')
  })

  it('aggregate AUD value in pmo or pmi equals the sum of all precious metal line item totals', () => {
    const items = [preciousMetalItem({ line_total_aud: 1000 }), preciousMetalItem({ metal_type: 'Silver', line_total_aud: 250 })]

    const sellResult = deriveMoneyFlow({ scenario: 'precious_metal_sell', cashAmount: 1250, cashCurrency: 'AUD', preciousMetalItems: items })
    const pmoTotal = sellResult.moneyProvided.otherMoneyProvided.pmo.reduce((sum, el) => sum + el.amount, 0)
    expect(pmoTotal).toBe(1250)

    const buyResult = deriveMoneyFlow({ scenario: 'precious_metal_buy', cashAmount: 1250, cashCurrency: 'AUD', preciousMetalItems: items })
    const pmiTotal = buyResult.moneyReceived.otherMoneyReceived.pmi.reduce((sum, el) => sum + el.amount, 0)
    expect(pmiTotal).toBe(1250)
  })
})
