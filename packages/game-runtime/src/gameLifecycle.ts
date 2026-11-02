import type { GameData, SceneData } from './gameData.js'
import type { IGameActions } from './actions.js'
import type { IGameBindings } from './gameBindings.js'

export interface IGameRuntime {
  readonly actions: IGameActions
  readonly bindings: IGameBindings
  start(): void
  dispose(): void
}

export type GameRuntimeFactory = (game: GameInstance) => IGameRuntime

export interface GameInstance<TState = unknown> {
  readonly data: GameData
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

export interface IGameLifecycle<TGameState = unknown, TSceneState = unknown> {
  readonly currentGame: GameInstance<TGameState> | undefined
  readonly activeScene: SceneInstance<TGameState, TSceneState> | undefined
  readonly disposed: boolean
  /** Observe committed scene changes synchronously; callbacks must not start transitions. */
  subscribeSceneChanges(handler: SceneChangeHandler<TGameState, TSceneState>): () => void
  /** Bind once, before starting a playthrough. The lifecycle owns each returned runtime. */
  bindGameRuntime(factory: GameRuntimeFactory): void
  startGame(): GameInstance<TGameState>
  enterScene(id: string): SceneInstance<TGameState, TSceneState>
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

  get actions(): IGameActions | undefined {
    return this.runtime?.actions
  }

  get bindings(): IGameBindings | undefined {
    return this.runtime?.bindings
  }

  initialize(factory: GameRuntimeFactory | undefined): void {
    this.runtime = factory?.(this)
  }

  start(): void {
    this.runtime?.start()
  }

  override dispose(): void {
    const runtime = this.runtime
    this.runtime = undefined
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
  private disposalRequested = false
  private readonly sceneSubscribers = new Set<SceneChangeHandler<TGameState, TSceneState>>()

  constructor(
    private readonly data: GameData,
    private readonly factories: GameLifecycleFactories<TGameState, TSceneState>,
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

  startGame(): GameInstance<TGameState> {
    return this.transition(() => {
      const next = new OwnedGameInstance(
        this.data,
        this.factories.createGameState(this.data),
        this.factories.disposeGameState,
      )
      try {
        next.initialize(this.runtimeFactory)
      } catch (error) {
        try {
          next.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Game runtime creation failed')
        }
        throw error
      }
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
      const scene = this.detachGameScene()
      release(scene, previous)
      return next
    })
  }

  enterScene(id: string): SceneInstance<TGameState, TSceneState> {
    return this.transition(() => {
      const data = this.data.scenes.get(id)
      if (!data) throw new Error(`Unknown scene: ${id}`)
      const game = this.game
      if (data.type === 'game' && !game) throw new Error(`Scene ${id} requires a current game`)
      if (this.scene?.context.data.id === id) return this.scene.context

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
      const previous = this.scene
      this.scene = { instance, context }
      release(previous?.instance)
      return context
    })
  }

  leaveScene(): void {
    this.transition(() => {
      const previous = this.scene
      this.scene = undefined
      release(previous?.instance)
    })
  }

  endGame(): void {
    this.transition(() => {
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
    this.scene = undefined
    this.game = undefined
    release(scene?.instance, game)
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
