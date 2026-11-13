import type { CombatEffectEventData, CombatEventValue } from '@ancadeba/schemas'

/** Exact event-derived amounts, including signed resource changes. Missing context is an error. */
export function combatEventAmount(
  base: number,
  formula?: CombatEventValue,
  event?: CombatEffectEventData,
  signed = false,
): number {
  if (!Number.isSafeInteger(base)) throw new RangeError('Invalid combat reaction amount')

  if (!formula) return signed ? base : Math.max(0, base)
  const value = combatEffectEventValue(event, formula.field)

  if (value === undefined) throw new Error(`Combat event value unavailable: ${formula.field}`)

  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(Math.round(formula.factor * 100)) ||
    Math.abs(formula.factor * 100 - Math.round(formula.factor * 100)) > 1e-8
  )
    throw new RangeError('Invalid combat event value')
  let numerator = BigInt(base) * 100n + BigInt(value) * BigInt(Math.round(formula.factor * 100))

  if (!signed && numerator < 0n) numerator = 0n
  let result = numerator / 100n
  const remainder = numerator % 100n
  const rounding = formula.rounding ?? 'floor'

  if (rounding === 'floor' && remainder < 0n) result--

  if (rounding === 'ceil' && remainder > 0n) result++

  if (rounding === 'nearest' && remainder >= 50n) result++

  if (rounding === 'nearest' && remainder < -50n) result--

  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError('Combat reaction amount overflow')

  return Number(result)
}

/** Optional interception counters retain neutral values on effects that needed no interception. */
export function combatEffectEventValue(
  event: CombatEffectEventData | undefined,
  field: CombatEventValue['field'],
): number | undefined {
  if (!event) return

  if (field === 'incomingAmount')
    return (
      event.incomingAmount ??
      (event.typeAmount !== undefined ? event.typeAmount - (event.blocked ?? 0) : event.rawAmount)
    )

  if (field === 'absorbed' || field === 'prevented' || field === 'redirectedAmount')
    return event[field] ?? 0

  return event[field]
}
