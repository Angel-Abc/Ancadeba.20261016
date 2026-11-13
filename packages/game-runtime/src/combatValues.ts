import type { CombatDefinition, CombatScaling, CombatMoveDefinition } from '@ancadeba/schemas'
import type { CombatStatuses } from './combatEffects.js'

export interface CombatValueContext {
  readonly resources: Readonly<Record<string, number>>
  readonly resourceMaximums: Readonly<Record<string, number>>
  readonly statuses: CombatStatuses
  readonly self: string
  readonly target?: string | undefined
}

export function combatValueContext(
  definition: CombatDefinition,
  resources: Readonly<Record<string, number>> | undefined,
  statuses: CombatStatuses,
  self: string,
  target?: string,
): CombatValueContext {
  return {
    resources:
      resources ??
      Object.fromEntries(
        Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
          id,
          resource.initial,
        ]),
      ),
    resourceMaximums: Object.fromEntries(
      Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
        id,
        resource.maximum,
      ]),
    ),
    statuses,
    self,
    target,
  }
}

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

  if (value.numerator < lower) value = { ...value, numerator: lower }

  if (value.numerator > upper) {
    if (maximum === undefined) throw new RangeError('Combat value overflow')
    value = { ...value, numerator: upper }
  }

  let result = value.numerator / value.denominator
  const remainder = value.numerator % value.denominator

  if (
    remainder > 0n &&
    (rounding === 'ceil' || (rounding === 'nearest' && remainder * 2n >= value.denominator))
  )
    result++

  return Number(result)
}

/** Exact rational evaluation, including resource percentages and fractional coefficients. */
export function evaluateCombatValue(
  base: number,
  scaling?: CombatScaling,
  context?: CombatValueContext,
  rounding: Rounding = 'floor',
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
    } else {
      const actor =
        term.actor === 'self' ? context.self : term.actor === 'target' ? context.target : term.actor

      if (!actor) throw new Error('Scaling actor unavailable')
      const active = context.statuses[actor]?.find((entry) => entry.id === term.status)
      quantity = {
        numerator: integer(active ? (active[term.measure ?? 'intensity'] ?? 1) : 0),
        denominator: 1n,
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

  return finish(value, scaling.rounding ?? rounding, scaling.minimum, scaling.maximum)
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

export function combatResourceCosts(
  move: CombatMoveDefinition,
  context?: CombatValueContext,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(move.resourceCosts ?? {}).map(([id, base]) => [
      id,
      evaluateCombatValue(base, move.resourceCostScaling?.[id], context, 'ceil'),
    ]),
  )
}
