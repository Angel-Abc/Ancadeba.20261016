import { isRewardOperation } from '@ancadeba/schemas'
import type { GameCombatRewards } from './combatRewards.js'
import type { CombatDefinition, CombatCommand } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'
import type { ActionOrigin } from './actions.js'
import type { IStateTransactions } from './stateTransactions.js'
import type { PreparedProgression } from './progression.js'
import {
  combatOutcome,
  planEnemies,
  resolveCombatRound,
  type PlannedMove,
  type EnemyPlan,
  type CombatOutcome,
  type CombatLogEntry,
} from './combatResolution.js'

export interface CombatCapture {
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
  round: number
  seed: number
  guard: Record<string, number>
  plan: PlannedMove[]
  enemies: Record<string, EnemyPlan>
  escape: boolean
  outcome: CombatOutcome | undefined
  token: object
  target: { readonly id: string } | undefined
  baseCapture?: CombatCapture
  moveCapture?: CombatCapture
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
  ) {
    this.cleanups = [
      messages.subscribe('combat.command', (request) => this.execute(request)),
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

      const value =
        typeof max === 'number' ? max : max.status === 'resolved' ? max.value : undefined

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
  private session(definition: CombatDefinition): Session {
    let session = this.sessions.get(definition.id)
    const values = this.health(definition)

    if (!session) {
      const health = values?.health ?? {}
      session = {
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

    if (values) {
      if (!Object.keys(session.enemies).length)
        session.enemies = planEnemies(definition, values.health, {})

      if (!session.outcome) {
        const outcome = combatOutcome(definition, values.health)

        if (outcome) {
          session.outcome = outcome
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
              moves: Object.freeze(plan.moves.map((move) => Object.freeze({ ...move }))),
            }),
          ]),
        ),
      ),
      escape: session.escape,
      log: Object.freeze(session.log.map((entry) => Object.freeze({ ...entry }))),
      issue: !values || !writable ? definition.messages.unavailable : session.issue,
    })
  }
  capture(scene: SceneInstance, id: string, command: CombatCommand): CombatCapture | undefined {
    const definition = this.definition(scene, id)

    if (!definition) return
    const session = this.session(definition)

    if (isRewardOperation(command.type)) return this.rewards?.capture(scene, id, command.type)

    const targeted =
      command.type === 'queue-move' && definition.moves[command.move]?.type === 'attack'

    const key = targeted ? 'moveCapture' : 'baseCapture'
    const target = targeted ? session.target : undefined
    let capture = session[key]

    if (!capture || capture.round !== session.token || capture.target !== target) {
      capture = Object.freeze({ round: session.token, target })
      session[key] = capture
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
      definition.player.moves.includes(command.move) &&
      !snapshot.escape &&
      move.apCost <= snapshot.remainingAp &&
      (move.type === 'guard' || snapshot.target),
    )
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

    if (command.type === 'queue-move')
      session.plan.push({
        move: command.move,
        target:
          definition.moves[command.move]!.type === 'guard'
            ? definition.player.id
            : session.target!.id,
      })
    else if (command.type === 'undo') {
      if (session.escape) session.escape = false
      else session.plan.pop()
    } else if (command.type === 'clear') {
      session.plan = []
      session.escape = false
    } else if (command.type === 'escape') {
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

      if (!writes?.isCurrent() || !progression.isCurrent())
        throw new Error('Combat transaction is stale')

      const cursors = Object.fromEntries(
        Object.entries(session.enemies).map(([id, plan]) => [id, plan.cursor]),
      )

      const enemies = candidate.outcome
        ? session.enemies
        : planEnemies(definition, candidate.health, cursors)

      writes.commit()
      progression.commit()
      session.guard = candidate.guard
      session.seed = candidate.seed
      session.outcome = candidate.outcome
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
      definition.messages[entry.type].replace(
        /\{(actor|target|damage|blocked|guard)\}/g,
        (_, key: string) =>
          key === 'actor'
            ? name(entry.actor)
            : key === 'target'
              ? name(entry.target)
              : String(
                  key === 'damage'
                    ? (entry.damage ?? 0)
                    : key === 'blocked'
                      ? (entry.blocked ?? 0)
                      : (entry.guard ?? 0),
                ),
      ),
    )

    return [...lines, snapshot.issue, this.rewards?.text(scene, id)].filter(Boolean).join('\n')
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
