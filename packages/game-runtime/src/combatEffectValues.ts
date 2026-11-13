import {
  cloneCombatRules,
  combatNumericValue,
  type CombatEffectValueScaling,
} from '@ancadeba/schemas'
import { evaluateCombatValue } from './combatValueEvaluation.js'
import type { CombatValueContext } from './combatValues.js'
import type { ActiveCombatStatus } from './combatEffects.js'

/** Evaluate authored numeric payloads against one immutable context, without changing definitions. */
export function resolveCombatEffectValues<
  T extends { valueScaling?: CombatEffectValueScaling | undefined },
>(value: T, context?: CombatValueContext): T {
  if (!value.valueScaling || !Object.keys(value.valueScaling).length) return value
  const result = cloneCombatRules(value)

  for (const [path, scaling] of Object.entries(value.valueScaling)) {
    const base = combatNumericValue(value, path)

    if (base === undefined) throw new Error(`Scaling numeric effect unavailable: ${path}`)

    const signed =
      (path === 'amount' &&
        'type' in value &&
        (value.type === 'change-resource' || value.type === 'adjust-effect')) ||
      path.startsWith('modifiers.') ||
      path.startsWith('percentModifiers.') ||
      path === 'percent'

    const percent =
      path === 'percent' ||
      path.startsWith('percentModifiers.') ||
      path.startsWith('damageDefenses.')

    // Percent payloads retain hundredths; formula coefficients still describe ordinary percentage points.
    const evaluated = percent
      ? evaluateCombatValue(
          Math.round(base * 100),
          {
            ...scaling,
            terms: scaling.terms.map((term) => ({
              ...term,
              factor: scaling.mode === 'percent' ? term.factor : term.factor * 100,
            })),
            ...(scaling.minimum === undefined ? {} : { minimum: scaling.minimum * 100 }),
            ...(scaling.maximum === undefined ? {} : { maximum: scaling.maximum * 100 }),
          },
          context,
          'floor',
          signed,
        ) / 100
      : evaluateCombatValue(base, scaling, context, 'floor', signed)

    let next = evaluated

    if (path === 'percent')
      next = Math.max(
        'type' in value && value.type === 'redirect-damage' ? 0 : -100,
        Math.min('type' in value && value.type === 'redirect-damage' ? 100 : 1000, next),
      )

    if (path === 'minimumHealth') next = Math.max(1, next)

    if (path === 'stacks' || path === 'intensity') next = Math.max(0, Math.min(100, next))

    if (path === 'duration') next = Math.max(1, Math.min(1000, next))
    const keys = path.split('.')
    let parent: unknown = result

    for (const key of keys.slice(0, -1))
      parent =
        parent && typeof parent === 'object'
          ? Object.getOwnPropertyDescriptor(parent, key)?.value
          : undefined

    if (!parent || typeof parent !== 'object') throw new Error('Invalid numeric effect path')
    Object.defineProperty(parent, keys.at(-1)!, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  const minimum = combatNumericValue(result, 'damage.min'),
    maximum = combatNumericValue(result, 'damage.max')

  if (minimum !== undefined && maximum !== undefined && minimum > maximum)
    throw new Error('Scaled damage range is invalid')

  return result
}

/** Status inputs use the applier as self and recipient as target. Stat inputs are pre-status to avoid cycles. */
export function resolveCombatStatusValues<
  T extends { valueScaling?: CombatEffectValueScaling | undefined },
>(status: T, active: ActiveCombatStatus, owner: string, context?: CombatValueContext): T {
  return resolveCombatEffectValues(
    status,
    context
      ? {
          ...context,
          self: active.source,
          target: owner,
          stats: context.baseStats ?? context.stats,
        }
      : undefined,
  )
}
