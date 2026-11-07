import type { GameLeveling } from './leveling.js'
import type { GameCombatStats } from './combatStats.js'
import {
  combatMoveTarget,
  combatStunned,
  cooldownRemaining,
  statusContributions,
  temporaryCombatStats,
  type CombatStatuses,
  type CombatCooldowns,
  type TemporaryStatContribution,
} from './combatEffects.js'
import { isRewardOperation } from '@ancadeba/schemas'
import type { GameCombatRewards } from './combatRewards.js'
import type { CombatDefinition, CombatCommand, CombatBonuses } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'
import type { ActionOrigin } from './actions.js'
import type { IStateTransactions } from './stateTransactions.js'
import type { PreparedProgression } from './progression.js'
import {
  combatOutcome,
  combatMoveValues,
  combatAbilityEffectValues,
  planEnemies,
  resolveCombatRound,
  type PlannedMove,
  type EnemyPlan,
  type CombatOutcome,
  type CombatLogEntry,
} from './combatResolution.js'

export interface CombatCapture {
  readonly reservation?: object | undefined
  readonly stats?: object | undefined
  readonly leveling?: object | undefined
  readonly round: object
  readonly target: object | undefined
}

export interface CombatCommandRequest {
  readonly scene: SceneInstance
  readonly component: string
  readonly command: CombatCommand
  readonly capture: CombatCapture
  readonly origin: ActionOrigin
}

export interface CombatSnapshot {
  readonly statuses: CombatStatuses
  readonly cooldowns: CombatCooldowns
  readonly stats: Readonly<Record<string, Readonly<CombatBonuses>>>
  readonly round: number
  readonly phase: 'planning' | 'complete'
  readonly outcome: CombatOutcome | undefined
  readonly target: string | undefined
  readonly remainingAp: number
  readonly health: Readonly<Record<string, number>>
  readonly maximumHealth: Readonly<Record<string, number>>
  readonly guard: Readonly<Record<string, number>>
  readonly plan: readonly PlannedMove[]
  readonly enemyPlans: Readonly<Record<string, EnemyPlan>>
  readonly escape: boolean
  readonly log: readonly CombatLogEntry[]
  readonly issue: string | undefined
}

export interface IGameCombat {
  moveIssue(scene: SceneInstance, component: string, move: string): string | undefined
  definition(scene: SceneInstance, component: string): CombatDefinition | undefined
  snapshot(scene: SceneInstance, component: string): CombatSnapshot | undefined
  capture(
    scene: SceneInstance,
    component: string,
    command: CombatCommand,
  ): CombatCapture | undefined
  selectTarget(scene: SceneInstance, component: string, target: string): void
  canCommand(scene: SceneInstance, component: string, command: CombatCommand): boolean
  request(
    scene: SceneInstance,
    component: string,
    command: CombatCommand,
    capture?: CombatCapture,
    origin?: ActionOrigin,
  ): void
  text(scene: SceneInstance, component: string): string
  subscribeChanges(listener: () => void): () => void
}

interface Session {
  statuses: CombatStatuses
  cooldowns: CombatCooldowns
  captures: Map<string, CombatCapture>
  reservations: Map<string, object>
  started?: boolean
  round: number
  seed: number
  guard: Record<string, number>
  plan: PlannedMove[]
  enemies: Record<string, EnemyPlan>
  escape: boolean
  outcome: CombatOutcome | undefined
  token: object
  target: { readonly id: string } | undefined
  log: CombatLogEntry[]
  issue: string | undefined
}

/** Playthrough-owned encounter plans. All commands use the scoped message queue. */
export class GameCombat implements IGameCombat {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[]
  private disposed = false
  private publishing = false
  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly bindings: IGameBindings,
    private readonly state: IStateTransactions | undefined,
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly prepareProgression: (cost: number) => PreparedProgression,
    private readonly invalidate: () => void,
    private readonly rewards?: GameCombatRewards,
    private readonly leveling?: GameLeveling,
    private readonly stats?: GameCombatStats,
  ) {
    this.cleanups = [
      ...(stats ? [stats.setTemporaryEffects((owner) => this.ownerEffects(owner))] : []),
      lifecycle.subscribeSceneChanges(({ current }) => {
        if (current?.type !== 'game') return

        for (const component of current.data.components)
          if (component.type === 'combat') this.snapshot(current, component.id)
      }),
      messages.subscribe('combat.command', (request) => this.execute(request)),
      ...(leveling
        ? [
            leveling.subscribeChanges(() => {
              if (!this.publishing) this.notify()
            }),
          ]
        : []),
      ...(rewards
        ? [
            rewards.subscribeChanges(() => {
              if (!this.publishing) this.notify()
            }),
          ]
        : []),
      bindings.subscribeChanges(() => {
        if (!this.publishing) this.notify()
      }),
    ]
  }
  definition(scene: SceneInstance, id: string): CombatDefinition | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene.type !== 'game' ||
      scene !== this.lifecycle.activeScene
    )
      return

    const component = scene.game.data.scenes
      .get(scene.data.id)
      ?.components.find((component) => component.id === id)

    return component?.type === 'combat'
      ? scene.game.data.combat?.get(component.encounter)
      : undefined
  }
  private health(definition: CombatDefinition) {
    const health: Record<string, number> = {}
    const maximum: Record<string, number> = {}

    for (const actor of [definition.player, ...definition.enemies]) {
      const result = this.bindings.read(actor.health)

      const max =
        typeof actor.maximumHealth === 'number'
          ? actor.maximumHealth
          : this.bindings.read(actor.maximumHealth)

      const value = actor.equipmentOwner
        ? this.stats?.snapshot(actor.equipmentOwner)?.total.maximumHealth
        : typeof max === 'number'
          ? max
          : max.status === 'resolved'
            ? max.value
            : undefined

      if (
        result.status !== 'resolved' ||
        typeof result.value !== 'number' ||
        !Number.isSafeInteger(result.value) ||
        result.value < 0 ||
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        result.value > value
      )
        return
      health[actor.id] = result.value
      maximum[actor.id] = value
    }

    return { health, maximum }
  }
  private ownerEffects(owner: string): readonly TemporaryStatContribution[] {
    for (const [id, session] of this.sessions) {
      if (!session.started || session.outcome) continue
      const definition = this.lifecycle.currentGame?.data.combat?.get(id)

      const actor =
        definition &&
        [definition.player, ...definition.enemies].find((actor) => actor.equipmentOwner === owner)

      if (definition && actor)
        return statusContributions(definition, session.statuses[actor.id] ?? [])
    }

    return []
  }
  private statValues(definition: CombatDefinition, effective = true) {
    const values: Record<string, Readonly<CombatBonuses>> = {}

    for (const actor of [definition.player, ...definition.enemies]) {
      const active = this.sessions.get(definition.id)?.statuses[actor.id] ?? []

      if (!actor.equipmentOwner) {
        if (effective && active.length)
          values[actor.id] = temporaryCombatStats(
            undefined,
            statusContributions(definition, active),
          )
        continue
      }

      const snapshot = effective
        ? this.stats?.snapshot(actor.equipmentOwner)
        : this.stats?.baseSnapshot(actor.equipmentOwner)

      if (!snapshot) return
      values[actor.id] = snapshot.total
    }

    try {
      for (const actor of [definition.player, ...definition.enemies])
        for (const moveId of actor.moves) {
          const move = definition.moves[moveId]!
          combatMoveValues(move, values[actor.id])

          if (move.type === 'ability')
            for (const effect of move.effects) combatAbilityEffectValues(effect, values[actor.id])
        }
    } catch {
      return
    }

    return Object.freeze(values)
  }
  private session(definition: CombatDefinition): Session {
    let session = this.sessions.get(definition.id)
    const values = this.health(definition)

    if (!session) {
      const health = values?.health ?? {}
      session = {
        statuses: {},
        cooldowns: {},
        captures: new Map(),
        reservations: new Map(),
        round: 1,
        seed: definition.seed,
        guard: {},
        plan: [],
        enemies: values ? planEnemies(definition, health, {}) : {},
        escape: false,
        outcome: values ? combatOutcome(definition, health) : undefined,
        token: {},
        target: undefined,
        log: [],
        issue: undefined,
      }
      this.sessions.set(definition.id, session)
    }

    if (
      !session.outcome &&
      !session.started &&
      values &&
      this.statValues(definition) &&
      this.state?.prepare(
        [definition.player, ...definition.enemies].map((actor) => ({
          path: actor.health.path,
          expected: values.health[actor.id]!,
          value: values.health[actor.id]!,
        })),
      )
    ) {
      session.started = true

      if (this.stats && !this.stats.acquire(definition)) session.started = false
    }

    if (values) {
      if (!Object.keys(session.enemies).length)
        session.enemies = planEnemies(definition, values.health, {})

      if (!session.outcome) {
        const outcome = combatOutcome(definition, values.health)

        if (outcome) {
          session.outcome = outcome
          session.statuses = {}
          session.cooldowns = {}
          this.stats?.release(definition.id)
          session.token = {}
          session.log.push({ type: outcome })
          session.log = session.log.slice(-definition.logCapacity)
        }
      }

      const living = definition.enemies.filter((actor) => values.health[actor.id]! > 0)

      if (session.target && !living.some((actor) => actor.id === session!.target?.id))
        session.target = undefined

      if (!session.target && living.length === 1)
        session.target = Object.freeze({ id: living[0]!.id })
    }

    return session
  }
  snapshot(scene: SceneInstance, id: string): CombatSnapshot | undefined {
    const definition = this.definition(scene, id)

    if (!definition) return
    const session = this.session(definition)
    const values = this.health(definition)

    const writable =
      values &&
      this.state?.prepare(
        [definition.player, ...definition.enemies].map((actor) => ({
          path: actor.health.path,
          expected: values.health[actor.id]!,
          value: values.health[actor.id]!,
        })),
      )

    return Object.freeze({
      statuses: Object.freeze(
        Object.fromEntries(
          Object.entries(session.statuses).map(([actor, active]) => [
            actor,
            Object.freeze(active.map((status) => Object.freeze({ ...status }))),
          ]),
        ),
      ),
      cooldowns: Object.freeze(
        Object.fromEntries(
          Object.entries(session.cooldowns).map(([actor, moves]) => [
            actor,
            Object.freeze({ ...moves }),
          ]),
        ),
      ),
      stats: this.statValues(definition) ?? Object.freeze({}),
      round: session.round,
      phase: session.outcome ? 'complete' : 'planning',
      outcome: session.outcome,
      target: session.target?.id,
      remainingAp: session.escape
        ? 0
        : definition.player.ap -
          session.plan.reduce((sum, move) => sum + definition.moves[move.move]!.apCost, 0),
      health: Object.freeze({ ...values?.health }),
      maximumHealth: Object.freeze({ ...values?.maximum }),
      guard: Object.freeze({ ...session.guard }),
      plan: Object.freeze(session.plan.map((move) => Object.freeze({ ...move }))),
      enemyPlans: Object.freeze(
        Object.fromEntries(
          Object.entries(session.enemies).map(([id, plan]) => [
            id,
            Object.freeze({
              cursor: plan.cursor,
              ...(plan.startCursor !== undefined ? { startCursor: plan.startCursor } : {}),
              moves: Object.freeze(plan.moves.map((move) => Object.freeze({ ...move }))),
            }),
          ]),
        ),
      ),
      escape: session.escape,
      log: Object.freeze(session.log.map((entry) => Object.freeze({ ...entry }))),
      issue:
        !values || !writable || !this.statValues(definition)
          ? definition.messages.unavailable
          : (this.stats?.encounterIssue(definition) ?? session.issue),
    })
  }
  capture(scene: SceneInstance, id: string, command: CombatCommand): CombatCapture | undefined {
    const definition = this.definition(scene, id)

    if (!definition) return
    const session = this.session(definition)

    if (isRewardOperation(command.type)) return this.rewards?.capture(scene, id, command.type)

    const targeted =
      command.type === 'queue-move' &&
      definition.moves[command.move] &&
      combatMoveTarget(definition.moves[command.move]!) === 'enemy'

    const key = command.type === 'queue-move' ? `move:${command.move}` : 'control'

    const target = targeted ? session.target : undefined

    const leveling =
      command.type === 'queue-move' ? this.leveling?.version(definition.player.leveling) : undefined

    const stats = this.stats?.encounterVersion(definition)

    const reservation =
      command.type === 'queue-move' ? session.reservations.get(command.move) : undefined

    let capture = session.captures.get(key)

    if (
      !capture ||
      capture.round !== session.token ||
      capture.target !== target ||
      capture.leveling !== leveling ||
      capture.stats !== stats ||
      capture.reservation !== reservation
    ) {
      capture = Object.freeze({ round: session.token, target, leveling, stats, reservation })
      session.captures.set(key, capture)
    }

    return capture
  }
  selectTarget(scene: SceneInstance, id: string, target: string): void {
    const definition = this.definition(scene, id)

    if (!definition) return
    const session = this.session(definition)

    if (
      session.outcome ||
      session.target?.id === target ||
      !definition.enemies.some(
        (actor) => actor.id === target && (this.health(definition)?.health[target] ?? 0) > 0,
      )
    )
      return
    session.target = Object.freeze({ id: target })
    this.notify()
  }
  canCommand(scene: SceneInstance, id: string, command: CombatCommand): boolean {
    const definition = this.definition(scene, id)
    const snapshot = this.snapshot(scene, id)

    if (!definition || !snapshot) return false

    if (isRewardOperation(command.type))
      return this.rewards?.canCommand(scene, id, command.type) ?? false

    if (command.type === 'continue')
      return Boolean(snapshot.outcome && definition.outcomes[snapshot.outcome])

    if (snapshot.phase !== 'planning') return false

    if (
      !this.session(definition).started ||
      !this.statValues(definition) ||
      this.stats?.encounterIssue(definition)
    )
      return false

    if (command.type === 'previous-target' || command.type === 'next-target')
      return definition.enemies.filter((actor) => (snapshot.health[actor.id] ?? 0) > 0).length > 1

    if (command.type === 'undo' || command.type === 'clear')
      return snapshot.escape || snapshot.plan.length > 0
    const values = this.health(definition)

    if (
      !values ||
      !this.state?.prepare(
        [definition.player, ...definition.enemies].map((actor) => ({
          path: actor.health.path,
          expected: values.health[actor.id]!,
          value: values.health[actor.id]!,
        })),
      )
    )
      return false

    if (command.type === 'end-turn') return true

    if (command.type === 'escape') return definition.allowEscape && !snapshot.escape

    if (command.type !== 'queue-move') return false
    const move = definition.moves[command.move]

    return Boolean(
      move &&
      !this.moveIssue(scene, id, command.move) &&
      (!definition.player.leveling ||
        (this.leveling?.moveAvailable(definition, command.move) ?? false)) &&
      definition.player.moves.includes(command.move) &&
      !snapshot.escape &&
      move.apCost <= snapshot.remainingAp &&
      (combatMoveTarget(move) === 'self' || snapshot.target),
    )
  }
  moveIssue(scene: SceneInstance, id: string, moveId: string): string | undefined {
    const definition = this.definition(scene, id)

    if (!definition) return
    const session = this.session(definition)

    if (combatStunned(definition, session.statuses[definition.player.id]))
      return definition.messages.stunned.replaceAll('{actor}', definition.player.label)

    const remaining = cooldownRemaining(
      session.cooldowns,
      definition.player.id,
      moveId,
      session.round,
    )

    if (remaining) return definition.messages.cooldown.replaceAll('{rounds}', String(remaining))

    if (definition.moves[moveId]?.cooldown && session.plan.some((move) => move.move === moveId))
      return definition.messages.reserved
  }
  request(
    scene: SceneInstance,
    component: string,
    command: CombatCommand,
    capture = this.capture(scene, component, command),
    origin: ActionOrigin = { type: 'direct' },
  ): void {
    if (!capture || this.disposed) return
    this.messages.publish(
      'combat.command',
      Object.freeze({ scene, component, command: Object.freeze({ ...command }), capture, origin }),
    )
  }
  private execute(request: CombatCommandRequest): void {
    const { scene, component, command, capture } = request
    const definition = this.definition(scene, component)

    if (
      !definition ||
      capture !== this.capture(scene, component, command) ||
      !this.canCommand(scene, component, command)
    )
      return

    if (isRewardOperation(command.type)) {
      this.rewards?.execute(scene, component, command.type)

      return
    }

    const session = this.session(definition)
    session.issue = undefined

    if (command.type === 'continue') {
      this.lifecycle.enterScene(definition.outcomes[session.outcome!]!)

      return
    }

    if (command.type === 'next-target' || command.type === 'previous-target') {
      const living = definition.enemies.filter(
        (actor) => this.health(definition)!.health[actor.id]! > 0,
      )

      const current = living.findIndex((actor) => actor.id === session.target?.id)

      const index =
        current < 0
          ? command.type === 'next-target'
            ? 0
            : living.length - 1
          : (current + (command.type === 'next-target' ? 1 : -1) + living.length) % living.length

      this.selectTarget(scene, component, living[index]!.id)

      return
    }

    if (command.type === 'queue-move') {
      if (definition.moves[command.move]?.cooldown) session.reservations.set(command.move, {})
      session.plan.push({
        move: command.move,
        target:
          combatMoveTarget(definition.moves[command.move]!) === 'self'
            ? definition.player.id
            : session.target!.id,
      })
    } else if (command.type === 'undo') {
      if (session.escape) session.escape = false
      else {
        const removed = session.plan.pop()

        if (removed && definition.moves[removed.move]?.cooldown)
          session.reservations.set(removed.move, {})
      }
    } else if (command.type === 'clear') {
      for (const move of session.plan)
        if (definition.moves[move.move]?.cooldown) session.reservations.set(move.move, {})
      session.plan = []
      session.escape = false
    } else if (command.type === 'escape') {
      for (const move of session.plan)
        if (definition.moves[move.move]?.cooldown) session.reservations.set(move.move, {})
      session.plan = []
      session.escape = true
    } else if (command.type === 'end-turn') {
      this.resolve(definition, session)

      return
    }

    this.notify()
  }
  private resolve(definition: CombatDefinition, session: Session): void {
    const values = this.health(definition)

    if (!values) return
    const stats = this.statValues(definition, false)
    const version = this.stats?.encounterVersion(definition)

    if (!stats || this.stats?.encounterIssue(definition)) return
    let notifyProgression: (() => void) | undefined
    let notifyRewards: (() => void) | undefined

    try {
      const candidate = resolveCombatRound(definition, {
        health: values.health,
        guard: session.guard,
        seed: session.seed,
        plan: session.plan,
        enemies: session.enemies,
        escape: session.escape,
        ...(Object.keys(stats).length ? { stats } : {}),
        maximumHealth: values.maximum,
        statuses: session.statuses,
        cooldowns: session.cooldowns,
        round: session.round,
      })

      const round = session.round + 1

      if (!Number.isSafeInteger(round))
        throw new RangeError('Combat round exceeds the supported range')

      const writes = this.state?.prepare(
        [definition.player, ...definition.enemies].map((actor) => ({
          path: actor.health.path,
          expected: values.health[actor.id]!,
          value: candidate.health[actor.id]!,
        })),
      )

      const progression = this.prepareProgression(definition.roundTimeMs)

      if (
        !writes?.isCurrent() ||
        !progression.isCurrent() ||
        version !== this.stats?.encounterVersion(definition)
      )
        throw new Error('Combat transaction is stale')

      const cursors = candidate.cursors

      const enemies = candidate.outcome
        ? session.enemies
        : planEnemies(
            definition,
            candidate.health,
            cursors,
            round,
            candidate.statuses,
            candidate.cooldowns,
          )

      writes.commit()
      progression.commit()
      session.guard = candidate.guard
      session.statuses = candidate.statuses
      session.cooldowns = candidate.cooldowns
      session.seed = candidate.seed
      session.outcome = candidate.outcome

      if (candidate.outcome) this.stats?.release(definition.id)
      session.log = [...session.log, ...candidate.entries].slice(-definition.logCapacity)
      session.round = candidate.outcome ? session.round : round
      session.enemies = enemies
      session.plan = []
      session.escape = false
      session.token = {}
      notifyProgression = () => progression.notify()

      if (candidate.outcome === 'victory') notifyRewards = this.rewards?.complete(definition)
    } catch {
      session.issue = definition.messages.unavailable
      this.notify()

      return
    }

    const errors: unknown[] = []
    this.publishing = true

    try {
      for (const notify of [notifyProgression, notifyRewards, this.invalidate])
        try {
          notify?.()
        } catch (error) {
          errors.push(error)
        }
    } finally {
      this.publishing = false
    }

    try {
      this.notify()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length)
      throw new AggregateError(errors, 'Combat round committed but observers failed')
  }
  text(scene: SceneInstance, id: string): string {
    const definition = this.definition(scene, id)
    const snapshot = this.snapshot(scene, id)

    if (!definition || !snapshot) return ''
    const actors = [definition.player, ...definition.enemies]
    const name = (id?: string) => actors.find((actor) => actor.id === id)?.label ?? ''

    const lines = snapshot.log.map((entry) =>
      (entry.type === 'attack' && entry.defended !== undefined
        ? definition.messages.mitigated
        : definition.messages[entry.type]
      ).replace(
        /\{(actor|target|damage|blocked|guard|defended|status|amount|duration)\}/g,
        (_, key: string) =>
          key === 'status'
            ? (definition.statuses?.[entry.status ?? '']?.label ?? '')
            : key === 'amount'
              ? String(entry.amount ?? 0)
              : key === 'duration'
                ? String(entry.duration ?? 0)
                : key === 'actor'
                  ? name(entry.actor)
                  : key === 'target'
                    ? name(entry.target)
                    : String(
                        key === 'damage'
                          ? (entry.damage ?? 0)
                          : key === 'defended'
                            ? (entry.defended ?? 0)
                            : key === 'blocked'
                              ? (entry.blocked ?? 0)
                              : (entry.guard ?? 0),
                      ),
      ),
    )

    return [
      ...lines,
      snapshot.issue,
      this.rewards?.text(scene, id),
      definition.player.leveling ? this.leveling?.text(definition.player.leveling) : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (
      this.disposed ||
      !this.lifecycle.activeScene?.data.components.some((component) => component.type === 'combat')
    )
      return
    const errors: unknown[] = []

    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue

      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Combat subscribers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.cleanups.length = 0
    this.sessions.clear()
    this.listeners.clear()
  }
}
