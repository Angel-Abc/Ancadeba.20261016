import type { CombatDefinition, CombatBonuses, AbilityEffect } from '@ancadeba/schemas'
import { TurnCoordinator } from './turnCoordinator.js'
import {
  combatMoveTarget,
  combatStunned,
  cooldownRemaining,
  statusContributions,
  temporaryCombatStats,
  type ActiveCombatStatus,
  type CombatStatuses,
  type CombatCooldowns,
} from './combatEffects.js'

export type CombatOutcome = 'victory' | 'defeat' | 'escaped'

export interface PlannedMove {
  readonly item?: string | undefined
  readonly itemType?: string | undefined
  readonly consume?: boolean | undefined
  readonly move: string
  readonly target: string
}

export interface CombatLogEntry {
  readonly type:
    | 'itemUsed'
    | 'itemSkipped'
    | 'attack'
    | 'guarded'
    | 'skipped'
    | 'healed'
    | 'statusApplied'
    | 'statusRefreshed'
    | 'statusRemoved'
    | 'statusExpired'
    | 'periodicDamage'
    | 'regenerated'
    | 'stunned'
    | CombatOutcome
  readonly item?: string | undefined
  readonly actor?: string
  readonly target?: string
  readonly damage?: number
  readonly blocked?: number
  readonly defended?: number
  readonly guard?: number
  readonly status?: string
  readonly amount?: number
  readonly duration?: number
}

export interface EnemyPlan {
  readonly moves: readonly PlannedMove[]
  readonly cursor: number
  readonly startCursor?: number
}

export function planEnemies(
  definition: CombatDefinition,
  health: Readonly<Record<string, number>>,
  cursors: Readonly<Record<string, number>>,
  round = 1,
  statuses: CombatStatuses = {},
  cooldowns: CombatCooldowns = {},
): Record<string, EnemyPlan> {
  return Object.fromEntries(
    definition.enemies.map((actor) => {
      let cursor = cursors[actor.id] ?? 0
      const startCursor = cursor
      let ap = actor.ap
      const moves: PlannedMove[] = []
      const reserved = new Set<string>()

      if (health[actor.id]! > 0 && !combatStunned(definition, statuses[actor.id]))
        while (ap > 0) {
          let found = false

          for (let index = 0; index < actor.rotation.length; index++) {
            const position = (cursor + index) % actor.rotation.length
            const id = actor.rotation[position]!
            const move = definition.moves[id]!

            if (
              move.apCost > ap ||
              cooldownRemaining(cooldowns, actor.id, id, round) ||
              reserved.has(id)
            )
              continue
            moves.push({
              move: id,
              target: combatMoveTarget(move) === 'self' ? actor.id : definition.player.id,
            })
            ap -= move.apCost

            if (move.cooldown) reserved.add(id)
            cursor = (position + 1) % actor.rotation.length
            found = true
            break
          }

          if (!found) break
        }

      return [actor.id, { moves, cursor, ...(definition.statuses ? { startCursor } : {}) }]
    }),
  )
}

export function combatOutcome(
  definition: CombatDefinition,
  health: Readonly<Record<string, number>>,
): CombatOutcome | undefined {
  return health[definition.player.id] === 0
    ? 'defeat'
    : definition.enemies.every((actor) => health[actor.id] === 0)
      ? 'victory'
      : undefined
}

const safe = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Combat calculation exceeds the supported range')

  return value
}

/** Pure candidate simulation: no RNG, timers, or effects escape a rejected round. */
export function resolveCombatRound(
  definition: CombatDefinition,
  current: {
    health: Readonly<Record<string, number>>
    guard: Readonly<Record<string, number>>
    seed: number
    plan: readonly PlannedMove[]
    enemies: Readonly<Record<string, EnemyPlan>>
    escape: boolean
    stats?: Readonly<Record<string, Readonly<CombatBonuses>>> | undefined
    maximumHealth?: Readonly<Record<string, number>> | undefined
    statuses?: CombatStatuses | undefined
    cooldowns?: CombatCooldowns | undefined
    round?: number | undefined
  },
) {
  const health = { ...current.health },
    guard = { ...current.guard }

  const statuses: Record<string, ActiveCombatStatus[]> = Object.fromEntries(
    Object.entries(current.statuses ?? {}).map(([id, effects]) => [
      id,
      effects.map((effect) => ({ ...effect })),
    ]),
  )

  const cooldowns: Record<string, Record<string, number>> = Object.fromEntries(
    Object.entries(current.cooldowns ?? {}).map(([id, moves]) => [id, { ...moves }]),
  )

  const entries: CombatLogEntry[] = []
  const usedItems: string[] = []
  const round = current.round ?? 1

  const cursors = Object.fromEntries(
    Object.entries(current.enemies).map(([id, plan]) => [id, plan.startCursor ?? plan.cursor]),
  )

  let seed = current.seed
  let outcome = combatOutcome(definition, health)

  if (!outcome && current.escape) outcome = 'escaped'

  const finish = () => ({
    health,
    guard,
    seed,
    usedItems,
    entries,
    outcome,
    statuses: outcome ? {} : statuses,
    cooldowns: outcome ? {} : cooldowns,
    cursors,
  })

  if (outcome) {
    entries.push({ type: outcome })

    return finish()
  }

  const actors = [definition.player, ...definition.enemies].filter((actor) => health[actor.id]! > 0)

  const coordinator = new TurnCoordinator(
    {
      actors: actors.map((actor) => actor.id),
      phases: ['resolution'],
      actionPolicies: new Map([['resolve', { scope: 'actor' }]]),
    },
    ['resolve'],
  )

  const stats = (id: string) =>
    temporaryCombatStats(current.stats?.[id], statusContributions(definition, statuses[id] ?? []))

  const heal = (
    actor: string,
    target: string,
    amount: number,
    type: 'healed' | 'regenerated',
    status?: string,
  ) => {
    if (!health[target]) return
    const authored = actors.find((actor) => actor.id === target)?.maximumHealth

    const maximum =
      current.maximumHealth?.[target] ??
      current.stats?.[target]?.maximumHealth ??
      (typeof authored === 'number' ? authored : undefined)

    if (maximum === undefined || maximum < health[target]!)
      throw new RangeError('Healing requires a valid maximum health')
    const restored = Math.min(amount, maximum - health[target]!)
    health[target] = safe(health[target]! + restored)
    entries.push({ type, actor, target, amount: restored, ...(status ? { status } : {}) })
  }

  const attack = (actor: string, target: string, range: { min: number; max: number }) => {
    const bonus = stats(actor).attack

    const min = safe(range.min + bonus),
      max = safe(range.max + bonus)

    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    const roll = min + Math.floor((seed / 0x100000000) * (max - min + 1))
    const defended = Math.min(roll, stats(target).defense)
    const blocked = Math.min(roll - defended, guard[target] ?? 0)
    guard[target] = (guard[target] ?? 0) - blocked
    const damage = Math.min(health[target]!, roll - defended - blocked)
    health[target] = health[target]! - damage
    entries.push({
      type: 'attack',
      actor,
      target,
      damage,
      blocked,
      ...(current.stats || Object.keys(definition.statuses ?? {}).length ? { defended } : {}),
    })
  }

  const effect = (actor: string, target: string, effect: AbilityEffect) => {
    const recipient = effect.target === 'self' ? actor : target

    if (!health[recipient]) return

    if (effect.type === 'damage') attack(actor, recipient, effect.damage)
    else if (effect.type === 'heal') heal(actor, recipient, effect.amount, 'healed')
    else if (effect.type === 'guard') {
      const strength = safe(effect.amount + stats(actor).guard)
      guard[recipient] = safe((guard[recipient] ?? 0) + strength)
      entries.push({ type: 'guarded', actor: recipient, guard: strength })
    } else {
      const active = (statuses[recipient] ??= [])
      const index = active.findIndex((status) => status.id === effect.status)

      if (effect.type === 'remove-status') {
        if (index >= 0) {
          active.splice(index, 1)
          entries.push({ type: 'statusRemoved', actor, target: recipient, status: effect.status })
        }
      } else {
        const status = definition.statuses?.[effect.status]

        if (!status) throw new Error('Unknown status')
        const next = { id: effect.status, source: actor, remaining: status.duration }

        if (index >= 0) active[index] = next
        else active.push(next)
        entries.push({
          type: index >= 0 ? 'statusRefreshed' : 'statusApplied',
          actor,
          target: recipient,
          status: effect.status,
          duration: next.remaining,
        })
        stats(recipient)
      }
    }
  }

  for (const actor of actors) {
    if (outcome) break

    if (coordinator.current?.actorId !== actor.id) throw new Error('Combat actor order changed')

    if (health[actor.id]! > 0) {
      guard[actor.id] = 0
      const starting = [...(statuses[actor.id] ?? [])]

      for (const type of ['damage', 'regeneration'] as const)
        for (const [id, status] of Object.entries(definition.statuses ?? {})) {
          if (outcome || status.type !== type || !starting.some((active) => active.id === id))
            continue
          const active = starting.find((active) => active.id === id)!

          if (status.type === 'damage') {
            const damage = Math.min(health[actor.id]!, status.amount)
            health[actor.id] = health[actor.id]! - damage
            entries.push({
              type: 'periodicDamage',
              actor: active.source,
              target: actor.id,
              status: id,
              amount: damage,
            })
          } else if (status.type === 'regeneration')
            heal(active.source, actor.id, status.amount, 'regenerated', id)
          outcome = combatOutcome(definition, health)
        }

      const stunned = combatStunned(definition, starting)

      if (!outcome && health[actor.id]! > 0 && stunned)
        entries.push({ type: 'stunned', actor: actor.id })

      const plan =
        actor.id === definition.player.id ? current.plan : current.enemies[actor.id]!.moves

      if (!outcome && !stunned)
        for (const queued of plan) {
          if (!health[actor.id]) break
          const move = definition.moves[queued.move]!

          if (!health[queued.target]) {
            entries.push({ type: 'skipped', actor: actor.id, target: queued.target })
            continue
          }

          if (cooldownRemaining(cooldowns, actor.id, queued.move, round))
            throw new Error('Move is on cooldown')

          const entryStart = entries.length

          if (move.type === 'attack') attack(actor.id, queued.target, move.damage)
          else if (move.type === 'guard') {
            const strength = safe(move.guard + stats(actor.id).guard)
            guard[actor.id] = safe((guard[actor.id] ?? 0) + strength)
            entries.push({ type: 'guarded', actor: actor.id, guard: strength })
          } else
            for (const entry of move.effects) {
              effect(actor.id, queued.target, entry)
              outcome = combatOutcome(definition, health)

              if (outcome || !health[actor.id]) break
            }

          if (queued.item) {
            const meaningful = entries
              .slice(entryStart)
              .some(
                (entry) =>
                  entry.type === 'statusApplied' ||
                  entry.type === 'statusRefreshed' ||
                  entry.type === 'statusRemoved' ||
                  (entry.type === 'healed' && Boolean(entry.amount)) ||
                  (entry.type === 'guarded' && Boolean(entry.guard)) ||
                  (entry.type === 'attack' && Boolean(entry.damage || entry.blocked)),
              )

            if (!meaningful) {
              entries.splice(entryStart)
              entries.push({
                type: 'itemSkipped',
                actor: actor.id,
                item: queued.itemType ?? queued.item,
              })
              continue
            }

            usedItems.push(queued.item)
            entries.splice(entryStart, 0, {
              type: 'itemUsed',
              actor: actor.id,
              item: queued.itemType ?? queued.item,
            })
          }

          if (move.cooldown)
            (cooldowns[actor.id] ??= {})[queued.move] = safe(round + move.cooldown + 1)
          outcome = combatOutcome(definition, health)

          if (outcome) break
        }

      if (actor.id !== definition.player.id && !stunned)
        cursors[actor.id] = current.enemies[actor.id]!.cursor

      for (const active of starting) {
        const list = statuses[actor.id] ?? []
        const index = list.indexOf(active)

        if (index < 0) continue

        if (active.remaining === 1) {
          list.splice(index, 1)
          entries.push({ type: 'statusExpired', target: actor.id, status: active.id })
        } else list[index] = { ...active, remaining: active.remaining - 1 }
      }
    }

    const transition = coordinator.prepare('resolve', { status: 'applied', advanceTurn: true })

    if (transition) coordinator.commit(transition)
  }

  if (outcome) entries.push({ type: outcome })

  return finish()
}

/** Previews share direct effect arithmetic with resolution, without advancing RNG. */
export interface CombatMovePreview {
  readonly min?: number
  readonly max?: number
  readonly guard?: number
}

export interface AbilityEffectPreview {
  readonly min?: number
  readonly max?: number
  readonly amount?: number
}

export function combatMoveValues(
  move: CombatDefinition['moves'][string],
  stats?: Readonly<CombatBonuses>,
  defense = 0,
): CombatMovePreview {
  if (move.type === 'ability') return {}

  return move.type === 'guard'
    ? { guard: safe(move.guard + (stats?.guard ?? 0)) }
    : {
        min: Math.max(0, safe(move.damage.min + (stats?.attack ?? 0)) - defense),
        max: Math.max(0, safe(move.damage.max + (stats?.attack ?? 0)) - defense),
      }
}

export function combatAbilityEffectValues(
  effect: AbilityEffect,
  stats?: Readonly<CombatBonuses>,
  defense = 0,
): AbilityEffectPreview {
  return effect.type === 'damage'
    ? {
        min: Math.max(0, safe(effect.damage.min + (stats?.attack ?? 0)) - defense),
        max: Math.max(0, safe(effect.damage.max + (stats?.attack ?? 0)) - defense),
      }
    : effect.type === 'guard'
      ? { amount: safe(effect.amount + (stats?.guard ?? 0)) }
      : effect.type === 'heal'
        ? { amount: effect.amount }
        : {}
}
