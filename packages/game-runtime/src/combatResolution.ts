import { combatStatusImmune, combatMoveRestriction } from './combatRestrictions.js'
import {
  combatDamageProfile,
  combatTypedDamage,
  type CombatDamageProfile,
  type CombatTypedDamage,
} from './combatDamage.js'
import {
  applyCombatPercent,
  evaluateCombatValue,
  combatValueContext,
  combatResourceCosts,
  type CombatValueContext,
} from './combatValues.js'
import type { CombatScaling, CombatEffectEventData } from '@ancadeba/schemas'
import type {
  CombatDefinition,
  CombatBonuses,
  AbilityEffect,
  CombatMechanicsState,
} from '@ancadeba/schemas'
import { CombatMechanics, combatResourceIssue, initialCombatMechanics } from './combatMechanics.js'
import { TurnCoordinator } from './turnCoordinator.js'
import { applyCombatStatus, removeCombatStatusStacks } from './combatStatusStacking.js'
import { combatActorEconomy, combatActionCost } from './combatActionEconomy.js'
import { chooseEnemyAction, enemyDecisionState, planEnemyTurn } from './combatEnemyAI.js'
import { cloneCombatRules } from '@ancadeba/schemas'
import type { CombatDebugFrame, CombatDebugSink, EnemyDecisionTrace } from './combatDebug.js'
import {
  combatStunned,
  combatMoveTarget,
  cooldownRemaining,
  statusContributions,
  temporaryCombatStats,
  combatStatusParts,
  combatStatusAmount,
  combatPercentModifier,
  type TemporaryStatContribution,
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
    | 'resourceChanged'
    | 'resourceUnavailable'
    | 'phaseChanged'
    | 'statusReduced'
    | 'apUnavailable'
    | 'moveRestricted'
    | 'statusImmune'
    | CombatOutcome
  readonly damageType?: string | undefined
  readonly resistance?: number | undefined
  readonly vulnerability?: number | undefined
  readonly immune?: boolean | undefined
  readonly resisted?: number | undefined
  readonly amplified?: number | undefined
  readonly rawDamage?: number | undefined
  readonly reactive?: boolean | undefined
  readonly category?: string | undefined
  readonly typeDamage?: number | undefined
  readonly item?: string | undefined
  readonly actor?: string | undefined
  readonly target?: string | undefined
  readonly damage?: number | undefined
  readonly blocked?: number | undefined
  readonly defended?: number | undefined
  readonly guard?: number | undefined
  readonly status?: string | undefined
  readonly amount?: number | undefined
  readonly duration?: number | undefined
  readonly resource?: string | undefined
  readonly phase?: string | undefined
  readonly stacks?: number | undefined
  readonly intensity?: number | undefined
  readonly move?: string | undefined
  readonly cost?: number | undefined
  readonly remaining?: number | undefined
}

export interface EnemyPlan {
  readonly moves: readonly PlannedMove[]
  readonly cursor: number
  readonly startCursor?: number | undefined
}

export function planEnemies(
  definition: CombatDefinition,
  health: Readonly<Record<string, number>>,
  cursors: Readonly<Record<string, number>>,
  round = 1,
  statuses: CombatStatuses = {},
  cooldowns: CombatCooldowns = {},
  mechanics?: CombatMechanicsState,
  trace?: (decision: EnemyDecisionTrace) => void,
  maximumHealth?: Readonly<Record<string, number>>,
): Record<string, EnemyPlan> {
  return Object.fromEntries(
    definition.enemies.map((actor) => [
      actor.id,
      planEnemyTurn(
        definition,
        actor,
        health,
        cursors[actor.id] ?? 0,
        round,
        statuses,
        cooldowns,
        mechanics ?? initialCombatMechanics(definition),
        trace,
        maximumHealth,
      ),
    ]),
  )
}

export function combatOutcome(
  definition: CombatDefinition,
  health: Readonly<Record<string, number>>,
): CombatOutcome | undefined {
  return health[definition.player.id] === 0
    ? 'defeat'
    : definition.mechanics?.victory !== 'triggers' &&
        definition.enemies.every((actor) => health[actor.id] === 0)
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
    mechanics?: CombatMechanicsState | undefined
  },
  debug?: CombatDebugSink,
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
  let turnActor: string | undefined
  const refreshedThisTurn = new Set<string>()

  const cursors = Object.fromEntries(
    Object.entries(current.enemies).map(([id, plan]) => [id, plan.startCursor ?? plan.cursor]),
  )

  let seed = current.seed
  let outcome = combatOutcome(definition, health)

  if (!outcome && current.escape) outcome = 'escaped'
  let tracing = Boolean(debug)
  let traceEntryCursor = 0

  const capture = (
    details: Pick<
      CombatDebugFrame,
      'kind' | 'actor' | 'action' | 'decision' | 'mechanicsEvent' | 'spentAp'
    >,
  ) => {
    if (!tracing) return

    const frame = cloneCombatRules({
      ...details,
      round,
      health,
      guard,
      seed,
      outcome,
      statuses: outcome ? {} : statuses,
      cooldowns: outcome ? {} : cooldowns,
      mechanics: mechanics.state,
      entries: entries.slice(traceEntryCursor),
    })

    traceEntryCursor = entries.length

    if (debug?.(frame) === false) tracing = false
  }

  const finish = () => {
    capture({ kind: 'round-end' })

    return {
      health,
      guard,
      seed,
      usedItems,
      entries,
      outcome,
      statuses: outcome ? {} : statuses,
      cooldowns: outcome ? {} : cooldowns,
      cursors,
      mechanics: mechanics.state,
    }
  }

  // Mechanics operates only on this candidate, including terminal/escape rounds.
  const mechanics = new CombatMechanics(
    definition,
    current.mechanics,
    {
      health,
      damage: (source, target, amount, type) =>
        damage(
          source,
          target,
          applyCombatPercent(amount, percentages(source, 'damage')),
          type,
          'reaction',
        ),
      heal: (source, target, amount) =>
        heal(source, target, amount, 'healed', undefined, 'reaction'),
      maximumHealth:
        current.maximumHealth ??
        Object.fromEntries(
          Object.entries(current.stats ?? {}).map(([id, stats]) => [id, stats.maximumHealth]),
        ),
      statuses: () => statuses,
      status: (actor, status, remove, stacks, intensity) =>
        effect(
          actor,
          actor,
          remove
            ? { id: status, type: 'remove-status', status, stacks }
            : { id: status, type: 'apply-status', status, stacks, intensity },
        ),
      log: (entry) => entries.push(entry),
      finish: (result) => {
        outcome = health[definition.player.id] === 0 ? 'defeat' : result
      },
      finished: () => outcome !== undefined,
    },
    debug
      ? (mechanicsEvent) =>
          capture({ kind: 'mechanics', actor: mechanicsEvent.actor, mechanicsEvent })
      : undefined,
  )

  capture({ kind: 'round-start' })

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

  const valueContext = (actor: string, target?: string) =>
    combatValueContext(definition, mechanics.state?.resources, statuses, actor, target)

  const percentages = (id: string, stat: 'damage' | 'healing') =>
    combatPercentModifier(statusContributions(definition, statuses[id] ?? []), stat)

  const stats = (id: string) =>
    temporaryCombatStats(current.stats?.[id], statusContributions(definition, statuses[id] ?? []))

  const resolvedEffect = (
    kind: 'damage' | 'healing',
    data: CombatEffectEventData,
    move?: string,
    status?: string,
  ) => {
    const effect = Object.freeze(data)
    const common = { source: data.source, target: data.target, move, status, effect }
    mechanics.lifecycle(
      ...(data.amount > 0
        ? [
            { ...common, type: `${kind}-received` as const, actor: data.target },
            { ...common, type: `${kind}-dealt` as const, actor: data.source },
          ]
        : []),
      { ...common, type: `${kind}-resolved`, actor: data.target },
    )
  }

  const heal = (
    actor: string,
    target: string,
    amount: number,
    type: 'healed' | 'regenerated',
    status?: string,
    delivery: CombatEffectEventData['delivery'] = type === 'regenerated' ? 'periodic' : 'direct',
    move?: string,
  ) => {
    if (!health[target]) return
    const authored = actors.find((actor) => actor.id === target)?.maximumHealth

    const maximum =
      current.maximumHealth?.[target] ??
      current.stats?.[target]?.maximumHealth ??
      (typeof authored === 'number' ? authored : undefined)

    if (maximum === undefined || maximum < health[target]!)
      throw new RangeError('Healing requires a valid maximum health')

    const rawAmount = applyCombatPercent(amount, percentages(actor, 'healing'))
    const restored = Math.min(rawAmount, maximum - health[target]!)

    health[target] = safe(health[target]! + restored)
    entries.push({
      type,
      actor,
      target,
      amount: restored,
      ...(status ? { status } : {}),
      ...(delivery === 'reaction' ? { reactive: true } : {}),
    })
    resolvedEffect(
      'healing',
      {
        source: actor,
        target,
        amount: restored,
        rawAmount,
        overheal: rawAmount - restored,
        delivery,
        reactive: delivery === 'reaction',
      },
      move,
      status,
    )
  }

  const damage = (
    actor: string,
    target: string,
    rawAmount: number,
    damageType: string | undefined,
    delivery: CombatEffectEventData['delivery'],
    status?: string,
    move?: string,
  ) => {
    if (!health[target]) return
    const periodic = delivery === 'periodic'
    const defended = periodic ? 0 : Math.min(rawAmount, stats(target).defense)

    const typed = combatTypedDamage(
      rawAmount - defended,
      damageType,
      combatDamageProfile(definition, target, statuses),
    )

    const blocked = periodic ? 0 : Math.min(typed.amount, guard[target] ?? 0)

    if (!periodic) guard[target] = (guard[target] ?? 0) - blocked
    const amount = Math.min(health[target]!, typed.amount - blocked)
    health[target] = health[target]! - amount
    entries.push({
      type: periodic ? 'periodicDamage' : 'attack',
      actor,
      target,
      ...(periodic
        ? { amount, status }
        : {
            damage: amount,
            blocked,
            ...(current.stats ||
            Object.keys(definition.statuses ?? {}).length ||
            delivery === 'reaction'
              ? { defended }
              : {}),
          }),
      ...typedDamageDetails(typed, damageType, rawAmount),
      ...(delivery === 'reaction' ? { reactive: true } : {}),
    })
    resolvedEffect(
      'damage',
      {
        source: actor,
        target,
        rawAmount,
        amount,
        damageType: typed.damageType,
        typeAmount: typed.amount,
        defended,
        blocked,
        resisted: typed.resisted,
        amplified: typed.amplified,
        immune: typed.immune,
        delivery,
        reactive: delivery === 'reaction',
      },
      move,
      status,
    )
  }

  const attack = (
    actor: string,
    target: string,
    range: { min: number; max: number },
    scaling?: CombatScaling,
    damageType?: string,
    move?: string,
  ) => {
    const bonus = stats(actor).attack

    const min = applyCombatPercent(
        safe(evaluateCombatValue(range.min, scaling, valueContext(actor, target)) + bonus),
        percentages(actor, 'damage'),
      ),
      max = applyCombatPercent(
        safe(evaluateCombatValue(range.max, scaling, valueContext(actor, target)) + bonus),
        percentages(actor, 'damage'),
      )

    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    const roll = min + Math.floor((seed / 0x100000000) * (max - min + 1))
    damage(actor, target, roll, damageType, 'direct', undefined, move)
  }

  const effect = (actor: string, target: string, effect: AbilityEffect, move?: string) => {
    if (!mechanics.matches(effect.conditions, actor, target)) return

    if (effect.type === 'change-resource') {
      mechanics.change(effect.resource, effect.amount)

      return
    }

    const recipient = effect.target === 'self' ? actor : target

    if (!health[recipient]) return

    if (effect.type === 'damage')
      attack(actor, recipient, effect.damage, effect.scaling, effect.damageType, move)
    else if (effect.type === 'heal')
      heal(
        actor,
        recipient,
        evaluateCombatValue(effect.amount, effect.scaling, valueContext(actor, target)),
        'healed',
        undefined,
        'direct',
        move,
      )
    else if (effect.type === 'guard') {
      const strength = safe(
        evaluateCombatValue(effect.amount, effect.scaling, valueContext(actor, target)) +
          stats(actor).guard,
      )

      guard[recipient] = safe((guard[recipient] ?? 0) + strength)
      entries.push({ type: 'guarded', actor: recipient, guard: strength })
    } else {
      const active = (statuses[recipient] ??= [])
      const index = active.findIndex((status) => status.id === effect.status)

      let event:
        | 'status-applied'
        | 'status-refreshed'
        | 'status-removed'
        | 'status-changed'
        | undefined

      if (effect.type === 'remove-status') {
        if (index >= 0) {
          const reduced = removeCombatStatusStacks(active[index]!, effect.stacks)

          if (reduced) active[index] = reduced
          else active.splice(index, 1)
          event = reduced ? 'status-changed' : 'status-removed'
          entries.push({
            type: reduced ? 'statusReduced' : 'statusRemoved',
            actor,
            target: recipient,
            status: effect.status,
            ...(reduced ? { stacks: reduced.stacks, intensity: reduced.intensity } : {}),
          })
        }
      } else {
        const status = definition.statuses?.[effect.status]

        if (!status) throw new Error('Unknown status')

        if (combatStatusImmune(definition, recipient, effect.status, statuses)) {
          entries.push({ type: 'statusImmune', actor, target: recipient, status: effect.status })

          return
        }

        const applied = applyCombatStatus(status, effect.status, actor, active[index], effect)

        if (!applied.changed) return
        const next = applied.active

        if (index >= 0) active[index] = next
        else active.push(next)
        event = index >= 0 ? 'status-refreshed' : 'status-applied'
        const parts = combatStatusParts(status)

        for (const amount of [parts.damage, parts.regeneration])
          if (amount !== undefined) combatStatusAmount(amount, next)

        if (recipient === turnActor && applied.durationReset) refreshedThisTurn.add(effect.status)
        entries.push({
          type: index >= 0 ? 'statusRefreshed' : 'statusApplied',
          actor,
          target: recipient,
          status: effect.status,
          duration: next.remaining,
          ...(next.stacks === undefined ? {} : { stacks: next.stacks }),
          ...(next.intensity === undefined ? {} : { intensity: next.intensity }),
        })
      }

      stats(recipient)

      const owner = [definition.player, ...definition.enemies].find(
        (entry) => entry.id === recipient,
      )!

      const economy = combatActorEconomy(definition, owner, statuses[recipient])

      for (const move of Object.values(definition.moves))
        combatActionCost(
          move,
          economy,
          valueContext(
            owner.id,
            combatMoveTarget(move) === 'self'
              ? owner.id
              : owner.id === definition.player.id
                ? definition.enemies[0]?.id
                : definition.player.id,
          ),
        )

      if (event) {
        const changed = {
          type: 'status-changed' as const,
          actor: recipient,
          target: recipient,
          source: actor,
          status: effect.status,
        }

        mechanics.lifecycle(
          ...(event === 'status-changed' ? [changed] : [{ ...changed, type: event }, changed]),
        )
      }
    }
  }

  mechanics.start()
  mechanics.emit({ type: 'round-start' })

  for (const actor of actors) {
    if (outcome) break

    if (coordinator.current?.actorId !== actor.id) throw new Error('Combat actor order changed')

    if (health[actor.id]! > 0) {
      guard[actor.id] = 0
      mechanics.emit({ type: 'turn-start', actor: actor.id })
      const starting = [...(statuses[actor.id] ?? [])]
      turnActor = actor.id
      refreshedThisTurn.clear()
      let spentAp = 0

      for (const type of ['damage', 'regeneration'] as const)
        for (const [id, status] of Object.entries(definition.statuses ?? {})) {
          const amount = combatStatusParts(status)[type]

          if (outcome || amount === undefined || !starting.some((active) => active.id === id))
            continue
          const active = statuses[actor.id]?.find((active) => active.id === id)

          if (!active) continue
          const magnitude = combatStatusAmount(amount, active)

          if (type === 'damage') {
            damage(
              active.source,
              actor.id,
              magnitude,
              combatStatusParts(status).damageType,
              'periodic',
              id,
            )
          } else heal(active.source, actor.id, magnitude, 'regenerated', id)
          outcome ??= combatOutcome(definition, health)
        }

      const stunned = combatStunned(definition, starting)

      if (!outcome && health[actor.id]! > 0 && stunned)
        entries.push({ type: 'stunned', actor: actor.id })
      capture({ kind: 'turn-start', actor: actor.id, spentAp })

      const plan =
        actor.id === definition.player.id ? current.plan : current.enemies[actor.id]!.moves

      const decision = enemyDecisionState(cursors[actor.id])
      let planIndex = 0

      if (debug && actor.ai && (stunned || !health[actor.id])) {
        const economy = combatActorEconomy(definition, actor, statuses[actor.id])
        capture({
          kind: 'enemy-decision',
          actor: actor.id,
          decision: {
            actor: actor.id,
            round,
            phase: mechanics.state?.phase,
            ap: economy.ap,
            spentAp,
            remainingAp: economy.ap,
            cursor: decision.cursor,
            candidates: [],
            choice: undefined,
            stop: !health[actor.id] ? 'defeated' : 'stunned',
          },
        })
      }

      if (!outcome && !stunned)
        while (!outcome) {
          const queued = actor.ai
            ? chooseEnemyAction(
                definition,
                actor,
                {
                  health,
                  statuses,
                  cooldowns,
                  resources: mechanics.state?.resources ?? {},
                  maximumHealth:
                    current.maximumHealth ??
                    Object.fromEntries(
                      Object.entries(current.stats ?? {}).map(([id, stats]) => [
                        id,
                        stats.maximumHealth,
                      ]),
                    ),
                  phase: mechanics.state?.phase,
                  round,
                },
                decision,
                spentAp,
                tracing
                  ? (decision) => capture({ kind: 'enemy-decision', actor: actor.id, decision })
                  : undefined,
              )
            : plan[planIndex++]

          if (!queued) break

          if (!health[actor.id]) break
          const move = definition.moves[queued.move]!
          mechanics.lifecycle({
            type: 'before-action',
            actor: actor.id,
            target: queued.target,
            move: queued.move,
          })
          outcome ??= combatOutcome(definition, health)

          if (outcome || !health[actor.id]) break

          if (combatStunned(definition, statuses[actor.id])) {
            entries.push({ type: 'stunned', actor: actor.id })
            capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
            break
          }

          const restriction = combatMoveRestriction(definition, actor.id, move, statuses)

          if (restriction) {
            entries.push({
              type: 'moveRestricted',
              actor: actor.id,
              move: queued.move,
              category: restriction.category,
              ...(restriction.status ? { status: restriction.status } : {}),
            })
            capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
            continue
          }

          if (!health[queued.target]) {
            entries.push({ type: 'skipped', actor: actor.id, target: queued.target })
            capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
            continue
          }

          if (cooldownRemaining(cooldowns, actor.id, queued.move, round))
            throw new Error('Move is on cooldown')

          const economy = combatActorEconomy(definition, actor, statuses[actor.id])
          const cost = combatActionCost(move, economy, valueContext(actor.id, queued.target))
          const remaining = Math.max(0, economy.ap - spentAp)

          if (cost > remaining) {
            entries.push({
              type: 'apUnavailable',
              actor: actor.id,
              move: queued.move,
              cost,
              remaining,
            })
            capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
            continue
          }

          const resource = combatResourceIssue(
            move,
            mechanics.state?.resources ?? {},
            [],
            {},
            valueContext(actor.id, queued.target),
          )

          if (resource) {
            entries.push({ type: 'resourceUnavailable', actor: actor.id, resource })
            capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
            continue
          }

          const entryStart = entries.length
          spentAp += cost

          mechanics.pay({
            ...move,
            resourceCosts: combatResourceCosts(move, valueContext(actor.id, queued.target)),
          })

          if (outcome) {
            if (queued.item) {
              usedItems.push(queued.item)
              entries.splice(entryStart, 0, {
                type: 'itemUsed',
                actor: actor.id,
                item: queued.itemType ?? queued.item,
              })
            }

            break
          }

          if (move.type === 'attack')
            attack(actor.id, queued.target, move.damage, move.scaling, move.damageType, queued.move)
          else if (move.type === 'guard') {
            const strength = safe(
              evaluateCombatValue(move.guard, move.scaling, valueContext(actor.id, queued.target)) +
                stats(actor.id).guard,
            )

            guard[actor.id] = safe((guard[actor.id] ?? 0) + strength)
            entries.push({ type: 'guarded', actor: actor.id, guard: strength })
          } else
            for (const entry of move.effects) {
              effect(actor.id, queued.target, entry, queued.move)
              outcome ??= combatOutcome(definition, health)

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
                  entry.type === 'statusReduced' ||
                  entry.type === 'resourceChanged' ||
                  entry.type === 'phaseChanged' ||
                  (entry.type === 'healed' && Boolean(entry.amount)) ||
                  (entry.type === 'guarded' && Boolean(entry.guard)) ||
                  (entry.type === 'attack' && Boolean(entry.damage || entry.blocked)),
              )

            if (!meaningful) {
              spentAp -= cost
              entries.splice(entryStart)
              entries.push({
                type: 'itemSkipped',
                actor: actor.id,
                item: queued.itemType ?? queued.item,
              })
              capture({ kind: 'action', actor: actor.id, action: queued, spentAp })
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
          mechanics.emit({
            type: 'action-resolved',
            actor: actor.id,
            target: queued.target,
            move: queued.move,
          })
          mechanics.lifecycle({
            type: 'after-action',
            actor: actor.id,
            target: queued.target,
            move: queued.move,
          })
          outcome ??= combatOutcome(definition, health)
          capture({ kind: 'action', actor: actor.id, action: queued, spentAp })

          if (outcome) break
        }

      if (actor.id !== definition.player.id && !stunned)
        cursors[actor.id] = actor.ai ? decision.cursor : current.enemies[actor.id]!.cursor

      mechanics.emit({ type: 'turn-end', actor: actor.id })

      for (const active of starting) {
        const list = statuses[actor.id] ?? []
        const index = list.findIndex((entry) => entry.id === active.id)

        if (index < 0 || refreshedThisTurn.has(active.id)) continue
        const currentStatus = list[index]!

        if (currentStatus.remaining === 1) {
          list.splice(index, 1)
          entries.push({ type: 'statusExpired', target: actor.id, status: active.id })
          mechanics.lifecycle(
            { type: 'status-expired', actor: actor.id, target: actor.id, status: active.id },
            { type: 'status-changed', actor: actor.id, target: actor.id, status: active.id },
          )
        } else {
          list[index] = { ...currentStatus, remaining: currentStatus.remaining - 1 }
          mechanics.lifecycle({
            type: 'status-changed',
            actor: actor.id,
            target: actor.id,
            status: active.id,
          })
        }
      }

      turnActor = undefined
      capture({ kind: 'turn-end', actor: actor.id, spentAp })
    }

    const transition = coordinator.prepare('resolve', { status: 'applied', advanceTurn: true })

    if (transition) coordinator.commit(transition)
  }

  mechanics.emit({ type: 'round-end' })

  if (outcome) entries.push({ type: outcome })

  return finish()
}

/** Previews share direct effect arithmetic with resolution, without advancing RNG. */
export interface CombatDamagePreview {
  readonly damageType?: string
  readonly resistance?: number
  readonly vulnerability?: number
  readonly immune?: boolean
}

function typedDamageDetails(
  typed: CombatTypedDamage,
  explicit: string | undefined,
  rawDamage: number,
) {
  return explicit !== undefined || typed.resistance || typed.vulnerability || typed.immune
    ? {
        damageType: typed.damageType,
        resistance: typed.resistance,
        vulnerability: typed.vulnerability,
        immune: typed.immune,
        resisted: typed.resisted,
        amplified: typed.amplified,
        rawDamage,
        typeDamage: typed.amount,
      }
    : {}
}

export interface CombatMovePreview extends CombatDamagePreview {
  readonly min?: number
  readonly max?: number
  readonly guard?: number
}

export interface AbilityEffectPreview extends CombatDamagePreview {
  readonly min?: number
  readonly max?: number
  readonly amount?: number
}

export function combatMoveValues(
  move: CombatDefinition['moves'][string],
  stats?: Readonly<CombatBonuses>,
  defense = 0,
  context?: CombatValueContext,
  effects: readonly TemporaryStatContribution[] = [],
  profile?: CombatDamageProfile,
): CombatMovePreview {
  if (move.type === 'ability') return {}

  if (move.type === 'guard')
    return {
      guard: safe(evaluateCombatValue(move.guard, move.scaling, context) + (stats?.guard ?? 0)),
    }

  return damagePreview(
    move.damage,
    move.damageType,
    move.scaling,
    stats,
    defense,
    context,
    effects,
    profile,
  )
}

export function combatAbilityEffectValues(
  effect: AbilityEffect,
  stats?: Readonly<CombatBonuses>,
  defense = 0,
  context?: CombatValueContext,
  effects: readonly TemporaryStatContribution[] = [],
  profile?: CombatDamageProfile,
): AbilityEffectPreview {
  if (effect.type === 'damage')
    return damagePreview(
      effect.damage,
      effect.damageType,
      effect.scaling,
      stats,
      defense,
      context,
      effects,
      profile,
    )

  if (effect.type === 'guard')
    return {
      amount: safe(
        evaluateCombatValue(effect.amount, effect.scaling, context) + (stats?.guard ?? 0),
      ),
    }

  if (effect.type === 'heal')
    return {
      amount: applyCombatPercent(
        evaluateCombatValue(effect.amount, effect.scaling, context),
        combatPercentModifier(effects, 'healing'),
      ),
    }

  return {}
}

function damagePreview(
  range: { min: number; max: number },
  damageType: string | undefined,
  scaling: CombatScaling | undefined,
  stats: Readonly<CombatBonuses> | undefined,
  defense: number,
  context: CombatValueContext | undefined,
  effects: readonly TemporaryStatContribution[],
  profile: CombatDamageProfile | undefined,
): CombatMovePreview {
  const percent = combatPercentModifier(effects, 'damage')

  const value = (base: number) =>
    combatTypedDamage(
      Math.max(
        0,
        applyCombatPercent(
          safe(evaluateCombatValue(base, scaling, context) + (stats?.attack ?? 0)),
          percent,
        ) - defense,
      ),
      damageType,
      profile,
    )

  const min = value(range.min)
  const max = value(range.max)

  return {
    min: min.amount,
    max: max.amount,
    ...(damageType !== undefined || min.resistance || min.vulnerability || min.immune
      ? {
          damageType: min.damageType,
          resistance: min.resistance,
          vulnerability: min.vulnerability,
          immune: min.immune,
        }
      : {}),
  }
}
