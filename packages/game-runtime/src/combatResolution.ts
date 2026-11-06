import type { CombatDefinition } from '@ancadeba/schemas'
import { TurnCoordinator } from './turnCoordinator.js'

export type CombatOutcome = 'victory' | 'defeat' | 'escaped'

export interface PlannedMove {
  readonly move: string
  readonly target: string
}

export interface CombatLogEntry {
  readonly type: 'attack' | 'guarded' | 'skipped' | CombatOutcome
  readonly actor?: string
  readonly target?: string
  readonly damage?: number
  readonly blocked?: number
  readonly guard?: number
}

export interface EnemyPlan {
  readonly moves: readonly PlannedMove[]
  readonly cursor: number
}

export function planEnemies(
  definition: CombatDefinition,
  health: Readonly<Record<string, number>>,
  cursors: Readonly<Record<string, number>>,
): Record<string, EnemyPlan> {
  return Object.fromEntries(
    definition.enemies.map((actor) => {
      let cursor = cursors[actor.id] ?? 0
      let ap = actor.ap
      const moves: PlannedMove[] = []

      if (health[actor.id]! > 0)
        while (ap > 0) {
          let found = false

          for (let index = 0; index < actor.rotation.length; index++) {
            const position = (cursor + index) % actor.rotation.length
            const id = actor.rotation[position]!
            const move = definition.moves[id]!

            if (move.apCost > ap) continue
            moves.push({
              move: id,
              target: move.type === 'guard' ? actor.id : definition.player.id,
            })
            ap -= move.apCost
            cursor = (position + 1) % actor.rotation.length
            found = true
            break
          }

          if (!found) break
        }

      return [actor.id, { moves, cursor }]
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

/** Pure round simulation: rejected transactions never consume this candidate RNG state. */
export function resolveCombatRound(
  definition: CombatDefinition,
  current: {
    health: Readonly<Record<string, number>>
    guard: Readonly<Record<string, number>>
    seed: number
    plan: readonly PlannedMove[]
    enemies: Readonly<Record<string, EnemyPlan>>
    escape: boolean
  },
) {
  const health = { ...current.health }
  const guard = { ...current.guard }
  const entries: CombatLogEntry[] = []
  let seed = current.seed
  let outcome = combatOutcome(definition, health)

  if (!outcome && current.escape) outcome = 'escaped'

  if (outcome)
    return { health, guard, seed, entries: [{ type: outcome } satisfies CombatLogEntry], outcome }
  const actors = [definition.player, ...definition.enemies].filter((actor) => health[actor.id]! > 0)

  const coordinator = new TurnCoordinator(
    {
      actors: actors.map((actor) => actor.id),
      phases: ['resolution'],
      actionPolicies: new Map([['resolve', { scope: 'actor' }]]),
    },
    ['resolve'],
  )

  for (const actor of actors) {
    if (outcome) break

    if (coordinator.current?.actorId !== actor.id) throw new Error('Combat actor order changed')

    if (health[actor.id]! > 0) {
      guard[actor.id] = 0

      const plan =
        actor.id === definition.player.id ? current.plan : current.enemies[actor.id]!.moves

      for (const queued of plan) {
        const move = definition.moves[queued.move]!

        if (move.type === 'guard') {
          const next = (guard[actor.id] ?? 0) + move.guard

          if (!Number.isSafeInteger(next))
            throw new RangeError('Combat guard exceeds the supported range')
          guard[actor.id] = next
          entries.push({ type: 'guarded', actor: actor.id, guard: move.guard })
        } else if (!health[queued.target])
          entries.push({ type: 'skipped', actor: actor.id, target: queued.target })
        else {
          seed ^= seed << 13
          seed ^= seed >>> 17
          seed ^= seed << 5
          seed >>>= 0

          const roll =
            move.damage.min +
            Math.floor((seed / 0x100000000) * (move.damage.max - move.damage.min + 1))

          const blocked = Math.min(roll, guard[queued.target] ?? 0)
          guard[queued.target] = (guard[queued.target] ?? 0) - blocked
          const damage = Math.min(health[queued.target]!, roll - blocked)
          health[queued.target] = health[queued.target]! - damage
          entries.push({ type: 'attack', actor: actor.id, target: queued.target, damage, blocked })
        }

        outcome = combatOutcome(definition, health)

        if (outcome) break
      }
    }

    const transition = coordinator.prepare('resolve', { status: 'applied', advanceTurn: true })

    if (transition) coordinator.commit(transition)
  }

  if (outcome) entries.push({ type: outcome })

  return { health, guard, seed, entries, outcome }
}
