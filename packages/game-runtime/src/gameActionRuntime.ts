import { GameQuests } from './quests.js'
import { GameDialogue } from './dialogue.js'
import type { IStoryStateTransactions } from './storyState.js'
import { GameItemUse } from './itemUse.js'
import { GameLeveling } from './leveling.js'
import { GameCombatStats } from './combatStats.js'
import { GameCombatRewards } from './combatRewards.js'
import type { ILogger, IMonotonicClock, ITaskScheduler } from '@ancadeba/utilities'
import { ActionProcessor } from './actionProcessor.js'
import type { GameRules } from './actions.js'
import type { GameInstance, IGameRuntime, IGameLifecycle } from './gameLifecycle.js'
import { GameActionBar } from './actionBar.js'
import { GameMapMovement } from './mapMovement.js'
import { GameMapObjects } from './mapObjects.js'
import { GameNearbyContext } from './nearbyContext.js'
import { GameInventoryContext } from './inventoryContext.js'
import { GameEquipment } from './equipment.js'
import { GameTrading } from './trading.js'
import type { ITradeState } from './tradeState.js'
import type { IStateTransactions } from './stateTransactions.js'
import { GameCombat } from './combat.js'
import { GameBindings } from './gameBindings.js'
import type { GameMessageScope } from './gameMessageScope.js'
import { TimerService, type TimerId } from './timers.js'
import type { GameSave } from '@ancadeba/schemas'
import type { PreparedProgression } from './progression.js'

/** Owns actions, bindings, and private host timers for one playthrough. */
export class GameActionRuntime implements IGameRuntime {
  readonly quests: GameQuests | undefined
  readonly dialogue: GameDialogue | undefined
  readonly actions: ActionProcessor
  readonly bindings: GameBindings
  readonly actionBar: GameActionBar | undefined
  readonly mapMovement: GameMapMovement | undefined
  readonly mapObjects: GameMapObjects | undefined
  readonly nearby: GameNearbyContext | undefined
  readonly inventorySelection: GameInventoryContext | undefined
  readonly equipment: GameEquipment | undefined
  readonly trading: GameTrading | undefined
  readonly combatRewards: GameCombatRewards | undefined
  readonly leveling: GameLeveling
  readonly combatStats: GameCombatStats
  readonly itemUse: GameItemUse | undefined
  readonly combat: GameCombat | undefined
  private readonly timers: TimerService
  private started = false
  private disposed = false

  save(): Pick<
    GameSave,
    'combat' | 'rewards' | 'quests' | 'dialogue' | 'maps' | 'mapPositions' | 'leveling'
  > {
    return {
      combat: this.combat?.save() ?? {},
      rewards: this.combatRewards?.save() ?? {},
      quests: this.quests?.save() ?? { records: {} },
      dialogue: this.dialogue?.save() ?? {},
      maps: this.mapMovement?.save() ?? {},
      mapPositions: this.mapMovement?.savePositions() ?? {},
      leveling: this.leveling.save(),
    }
  }

  restore(save: GameSave, game: GameInstance): void {
    const scene = game.data.scenes.get(save.scene)

    if (scene?.type !== 'game') throw new Error('Invalid saved scene')

    // Validate the candidate playthrough before the lifecycle releases current progress.
    for (const [id, owner] of Object.entries(game.data.inventory?.owners ?? {}))
      if (owner.combatStats && !this.combatStats.baseSnapshot(id))
        throw new Error('Invalid saved equipment stats')

    for (const id of game.data.leveling?.keys() ?? [])
      if (!this.leveling.snapshot(id)?.available)
        throw new Error('Invalid saved character progression')

    this.mapMovement?.restorePositions(game.data, {
      ...save.mapPositions,
      [save.scene]: { ...save.maps, ...save.mapPositions?.[save.scene] },
    })

    if (
      (!this.quests && (Object.keys(save.quests.records).length || save.quests.tracked)) ||
      (!this.dialogue && Object.keys(save.dialogue).length)
    )
      throw new Error('Incompatible saved story')
    this.actions.restoreProgression(save.progression)
    this.leveling.restore(save.leveling)
    this.quests?.restore(save.quests)
    this.dialogue?.restore(save.dialogue)
    this.combatRewards?.restore(save.rewards)
    this.combat?.restore(save.combat, game.data)
  }

  constructor(
    game: GameInstance,
    rules: GameRules,
    readonly messages: GameMessageScope,
    scheduler: ITaskScheduler,
    clock: IMonotonicClock,
    logger: ILogger,
    private readonly isRunning: () => boolean,
    private readonly onStart: () => void,
    allocateTimerId: () => TimerId,
    private readonly onDispose: () => void,
    lifecycle?: IGameLifecycle,
    tradeState?: ITradeState,
    stateTransactions: IStateTransactions | undefined = tradeState,
    updateAuthoredClock?: (worldTimeMs: number) => void,
    storyState?: IStoryStateTransactions,
  ) {
    this.timers = new TimerService(messages, scheduler, clock, allocateTimerId)
    this.bindings = new GameBindings(
      {
        state: () => game.state,
        quests: () => this.quests?.bindingValues,
        progression: () => this.actions.progression,
        leveling: () => this.leveling?.bindingValues,
        combatStats: () => this.combatStats?.bindingValues,
      },
      messages,
    )

    const readObjectState = (path: readonly string[]) => {
      const result = this.bindings.read({ source: 'game.state', path })

      return result.status === 'resolved' ? result.value : undefined
    }

    const dynamicObjects = [...game.data.scenes.values()].some((scene) =>
      scene.components.some(
        (component) =>
          component.type === 'map-view' &&
          component.map.objects?.some((object) => object.states?.length),
      ),
    )

    const prepareProgression = (cost: number): PreparedProgression => {
      const prepared = this.actions.prepareProgression(cost)

      return {
        ...prepared,
        commit: () => {
          prepared.commit()
          // Clock projection is part of the commit and never notifies observers by itself.
          updateAuthoredClock?.(prepared.progression.worldTimeMs)
        },
      }
    }

    this.mapMovement = lifecycle
      ? new GameMapMovement(
          lifecycle,
          scheduler,
          (scene, mapView, trigger) => {
            this.actions.requestScoped(
              trigger.action,
              Object.freeze({
                scene: scene.data.id,
                mapView,
                trigger: trigger.id,
                x: trigger.x,
                y: trigger.y,
              }),
              () => !scene.disposed && lifecycle.activeScene === scene,
            )
          },
          dynamicObjects
            ? {
                read: readObjectState,
                subscribe: (listener) => this.bindings.subscribeChanges(listener),
              }
            : undefined,
          (cost) => {
            if (!this.isRunning()) return

            try {
              return prepareProgression(cost)
            } catch (error) {
              logger.error('MapMovement', 'Movement progression could not be prepared', error)

              return undefined
            }
          },
        )
      : undefined
    this.mapObjects =
      lifecycle && this.mapMovement
        ? new GameMapObjects(
            lifecycle,
            this.mapMovement,
            (action, payload, isCurrent) => {
              this.actions.requestScoped(action, payload, isCurrent)
            },
            readObjectState,
          )
        : undefined

    const statState: IStateTransactions | undefined = stateTransactions
      ? {
          prepare: (writes) =>
            this.combatStats
              ? this.combatStats.prepareState(writes)
              : stateTransactions.prepare(writes),
        }
      : undefined

    this.leveling = new GameLeveling(game, this.bindings, statState, () =>
      this.bindings.invalidate(),
    )
    const numericState = game.data.leveling?.size ? this.leveling : statState
    this.combatStats = new GameCombatStats(game, this.bindings, stateTransactions, () =>
      this.bindings.invalidate(),
    )
    this.leveling.setHealthBonus((path) => this.combatStats.healthBonus(path))
    this.nearby = lifecycle ? new GameNearbyContext(lifecycle, this.bindings) : undefined
    this.inventorySelection = lifecycle
      ? new GameInventoryContext(lifecycle, game.inventory)
      : undefined
    this.equipment =
      lifecycle && this.inventorySelection
        ? new GameEquipment(lifecycle, this.inventorySelection, game.inventory, this.combatStats)
        : undefined
    this.trading =
      lifecycle && this.inventorySelection
        ? new GameTrading(
            lifecycle,
            this.inventorySelection,
            game.inventory,
            this.bindings,
            game.data.leveling?.size
              ? this.leveling
              : tradeState
                ? { prepare: (writes) => this.combatStats.prepareState(writes, tradeState) }
                : undefined,
            () => this.bindings.invalidate(),
          )
        : undefined
    this.combatRewards = lifecycle
      ? new GameCombatRewards(
          game,
          lifecycle,
          this.bindings,
          numericState,
          game.inventory,
          this.inventorySelection,
          () => this.bindings.invalidate(),
        )
      : undefined
    this.itemUse =
      lifecycle &&
      this.inventorySelection &&
      Object.values(game.data.inventory?.itemTypes ?? {}).some((item) => item.use)
        ? new GameItemUse(
            lifecycle,
            this.inventorySelection,
            game.inventory,
            this.bindings,
            numericState,
            () => this.combat,
            messages,
            () => this.bindings.invalidate(),
          )
        : undefined
    this.quests =
      lifecycle && (game.data.quests?.size || game.data.dialogues?.size)
        ? new GameQuests(game, lifecycle, this.bindings, numericState, storyState, messages, () =>
            this.bindings.invalidate(),
          )
        : undefined
    this.dialogue =
      lifecycle && this.nearby && this.quests
        ? new GameDialogue(game, lifecycle, this.nearby, this.bindings, this.quests, messages)
        : undefined
    this.actionBar = lifecycle
      ? new GameActionBar(
          lifecycle,
          game.inventory,
          this.mapMovement,
          this.nearby,
          this.inventorySelection,
          this.equipment,
          this.trading,
          () => this.combat,
          () => this.itemUse,
          () => this.dialogue,
          () => this.quests,
          this.mapObjects,
        )
      : undefined

    try {
      this.actions = new ActionProcessor(
        rules,
        messages,
        this.timers,
        clock,
        logger,
        isRunning,
        (event, request) => this.actionBar?.handleInput(event, request) ?? false,
      )
      this.combat = lifecycle
        ? new GameCombat(
            lifecycle,
            this.bindings,
            numericState,
            messages,
            prepareProgression,
            () => this.bindings.invalidate(),
            this.combatRewards,
            this.leveling,
            this.combatStats,
            game.inventory,
          )
        : undefined
    } catch (error) {
      this.dialogue?.dispose()
      this.quests?.dispose()
      this.itemUse?.dispose()
      this.actionBar?.dispose()
      this.combat?.dispose()
      this.combatRewards?.dispose()
      this.leveling.dispose()
      this.combatStats.dispose()
      this.trading?.dispose()
      this.equipment?.dispose()
      this.inventorySelection?.dispose()
      this.nearby?.dispose()
      this.bindings.dispose()
      this.mapMovement?.dispose()
      this.mapObjects?.dispose()
      this.timers.dispose()
      messages.dispose()
      throw error
    }
  }

  start(): void {
    if (this.disposed || this.started || !this.isRunning()) return
    this.started = true
    this.onStart()
    this.quests?.start()
    this.itemUse?.start()
    this.actions.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dialogue?.dispose()
    this.quests?.dispose()
    this.itemUse?.dispose()
    this.actionBar?.dispose()
    this.combat?.dispose()
    this.combatRewards?.dispose()
    this.leveling.dispose()
    this.combatStats.dispose()
    this.trading?.dispose()
    this.equipment?.dispose()
    this.inventorySelection?.dispose()
    this.nearby?.dispose()
    this.mapMovement?.dispose()
    this.mapObjects?.dispose()
    this.bindings.dispose()

    try {
      this.actions.dispose()
    } finally {
      try {
        this.timers.dispose()
      } finally {
        this.messages.dispose()
        this.onDispose()
      }
    }
  }
}
