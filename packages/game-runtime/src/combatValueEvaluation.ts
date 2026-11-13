import type { CombatScaling } from '@ancadeba/schemas'
import type { CombatValueContext } from './combatValues.js'

type Rounding = 'floor' | 'ceil' | 'nearest'

interface Fraction {
  numerator: bigint
  denominator: bigint
}

function integer(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError('Combat value exceeds the supported range')

  return BigInt(value)
}

function decimal(value: number): bigint {
  if (
    !Number.isFinite(value) ||
    Math.abs(value * 100 - Math.round(value * 100)) >
      Math.max(1e-8, Number.EPSILON * Math.abs(value * 100) * 2)
  )
    throw new RangeError('Invalid combat percentage or coefficient')

  return integer(Math.round(value * 100))
}

function finish(value: Fraction, rounding: Rounding, minimum = 0, maximum?: number): number {
  const lower = integer(minimum) * value.denominator
  const upper = integer(maximum ?? Number.MAX_SAFE_INTEGER) * value.denominator

  if (value.numerator < lower) {
    if (minimum === Number.MIN_SAFE_INTEGER) throw new RangeError('Combat value overflow')
    value = { ...value, numerator: lower }
  }

  if (value.numerator > upper) {
    if (maximum === undefined) throw new RangeError('Combat value overflow')
    value = { ...value, numerator: upper }
  }

  let result = value.numerator / value.denominator
  const remainder = value.numerator % value.denominator

  if (rounding === 'floor' && remainder < 0n) result--

  if (rounding === 'ceil' && remainder > 0n) result++

  if (rounding === 'nearest' && remainder * 2n >= value.denominator) result++

  if (rounding === 'nearest' && remainder * 2n < -value.denominator) result--

  return Number(result)
}

/** Exact rational evaluation, including resource percentages and fractional coefficients. */
export function evaluateCombatValue(
  base: number,
  scaling?: CombatScaling,
  context?: CombatValueContext,
  rounding: Rounding = 'floor',
  signed = false,
): number {
  integer(base)

  if (!scaling) return base

  if (!context) throw new Error('Dynamic combat value requires context')
  let sum: Fraction = { numerator: 0n, denominator: 1n }

  for (const term of scaling.terms) {
    let quantity: Fraction

    if (term.type === 'resource') {
      const current = context.resources[term.resource]

      if (current === undefined) throw new Error(`Scaling resource unavailable: ${term.resource}`)
      const maximum = context.resourceMaximums[term.resource]

      if (term.measure === 'percent') {
        if (maximum === undefined || maximum <= 0)
          throw new Error(`Scaling resource maximum unavailable: ${term.resource}`)
        quantity = { numerator: integer(current) * 100n, denominator: integer(maximum) }
      } else quantity = { numerator: integer(current), denominator: 1n }
    } else if (term.type === 'round') {
      if (context.round === undefined) throw new Error('Scaling round unavailable')
      quantity = { numerator: integer(context.round), denominator: 1n }
    } else {
      const actor =
        term.actor === 'self'
          ? context.self
          : term.actor === 'target'
            ? context.target
            : term.actor === 'event.source'
              ? context.event?.source
              : term.actor === 'event.target'
                ? context.event?.target
                : term.actor

      if (!actor) throw new Error('Scaling actor unavailable')

      if (term.type === 'status') {
        const active = context.statuses[actor]?.find((entry) => entry.id === term.status)
        quantity = {
          numerator: integer(active ? (active[term.measure ?? 'intensity'] ?? 1) : 0),
          denominator: 1n,
        }
      } else if (term.type === 'stat') {
        const value = context.stats?.[actor]?.[term.stat]

        if (value === undefined) throw new Error('Scaling stat unavailable')
        quantity = { numerator: integer(value), denominator: 1n }
      } else {
        const health = context.health?.[actor]
        const maximum = context.maximumHealth?.[actor]

        if (
          health === undefined ||
          ((term.type === 'missing-health' || term.measure === 'percent') &&
            (maximum === undefined || maximum <= 0))
        )
          throw new Error('Scaling health unavailable')
        const value = term.type === 'missing-health' ? Math.max(0, maximum! - health) : health
        quantity =
          term.measure === 'percent'
            ? { numerator: integer(value) * 100n, denominator: integer(maximum!) }
            : { numerator: integer(value), denominator: 1n }
      }
    }

    quantity = {
      numerator: quantity.numerator * decimal(term.factor),
      denominator: quantity.denominator * 100n,
    }
    sum = {
      numerator: sum.numerator * quantity.denominator + quantity.numerator * sum.denominator,
      denominator: sum.denominator * quantity.denominator,
    }
  }

  const value =
    scaling.mode === 'percent'
      ? {
          numerator: integer(base) * (sum.denominator * 100n + sum.numerator),
          denominator: sum.denominator * 100n,
        }
      : { numerator: integer(base) * sum.denominator + sum.numerator, denominator: sum.denominator }

  return finish(
    value,
    scaling.rounding ?? rounding,
    Math.max(
      signed ? Number.MIN_SAFE_INTEGER : 0,
      scaling.minimum ?? (signed ? Number.MIN_SAFE_INTEGER : 0),
    ),
    scaling.maximum === undefined
      ? undefined
      : Math.max(signed ? Number.MIN_SAFE_INTEGER : 0, scaling.maximum),
  )
}

export function applyCombatPercent(
  base: number,
  percent: number,
  rounding: Rounding = 'floor',
  maximum?: number,
): number {
  return finish(
    { numerator: integer(base) * (10000n + decimal(percent)), denominator: 10000n },
    rounding,
    0,
    maximum,
  )
}
