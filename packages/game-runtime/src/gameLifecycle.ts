import type { GameData, SceneData } from './gameData.js'

export interface GameInstance<TState = unknown> {
  readonly data: GameData
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

/** Owns playthrough and scene lifetimes independently of the engine's technical session. */
export class GameLifecycle<TGameState, TSceneState> implements IGameLifecycle<
  TGameState,
  TSceneState
> {
  private game: OwnedInstance<GameData, TGameState> | undefined
  private scene:
    | {
        instance: OwnedInstance<SceneData, TSceneState>
        context: SceneInstance<TGameState, TSceneState>
      }
    | undefined
  private isDisposed = false
  private transitioning = false
  private disposalRequested = false

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

  startGame(): GameInstance<TGameState> {
    return this.transition(() => {
      const next = new OwnedInstance(
        this.data,
        this.factories.createGameState(this.data),
        this.factories.disposeGameState,
      )
      const previous = this.game
      const scene = this.detachGameScene()
      this.game = next
      this.release(scene, previous)
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
      this.release(previous?.instance)
      return context
    })
  }

  leaveScene(): void {
    this.transition(() => {
      const previous = this.scene
      this.scene = undefined
      this.release(previous?.instance)
    })
  }

  endGame(): void {
    this.transition(() => {
      const previous = this.game
      const scene = this.detachGameScene()
      this.game = undefined
      this.release(scene, previous)
    })
  }

  dispose(): void {
    if (this.isDisposed) return
    // Engine stop must also work from inside a state factory or cleanup callback.
    if (this.transitioning) {
      this.disposalRequested = true
      return
    }
    this.transition(() => {
      this.isDisposed = true
      const scene = this.scene
      const game = this.game
      this.scene = undefined
      this.game = undefined
      this.release(scene?.instance, game)
    })
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
    try {
      return perform()
    } finally {
      this.transitioning = false
      if (this.disposalRequested) {
        this.disposalRequested = false
        this.dispose()
      }
    }
  }

  private release(...instances: ({ dispose(): void } | undefined)[]): void {
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
}
