import { usableItem, abilityCanMatter } from './itemUseEligibility.js'
import type { IGameInventory, InventoryReservation, InventoryItemSnapshot } from './inventory.js'
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
import type { GameData } from './gameData.js'
import { savedCombatSchema, type GameSave } from '@ancadeba/schemas'
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
  readonly itemVersion?: object | undefined
  readonly lineage?: readonly InventoryItemSnapshot[] | undefined
  readonly selection?: object | undefined
  readonly item?: object | undefined
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
  outcome?(encounter: string): CombatOutcome | undefined
  itemIssue(scene: SceneInstance, component: string, item: string): string | undefined
  unfinishedOwner(owner: string): boolean
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
  itemReservation: InventoryReservation
  itemVersions: Map<string, object>
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
  outcome(encounter: string): CombatOutcome | undefined {
    return this.sessions.get(encounter)?.outcome
  }
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[]
  private disposed = false
  private publishing = false

  save(): GameSave['combat'] {
    return Object.fromEntries(
      [...this.sessions].map(([id, session]) => [
        id,
        savedCombatSchema.parse({
          statuses: session.statuses,
          cooldowns: session.cooldowns,
          started: session.started ?? false,
          round: session.round,
          seed: session.seed,
          guard: session.guard,
          plan: session.plan,
          enemies: session.enemies,
          escape: session.escape,
          outcome: session.outcome,
          target: session.target?.id,
          log: session.log,
        }),
      ]),
    )
  }

  restore(save: GameSave['combat'], data: GameData): void {
    for (const [id, saved] of Object.entries(save)) {
      const definition = data.combat?.get(id)

      if (!definition || saved.log.length > definition.logCapacity)
        throw new Error('Unknown saved encounter')
      const actors = new Set([definition.player, ...definition.enemies].map((actor) => actor.id))

      for (const entry of [
        ...saved.plan,
        ...Object.values(saved.enemies).flatMap((enemy) => enemy.moves),
      ])
        if (!definition.moves[entry.move] || !actors.has(entry.target))
          throw new Error('Invalid saved combat plan')

      for (const [actor, statuses] of Object.entries(saved.statuses))
        if (
          !actors.has(actor) ||
          statuses.some((status) => !definition.statuses?.[status.id] || !actors.has(status.source))
        )
          throw new Error('Invalid saved combat status')

      for (const [actor, moves] of Object.entries(saved.cooldowns))
        if (!actors.has(actor) || Object.keys(moves).some((move) => !definition.moves[move]))
          throw new Error('Invalid saved cooldown')

      if (saved.target && !definition.enemies.some((enemy) => enemy.id === saved.target))
        throw new Error('Invalid saved target')

      const session: Session = {
        ...saved,
        captures: new Map(),
        itemReservation: { encounter: id },
        itemVersions: new Map(),
        reservations: new Map(),
        token: {},
        outcome: saved.outcome,
        target: saved.target ? { id: saved.target } : undefined,
        issue: undefined,
      }

      this.sessions.set(id, session)

      if (saved.started && !saved.outcome && this.stats && !this.stats.acquire(definition))
        throw new Error('Invalid saved equipment lock')

      for (const entry of session.plan) {
        if (entry.item) {
          const item = this.inventory?.snapshot.find((item) => item.id === entry.item)

          if (
            !item ||
            item.itemType !== entry.itemType ||
            !this.inventory?.reserveItem ||
            this.inventory.reserveItem(entry.item, session.itemReservation)
          )
            throw new Error('Invalid saved item reservation')
          session.itemVersions.set(entry.item, {})
        }

        if (definition.moves[entry.move]?.cooldown) session.reservations.set(entry.move, {})
      }
    }
  }
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
    private readonly inventory: IGameInventory | undefined = lifecycle.currentGame?.inventory,
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
        itemReservation: { encounter: definition.id },
        itemVersions: new Map(),
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
          this.inventory?.releaseItems?.(session.itemReservation)
          session.plan = []
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
      (command.type === 'queue-move' || command.type === 'queue-item') &&
      definition.moves[
        command.type === 'queue-move'
          ? command.move
          : (this.itemMove(definition, command.item) ?? '')
      ] &&
      combatMoveTarget(
        definition.moves[
          command.type === 'queue-move'
            ? command.move
            : command.type === 'queue-item'
              ? (this.itemMove(definition, command.item) ?? '')
              : ''
        ]!,
      ) === 'enemy'

    const moveId =
      command.type === 'queue-move'
        ? command.move
        : command.type === 'queue-item'
          ? this.itemMove(definition, command.item)
          : undefined

    const item =
      command.type === 'queue-item'
        ? this.inventory?.snapshot.find((item) => item.id === command.item)
        : undefined

    const key =
      command.type === 'queue-item'
        ? `item:${command.item}`
        : command.type === 'queue-move'
          ? `move:${command.move}`
          : 'control'

    const target = targeted ? session.target : undefined

    const leveling =
      command.type === 'queue-move' ? this.leveling?.version(definition.player.leveling) : undefined

    const stats = this.stats?.encounterVersion(definition)

    const selection =
      command.type === 'queue-item' && command.inventory && scene.type === 'game'
        ? scene.game.inventorySelection?.get(scene, command.inventory)
        : undefined

    const reservation = moveId ? session.reservations.get(moveId) : undefined

    const itemVersion =
      command.type === 'queue-item' ? session.itemVersions.get(command.item) : undefined

    const lineage =
      command.type === 'queue-item'
        ? usableItem(
            this.inventory,
            this.lifecycle.currentGame?.data.inventory,
            command.item,
            this.bindings,
            true,
          ).lineage
        : undefined

    let capture = session.captures.get(key)

    if (
      !capture ||
      capture.round !== session.token ||
      capture.target !== target ||
      capture.leveling !== leveling ||
      capture.stats !== stats ||
      capture.reservation !== reservation ||
      capture.item !== item ||
      capture.itemVersion !== itemVersion ||
      capture.selection !== selection ||
      capture.lineage?.length !== lineage?.length ||
      capture.lineage?.some((entry, index) => entry !== lineage?.[index])
    ) {
      capture = Object.freeze({
        round: session.token,
        target,
        leveling,
        stats,
        reservation,
        itemVersion,
        item,
        selection,
        lineage,
      })
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

    if (command.type === 'queue-item') {
      if (command.inventory) {
        const panel = scene.data.components.find(
          (entry) => entry.id === command.inventory && entry.type === 'inventory',
        )

        if (
          scene.type !== 'game' ||
          panel?.type !== 'inventory' ||
          panel.readOnly ||
          scene.game.inventorySelection?.get(scene, command.inventory)?.item !== command.item
        )
          return false
      }

      return this.itemIssue(scene, id, command.item) === undefined
    }

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
    const itemsBefore = session.plan.flatMap((entry) => (entry.item ? [entry.item] : [])).join(',')

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

    if (command.type === 'queue-item') {
      const move = this.itemMove(definition, command.item)!

      const item = this.inventory?.snapshot.find((item) => item.id === command.item)
      const use = item && this.lifecycle.currentGame?.data.inventory?.itemTypes[item.itemType]?.use

      if (!item || !use || !this.inventory?.reserveItem) return

      if (this.inventory.reserveItem(command.item, session.itemReservation)) return
      session.itemVersions.set(command.item, {})

      if (definition.moves[move]?.cooldown) session.reservations.set(move, {})
      session.plan.push({
        move,
        item: command.item,
        itemType: item.itemType,
        consume: use.consumption === 'consume',
        target:
          combatMoveTarget(definition.moves[move]!) === 'self'
            ? definition.player.id
            : session.target!.id,
      })
    } else if (command.type === 'queue-move') {
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

        if (removed?.item) {
          this.inventory?.releaseItems?.(session.itemReservation, removed.item)
          session.itemVersions.set(removed.item, {})
        }

        if (removed && definition.moves[removed.move]?.cooldown)
          session.reservations.set(removed.move, {})
      }
    } else if (command.type === 'clear') {
      this.inventory?.releaseItems?.(session.itemReservation)

      for (const move of session.plan) if (move.item) session.itemVersions.set(move.item, {})

      for (const move of session.plan)
        if (definition.moves[move.move]?.cooldown) session.reservations.set(move.move, {})
      session.plan = []
      session.escape = false
    } else if (command.type === 'escape') {
      this.inventory?.releaseItems?.(session.itemReservation)

      for (const move of session.plan) if (move.item) session.itemVersions.set(move.item, {})

      for (const move of session.plan)
        if (definition.moves[move.move]?.cooldown) session.reservations.set(move.move, {})
      session.plan = []
      session.escape = true
    } else if (command.type === 'end-turn') {
      this.resolve(definition, session)

      return
    }

    const errors: unknown[] = []

    const itemsAfter = session.plan.flatMap((entry) => (entry.item ? [entry.item] : [])).join(',')

    for (const notify of [
      () => {
        if (itemsBefore !== itemsAfter) this.inventory?.notifyReservations?.()
      },
      () => this.notify(),
    ])
      try {
        notify()
      } catch (error) {
        errors.push(error)
      }

    if (errors.length)
      throw new AggregateError(errors, 'Combat plan committed but observers failed')
  }
  private resolve(definition: CombatDefinition, session: Session): void {
    const values = this.health(definition)

    if (!values) return
    const stats = this.statValues(definition, false)
    const version = this.stats?.encounterVersion(definition)

    if (!stats || this.stats?.encounterIssue(definition)) return
    let notifyProgression: (() => void) | undefined
    let notifyRewards: (() => void) | undefined
    let notifyInventory: (() => void) | undefined
    const hadItems = session.plan.some((entry) => entry.item)

    try {
      for (const queued of session.plan) {
        if (!queued.item) continue

        const selected = usableItem(
          this.inventory,
          this.lifecycle.currentGame?.data.inventory,
          queued.item,
          this.bindings,
          true,
        )

        if (
          selected.reason ||
          selected.owner !== definition.itemUse?.owner ||
          !this.inventory?.isReserved?.(queued.item)
        )
          throw new Error('Queued item is unavailable')
      }

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

      const consumed = session.plan
        .filter(
          (queued) => queued.item && queued.consume && candidate.usedItems.includes(queued.item),
        )
        .map((queued) => queued.item!)

      const removal = consumed.length
        ? this.inventory?.prepareRemove?.(consumed, session.itemReservation)
        : undefined

      if (consumed.length && !removal?.isCurrent())
        throw new Error('Item consumption is unavailable')

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
        (removal && !removal.isCurrent()) ||
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

      removal?.commit()
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
      this.inventory?.releaseItems?.(session.itemReservation)
      session.plan = []
      session.escape = false
      session.token = {}
      notifyInventory = () => {
        if (removal) removal.notify()
        else if (hadItems) this.inventory?.notifyReservations?.()
      }

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
      for (const notify of [notifyInventory, notifyProgression, notifyRewards, this.invalidate])
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
        /\{(actor|target|damage|blocked|guard|defended|status|amount|duration|item)\}/g,
        (_, key: string) =>
          key === 'item'
            ? (this.lifecycle.currentGame?.data.inventory?.itemTypes[entry.item ?? '']?.label ??
              entry.item ??
              '')
            : key === 'status'
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
  private itemMove(definition: CombatDefinition, item: string): string | undefined {
    const selected = this.inventory?.snapshot.find((entry) => entry.id === item)

    if (!selected || !definition.itemUse?.itemTypes.includes(selected.itemType)) return

    return this.lifecycle.currentGame?.data.inventory?.itemTypes[selected.itemType]?.use?.ability.id
  }

  unfinishedOwner(owner: string): boolean {
    return [...this.sessions].some(([id, session]) => {
      const definition = this.lifecycle.currentGame?.data.combat?.get(id)

      return (
        session.started &&
        !session.outcome &&
        (definition?.itemUse?.owner === owner || definition?.player.equipmentOwner === owner)
      )
    })
  }

  itemIssue(scene: SceneInstance, component: string, item: string): string | undefined {
    const definition = this.definition(scene, component)

    const selected = usableItem(
      this.inventory,
      scene.type === 'game' ? scene.game.data.inventory : undefined,
      item,
      this.bindings,
    )

    if (selected.reason) return selected.reason

    if (
      !definition ||
      !selected.use ||
      !this.inventory?.reserveItem ||
      !this.inventory.prepareRemove ||
      !this.inventory.releaseItems ||
      !this.inventory.isReserved ||
      !this.state
    )
      return selected.messages.unavailable

    if (selected.owner !== definition.itemUse?.owner) return selected.messages.owner
    const moveId = this.itemMove(definition, item)
    const move = moveId && definition.moves[moveId]

    if (!moveId || !move || !selected.use.contexts.includes('combat'))
      return selected.messages.context
    const snapshot = this.snapshot(scene, component)

    if (!snapshot || snapshot.issue || snapshot.phase !== 'planning' || snapshot.escape)
      return selected.messages.unavailable
    const issue = this.moveIssue(scene, component, moveId)

    if (issue) return issue

    if (move.apCost > snapshot.remainingAp) return selected.messages.ap
    const target = combatMoveTarget(move) === 'self' ? definition.player.id : snapshot.target

    if (!target || !snapshot.health[target]) return selected.messages.target

    if (!abilityCanMatter(move, definition, snapshot, target)) return selected.messages.noEffect
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

    for (const session of this.sessions.values())
      this.inventory?.releaseItems?.(session.itemReservation)
    this.sessions.clear()
    this.listeners.clear()
  }
}
