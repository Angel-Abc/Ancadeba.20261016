import { GameLeveling } from './leveling.js'
import { GameCombatRewards } from './combatRewards.js'
import type { ILogger, IMonotonicClock, ITaskScheduler } from '@ancadeba/utilities'
import { ActionProcessor } from './actionProcessor.js'
import type { GameRules } from './actions.js'
import type { GameInstance, IGameRuntime, IGameLifecycle } from './gameLifecycle.js'
import { GameActionBar } from './actionBar.js'
import { GameMapMovement } from './mapMovement.js'
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

/** Owns actions, bindings, and private host timers for one playthrough. */
export class GameActionRuntime implements IGameRuntime {
  readonly actions: ActionProcessor
  readonly bindings: GameBindings
  readonly actionBar: GameActionBar | undefined
  readonly mapMovement: GameMapMovement | undefined
  readonly nearby: GameNearbyContext | undefined
  readonly inventorySelection: GameInventoryContext | undefined
  readonly equipment: GameEquipment | undefined
  readonly trading: GameTrading | undefined
  readonly combatRewards: GameCombatRewards | undefined
  readonly leveling: GameLeveling
  readonly combat: GameCombat | undefined
  private readonly timers: TimerService
  private started = false
  private disposed = false

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
  ) {
    this.timers = new TimerService(messages, scheduler, clock, allocateTimerId)
    this.mapMovement = lifecycle ? new GameMapMovement(lifecycle, scheduler) : undefined
    this.bindings = new GameBindings(
      {
        state: () => game.state,
        progression: () => this.actions.progression,
        leveling: () => this.leveling?.bindingValues,
      },
      messages,
    )
    this.leveling = new GameLeveling(game, this.bindings, stateTransactions, () =>
      this.bindings.invalidate(),
    )
    const numericState = game.data.leveling?.size ? this.leveling : stateTransactions
    this.nearby = lifecycle ? new GameNearbyContext(lifecycle, this.bindings) : undefined
    this.inventorySelection = lifecycle
      ? new GameInventoryContext(lifecycle, game.inventory)
      : undefined
    this.equipment =
      lifecycle && this.inventorySelection
        ? new GameEquipment(lifecycle, this.inventorySelection, game.inventory)
        : undefined
    this.trading =
      lifecycle && this.inventorySelection
        ? new GameTrading(
            lifecycle,
            this.inventorySelection,
            game.inventory,
            this.bindings,
            game.data.leveling?.size ? this.leveling : tradeState,
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
            (cost) => {
              const prepared = this.actions.prepareProgression(cost)

              return {
                ...prepared,
                commit: () => {
                  prepared.commit()
                  // This internal projection only writes the authored clock field; it never notifies observers.
                  updateAuthoredClock?.(prepared.progression.worldTimeMs)
                },
              }
            },
            () => this.bindings.invalidate(),
            this.combatRewards,
            this.leveling,
          )
        : undefined
    } catch (error) {
      this.actionBar?.dispose()
      this.combat?.dispose()
      this.combatRewards?.dispose()
      this.leveling.dispose()
      this.trading?.dispose()
      this.equipment?.dispose()
      this.inventorySelection?.dispose()
      this.nearby?.dispose()
      this.bindings.dispose()
      this.mapMovement?.dispose()
      this.timers.dispose()
      messages.dispose()
      throw error
    }
  }

  start(): void {
    if (this.disposed || this.started || !this.isRunning()) return
    this.started = true
    this.onStart()
    this.actions.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.actionBar?.dispose()
    this.combat?.dispose()
    this.combatRewards?.dispose()
    this.leveling.dispose()
    this.trading?.dispose()
    this.equipment?.dispose()
    this.inventorySelection?.dispose()
    this.nearby?.dispose()
    this.mapMovement?.dispose()
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
