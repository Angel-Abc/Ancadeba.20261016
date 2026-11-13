import type { CombatEffectEventData, CombatTriggerEffect } from '@ancadeba/schemas'
import { applyCombatPercent } from './combatValues.js'

export type CombatInterceptionEffect = Extract<
  CombatTriggerEffect,
  { type: 'adjust-effect' | 'absorb-damage' | 'redirect-damage' | 'prevent-lethal' }
>

export interface CombatPendingEffect {
  readonly kind: 'damage' | 'healing'
  readonly data: CombatEffectEventData
  readonly healingCapacity?: number | undefined
  amount: number
  absorbed: number
  prevented: number
  redirectedAmount: number
  floor: number
  changed: boolean
  readonly redirects: { target: string; amount: number }[]
}

export interface CombatInterceptionContext {
  readonly health: Readonly<Record<string, number>>
  readonly resources: Readonly<Record<string, number>>
  spend(resource: string, amount: number): void
  actor(reference: string): string
}

export interface CombatInterceptionChange {
  readonly type: CombatInterceptionEffect['type']
  readonly before: number
  readonly after: number
  readonly resource?: string | undefined
  readonly spent?: number | undefined
  readonly redirectTarget?: string | undefined
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('Combat interception overflow')

  return value
}

export function combatPendingSnapshot(
  pending: CombatPendingEffect,
  health: Readonly<Record<string, number>>,
): CombatEffectEventData {
  return Object.freeze({
    ...pending.data,
    amount: pending.amount,
    incomingAmount: pending.data.amount,
    ...(pending.kind === 'damage'
      ? {
          absorbed: pending.absorbed,
          prevented: pending.prevented,
          redirectedAmount: pending.redirectedAmount,
          redirected: pending.data.redirected ?? false,
          lethal:
            pending.amount >= (health[pending.data.target] ?? 0) &&
            Boolean(health[pending.data.target]),
        }
      : { overheal: Math.max(0, pending.amount - (pending.healingCapacity ?? 0)) }),
  })
}

/** Changes only a private pending packet; notifications and HP changes remain owned by resolution. */
export function applyCombatInterception(
  pending: CombatPendingEffect,
  effect: CombatInterceptionEffect,
  context: CombatInterceptionContext,
): CombatInterceptionChange | undefined {
  const before = pending.amount
  const previousPrevented = pending.prevented
  let resource: string | undefined, spent: number | undefined, redirectTarget: string | undefined

  if (pending.kind === 'damage' && pending.data.immune) return

  if (effect.type === 'adjust-effect')
    pending.amount = applyCombatPercent(
      Math.max(0, safe(before + effect.amount)),
      effect.percent ?? 0,
    )
  else if (pending.kind !== 'damage') throw new Error('Damage interceptor used for healing')
  else if (effect.type === 'absorb-damage') {
    const available = context.resources[effect.resource]

    if (available === undefined) throw new Error('Unknown shield resource')
    spent = Math.min(before, available, effect.maximum ?? Number.MAX_SAFE_INTEGER)

    if (!spent) return
    resource = effect.resource
    context.spend(resource, spent)
    pending.amount -= spent
    pending.absorbed = safe(pending.absorbed + spent)
  } else if (effect.type === 'redirect-damage') {
    if (pending.data.redirected) return
    const target = context.actor(effect.actor)

    if (target === pending.data.target || !context.health[target]) return

    const amount = Math.min(
      applyCombatPercent(before, effect.percent - 100),
      effect.maximum ?? Number.MAX_SAFE_INTEGER,
    )

    if (!amount) return
    pending.amount -= amount
    pending.redirectedAmount = safe(pending.redirectedAmount + amount)
    pending.redirects.push({ target, amount })
    redirectTarget = target
  } else {
    const health = context.health[pending.data.target] ?? 0

    if (!health || pending.amount < health) return
    pending.floor = Math.max(pending.floor, Math.min(effect.minimumHealth, health))
  }

  if (pending.floor) {
    const maximum = Math.max(0, (context.health[pending.data.target] ?? 0) - pending.floor)
    const amount = Math.min(pending.amount, maximum)
    pending.prevented = safe(pending.prevented + pending.amount - amount)
    pending.amount = amount
  }

  if (before === pending.amount && previousPrevented === pending.prevented) return
  pending.changed = true

  return {
    type: effect.type,
    before,
    after: pending.amount,
    ...(resource ? { resource, spent } : {}),
    ...(redirectTarget ? { redirectTarget } : {}),
  }
}

export function combatInterceptionDetails(pending: CombatPendingEffect | undefined) {
  return pending?.changed
    ? {
        incomingAmount: pending.data.amount,
        ...(pending.kind === 'damage'
          ? {
              absorbed: pending.absorbed,
              prevented: pending.prevented,
              redirectedAmount: pending.redirectedAmount,
            }
          : {}),
      }
    : {}
}
