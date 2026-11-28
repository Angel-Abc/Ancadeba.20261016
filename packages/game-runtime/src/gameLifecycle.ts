import type { IGameQuests } from './quests.js'
import type { IGameDialogue } from './dialogue.js'
import type { IGameItemUse } from './itemUse.js'
import type { IGameLeveling } from './leveling.js'
import type { IGameCombatRewards } from './combatRewards.js'
import type { GameData, SceneData } from './gameData.js'
import type { IGameActions } from './actions.js'
import type { IGameBindings } from './gameBindings.js'
import { GameInventory, type IGameInventory } from './inventory.js'
import { GameCrafting, type IGameCrafting } from './crafting.js'
import type { IGameActionBar } from './actionBar.js'
import type { IGameMapMovement } from './mapMovement.js'
import type { IGameMapObjects } from './mapObjects.js'
import type { IGameNearby } from './nearbyContext.js'
import type { IGameInventorySelection } from './inventoryContext.js'
import type { IGameEquipment } from './equipment.js'
import type { IGameTrading } from './trading.js'
import type { IGameCombat } from './combat.js'
import {
  sceneEntrance,
  type MessageHistoryEntry,
  type SceneEntrance,
  type SceneTransition,
} from '@ancadeba/schemas'
import { canEnterScene } from './sceneNavigation.js'
import { runtimeText } from './runtimeText.js'

export interface IGameRuntime {
  readonly messageHistory?: readonly MessageHistoryEntry[] | undefined
  setPaused?(paused: boolean): void
  readonly mapObjects?: IGameMapObjects | undefined
  readonly quests?: IGameQuests | undefined
  readonly dialogue?: IGameDialogue | undefined
  readonly itemUse?: IGameItemUse | undefined
  readonly combatStats?: IGameCombatStats | undefined
  readonly combatRewards?: IGameCombatRewards | undefined
  readonly leveling?: IGameLeveling | undefined
  readonly combat?: IGameCombat | undefined
  readonly trading?: IGameTrading | undefined
  readonly inventorySelection?: IGameInventorySelection | undefined
  readonly equipment?: IGameEquipment | undefined
  readonly nearby?: IGameNearby | undefined
  readonly mapMovement?: IGameMapMovement | undefined
  readonly actionBar?: IGameActionBar | undefined
  readonly actions: IGameActions
  readonly bindings: IGameBindings
  start(): void
  dispose(): void
}

export type GameRuntimeFactory = (game: GameInstance) => IGameRuntime

export interface GameInstance<TState = unknown> {
  readonly messageHistory?: readonly MessageHistoryEntry[] | undefined
  readonly mapObjects?: IGameMapObjects | undefined
  readonly quests?: IGameQuests | undefined
  readonly dialogue?: IGameDialogue | undefined
  readonly itemUse?: IGameItemUse | undefined
  readonly combatStats?: IGameCombatStats | undefined
  readonly combatRewards?: IGameCombatRewards | undefined
  readonly leveling?: IGameLeveling | undefined
  readonly combat?: IGameCombat | undefined
  readonly trading?: IGameTrading | undefined
  readonly inventorySelection?: IGameInventorySelection | undefined
  readonly equipment?: IGameEquipment | undefined
  readonly nearby?: IGameNearby | undefined
  readonly mapMovement?: IGameMapMovement | undefined
  readonly actionBar?: IGameActionBar | undefined
  readonly data: GameData
  readonly inventory?: IGameInventory | undefined
  readonly crafting?: IGameCrafting | undefined
  readonly actions: IGameActions | undefined
  readonly bindings: IGameBindings | undefined
  /** Released on disposal. Retained instances must no longer be used. */
  readonly state: TState | undefined
  readonly disposed: boolean
}

interface SceneInstanceState<TState> {
  readonly data: SceneData
  readonly state: TState | undefined
  readonly disposed: boolean
}

export type SceneInstance<
  TGameState = unknown,
  TSceneState = unknown,
> = SceneInstanceState<TSceneState> &
  (
    | { readonly type: 'stand-alone' }
    | { readonly type: 'game'; readonly game: GameInstance<TGameState> }
  )

export interface SceneChange<TGameState = unknown, TSceneState = unknown> {
  readonly previous: SceneInstance<TGameState, TSceneState> | undefined
  readonly current: SceneInstance<TGameState, TSceneState> | undefined
}

export type SceneChangeHandler<TGameState = unknown, TSceneState = unknown> = (
  change: SceneChange<TGameState, TSceneState>,
) => void

export interface GameLifecycleFactories<TGameState, TSceneState> {
  /** Return fresh state for each playthrough or scene activation. */
  readonly createGameState: (data: GameData) => TGameState
  readonly createSceneState: (data: SceneData) => TSceneState
  readonly disposeGameState?: (state: TGameState) => void
  readonly disposeSceneState?: (state: TSceneState) => void
}

interface PreparedGameChange {
  readonly destination?: SceneTransition | undefined
  commit(): void
}

export interface IGameLifecycle<TGameState = unknown, TSceneState = unknown> {
  readonly suspendedScene?: SceneInstance<TGameState, TSceneState> | undefined
  openMenu?(id: string): void
  resumeGame?(): void
  readonly currentGame: GameInstance<TGameState> | undefined
  readonly activeScene: SceneInstance<TGameState, TSceneState> | undefined
  readonly disposed: boolean
  /** Observe committed scene changes synchronously; callbacks must not start transitions. */
  subscribeSceneChanges(handler: SceneChangeHandler<TGameState, TSceneState>): () => void
  /** Bind once, before starting a playthrough. The lifecycle owns each returned runtime. */
  bindGameRuntime(factory: GameRuntimeFactory): void
  /** Preparation runs before runtime creation; restoration runs before replacing the current game. */
  startGame(
    prepare?: (game: GameInstance<TGameState>) => void,
    restore?: (game: GameInstance<TGameState>) => void,
  ): GameInstance<TGameState>
  /** Validate a disposable candidate without starting it or replacing current progress. */
  validateGame(
    prepare: (game: GameInstance<TGameState>) => void,
    restore: (game: GameInstance<TGameState>) => void,
  ): void
  /** Stage the destination and changes before publishing a new or existing playthrough. */
  applyGameChange?(prepare: (game: GameInstance<TGameState>) => PreparedGameChange): void
  enterScene(id: string, entrance?: SceneEntrance): SceneInstance<TGameState, TSceneState>
  leaveScene(): void
  endGame(): void
  dispose(): void
}

class OwnedInstance<TData, TState> {
  private current: { value: TState } | undefined

  constructor(
    readonly data: TData,
    state: TState,
    private readonly release?: (state: TState) => void,
  ) {
    this.current = { value: state }
  }

  get state(): TState | undefined {
    return this.current?.value
  }

  get disposed(): boolean {
    return this.current === undefined
  }

  dispose(): void {
    const current = this.current

    if (!current) return
    this.current = undefined
    this.release?.(current.value)
  }
}

class OwnedGameInstance<TState> extends OwnedInstance<GameData, TState> {
  private runtime: IGameRuntime | undefined
  private inventoryState: GameInventory | undefined
  crafting: IGameCrafting | undefined

  setPaused(paused: boolean): void {
    this.runtime?.setPaused?.(paused)
  }

  get quests(): IGameQuests | undefined {
    return this.runtime?.quests
  }
  get dialogue(): IGameDialogue | undefined {
    return this.runtime?.dialogue
  }

  get messageHistory(): readonly MessageHistoryEntry[] | undefined {
    return this.runtime?.messageHistory
  }

  get itemUse(): IGameItemUse | undefined {
    return this.runtime?.itemUse
  }

  get combatRewards(): IGameCombatRewards | undefined {
    return this.runtime?.combatRewards
  }

  get leveling(): IGameLeveling | undefined {
    return this.runtime?.leveling
  }
  get combatStats(): IGameCombatStats | undefined {
    return this.runtime?.combatStats
  }

  get combat(): IGameCombat | undefined {
    return this.runtime?.combat
  }

  get trading(): IGameTrading | undefined {
    return this.runtime?.trading
  }

  get inventorySelection(): IGameInventorySelection | undefined {
    return this.runtime?.inventorySelection
  }

  get equipment(): IGameEquipment | undefined {
    return this.runtime?.equipment
  }

  get nearby(): IGameNearby | undefined {
    return this.runtime?.nearby
  }

  get mapMovement(): IGameMapMovement | undefined {
    return this.runtime?.mapMovement
  }

  get mapObjects(): IGameMapObjects | undefined {
    return this.runtime?.mapObjects
  }

  get actionBar(): IGameActionBar | undefined {
    return this.runtime?.actionBar
  }

  get inventory(): IGameInventory | undefined {
    return this.inventoryState
  }

  get actions(): IGameActions | undefined {
    return this.runtime?.actions
  }

  get bindings(): IGameBindings | undefined {
    return this.runtime?.bindings
  }

  initialize(
    factory: GameRuntimeFactory | undefined,
    prepare?: (game: GameInstance<TState>) => void,
  ): void {
    if (this.data.inventory) {
      this.inventoryState = new GameInventory(this.data.inventory, (key, values) =>
        runtimeText(this.data, key, values),
      )
      this.crafting = new GameCrafting(this.data.inventory, this.inventoryState)
    }

    prepare?.(this)
    this.runtime = factory?.(this)
  }

  start(): void {
    this.runtime?.start()
  }

  override dispose(): void {
    const runtime = this.runtime
    this.runtime = undefined
    this.inventoryState?.dispose()
    this.inventoryState = undefined
    this.crafting = undefined
    const errors: unknown[] = []

    try {
      runtime?.dispose()
    } catch (error) {
      errors.push(error)
    }

    try {
      super.dispose()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) throw errors[0]

    if (errors.length > 1) throw new AggregateError(errors, 'Game cleanup failed')
  }
}

function release(...instances: ({ dispose(): void } | undefined)[]): void {
  const errors: unknown[] = []

  for (const instance of instances) {
    try {
      instance?.dispose()
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length) throw new AggregateError(errors, 'Lifecycle cleanup failed')
}

/** Owns playthrough and scene lifetimes independently of the engine's technical session. */
export class GameLifecycle<TGameState, TSceneState> implements IGameLifecycle<
  TGameState,
  TSceneState
> {
  private game: OwnedGameInstance<TGameState> | undefined
  private runtimeFactory: GameRuntimeFactory | undefined
  private scene:
    | {
        instance: OwnedInstance<SceneData, TSceneState>
        context: SceneInstance<TGameState, TSceneState>
      }
    | undefined
  private isDisposed = false
  private transitioning = false
  private suspended: typeof this.scene
  private disposalRequested = false
  private readonly sceneSubscribers = new Set<SceneChangeHandler<TGameState, TSceneState>>()

  get suspendedScene(): SceneInstance<TGameState, TSceneState> | undefined {
    return this.suspended?.context
  }

  openMenu(id: string): void {
    const data = this.data.scenes.get(id)

    if (data?.type !== 'stand-alone') throw new Error('Menus require a stand-alone scene')

    if (!this.game || (!this.suspended && this.scene?.context.type !== 'game')) return

    if (!this.suspended) {
      const origin = this.scene

      // Queued actions belong to the gameplay snapshot and may themselves change scenes.
      if (this.settleBeforePause?.() === false || this.scene !== origin) return
    }

    this.transition(() => {
      if (this.scene?.context.data.id === id) return

      const instance = new OwnedInstance(
        data,
        this.factories.createSceneState(data),
        this.factories.disposeSceneState,
      )

      const previous = this.suspended ? this.scene : undefined

      if (!this.suspended) {
        this.suspended = this.scene
        this.game!.setPaused(true)
      }

      this.scene = {
        instance,
        context: Object.freeze({
          type: 'stand-alone' as const,
          data,
          get state() {
            return instance.state
          },
          get disposed() {
            return instance.disposed
          },
        }),
      }
      release(previous?.instance)
    })
  }

  resumeGame(): void {
    if (!this.suspended) return
    this.transition(() => {
      const menu = this.scene
      this.scene = this.suspended
      this.suspended = undefined
      this.game?.setPaused(false)
      release(menu?.instance)
    })
  }

  private releaseMenu(game = this.game): void {
    if (!this.suspended) return
    const suspended = this.suspended
    this.suspended = undefined
    game?.setPaused(false)
    release(suspended.instance)
  }

  constructor(
    private readonly data: GameData,
    private readonly factories: GameLifecycleFactories<TGameState, TSceneState>,
    private readonly settleBeforePause?: () => boolean,
  ) {}

  get currentGame(): GameInstance<TGameState> | undefined {
    return this.game
  }

  get activeScene(): SceneInstance<TGameState, TSceneState> | undefined {
    return this.scene?.context
  }

  get disposed(): boolean {
    return this.isDisposed
  }

  subscribeSceneChanges(handler: SceneChangeHandler<TGameState, TSceneState>): () => void {
    if (this.isDisposed) throw new Error('Game lifecycle is disposed')
    const subscription: SceneChangeHandler<TGameState, TSceneState> = (change) => handler(change)
    this.sceneSubscribers.add(subscription)

    return () => {
      this.sceneSubscribers.delete(subscription)
    }
  }

  bindGameRuntime(factory: GameRuntimeFactory): void {
    this.transition(() => {
      if (this.runtimeFactory || this.game)
        throw new Error('Bind a game runtime once, before starting a game')
      this.runtimeFactory = factory
    })
  }

  startGame(
    prepare?: (game: GameInstance<TGameState>) => void,
    restore?: (game: GameInstance<TGameState>) => void,
  ): GameInstance<TGameState> {
    return this.transition(() => {
      const next = this.createGame(prepare, restore)

      const previous = this.game
      this.game = next

      try {
        next.start()
      } catch (error) {
        this.game = previous

        try {
          next.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Game runtime startup failed')
        }

        throw error
      }

      this.releaseMenu(previous)
      const scene = this.detachGameScene()
      release(scene, previous)

      return next
    })
  }

  validateGame(
    prepare: (game: GameInstance<TGameState>) => void,
    restore: (game: GameInstance<TGameState>) => void,
  ): void {
    this.transition(() => this.createGame(prepare, restore).dispose())
  }

  private createGame(
    prepare?: (game: GameInstance<TGameState>) => void,
    restore?: (game: GameInstance<TGameState>) => void,
  ): OwnedGameInstance<TGameState> {
    const next = new OwnedGameInstance(
      this.data,
      this.factories.createGameState(this.data),
      this.factories.disposeGameState,
    )

    try {
      next.initialize(this.runtimeFactory, prepare)
      restore?.(next)

      return next
    } catch (error) {
      try {
        next.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Game runtime creation failed')
      }

      throw error
    }
  }

  enterScene(id: string, entrance?: SceneEntrance): SceneInstance<TGameState, TSceneState> {
    return this.transition(() => {
      const data = this.data.scenes.get(id)

      if (!data) throw new Error(`Unknown scene: ${id}`)
      const game = this.game

      if (data.type === 'game' && !game) throw new Error(`Scene ${id} requires a current game`)

      const arrival = entrance && { ...entrance, position: { ...entrance.position } }

      if (arrival) {
        if (
          !game?.mapMovement ||
          !canEnterScene(
            this.data,
            { type: 'enter-scene', scene: id, ...arrival },
            game.mapMovement,
          )
        )
          throw new Error('Invalid destination map position')
      }

      if (this.scene?.context.data.id === id) {
        if (arrival) this.placeArrival(this.scene.context, arrival)

        return this.scene.context
      }

      return this.activateScene(this.createScene(data, game), arrival)
    })
  }

  private createScene(data: SceneData, game: GameInstance<TGameState> | undefined) {
    const instance = new OwnedInstance(
      data,
      this.factories.createSceneState(data),
      this.factories.disposeSceneState,
    )

    const scope =
      data.type === 'game'
        ? { type: 'game' as const, game: game! }
        : { type: 'stand-alone' as const }

    const context: SceneInstance<TGameState, TSceneState> = Object.freeze({
      ...scope,
      data,
      get state() {
        return instance.state
      },
      get disposed() {
        return instance.disposed
      },
    })

    return { instance, context }
  }

  private placeArrival(scene: SceneInstance, arrival: SceneEntrance) {
    const view = scene.data.components.find(({ id }) => id === arrival.mapView)

    const map =
      arrival.map ?? (view?.type === 'map-view' && view.followPlayer ? view.mapId : undefined)

    this.game!.mapMovement!.place(scene, arrival.mapView, arrival.position, map)
  }

  private activateScene(next: NonNullable<typeof this.scene>, arrival?: SceneEntrance) {
    const previous = this.scene
    this.releaseMenu()
    this.scene = next

    try {
      if (arrival) this.placeArrival(next.context, arrival)
    } finally {
      if (previous !== next) release(previous?.instance)
    }

    return next.context
  }

  applyGameChange(prepare: (game: GameInstance<TGameState>) => PreparedGameChange): void {
    this.transition(() => {
      const starting = !this.game
      const game = this.game ?? this.createGame()
      let next: typeof this.scene

      try {
        const change = prepare(game)
        const destination = change.destination

        if (destination) {
          const data = this.data.scenes.get(destination.scene)

          if (data?.type !== 'game') throw new Error('A submission requires a game scene')

          if (destination.position && !game.mapMovement)
            throw new Error('Map movement is unavailable')
          next = this.scene?.context.data.id === data.id ? this.scene : this.createScene(data, game)
        } else if (starting) throw new Error('Choose an opening scene')
        change.commit()

        if (starting) {
          this.game = game

          try {
            game.start()
          } catch (error) {
            this.game = undefined
            throw error
          }
        }

        if (next) this.activateScene(next, destination && sceneEntrance(destination))
      } finally {
        release(
          next !== this.scene ? next?.instance : undefined,
          starting && this.game !== game ? game : undefined,
        )
      }
    })
  }

  leaveScene(): void {
    this.transition(() => {
      const previous = this.scene
      this.scene = undefined
      this.releaseMenu()
      release(previous?.instance)
    })
  }

  endGame(): void {
    this.transition(() => {
      this.releaseMenu()
      const previous = this.game
      const scene = this.detachGameScene()
      this.game = undefined
      release(scene, previous)
    })
  }

  dispose(): void {
    if (this.isDisposed) return

    // Engine stop must also work from inside a state factory or cleanup callback.
    if (this.transitioning) {
      this.disposalRequested = true

      return
    }

    this.transition(() => this.disposeScopes())
  }

  private disposeScopes(): void {
    this.isDisposed = true
    const scene = this.scene
    const game = this.game
    const suspended = this.suspended
    this.suspended = undefined
    this.scene = undefined
    this.game = undefined
    release(scene?.instance, suspended?.instance, game)
  }

  private detachGameScene(): OwnedInstance<SceneData, TSceneState> | undefined {
    if (this.scene?.context.type !== 'game') return undefined
    const instance = this.scene.instance
    this.scene = undefined

    return instance
  }

  private transition<T>(perform: () => T): T {
    if (this.isDisposed) throw new Error('Game lifecycle is disposed')

    if (this.transitioning) throw new Error('A lifecycle transition is already in progress')
    this.transitioning = true
    let previous = this.activeScene
    let result!: T
    const errors: unknown[] = []

    try {
      try {
        result = perform()
      } catch (error) {
        errors.push(error)
      }

      do {
        if (this.disposalRequested) {
          this.disposalRequested = false

          try {
            this.disposeScopes()
          } catch (error) {
            errors.push(error)
          }
        }

        const current = this.activeScene

        if (current !== previous) {
          const change = Object.freeze({ previous, current })
          previous = current
          const failures: unknown[] = []

          for (const handler of [...this.sceneSubscribers]) {
            if (!this.sceneSubscribers.has(handler)) continue

            try {
              handler(change)
            } catch (error) {
              failures.push(error)
            }
          }

          if (failures.length)
            errors.push(new AggregateError(failures, 'Scene change subscribers failed'))
        }
      } while (this.disposalRequested)
    } finally {
      this.transitioning = false

      if (this.isDisposed) this.sceneSubscribers.clear()
    }

    if (errors.length === 1) throw errors[0]

    if (errors.length > 1) throw new AggregateError(errors, 'Lifecycle transition failed')

    return result
  }
}

import type { IGameCombatStats } from './combatStats.js'
