import {
  ScheduledMessageBus,
  type ILogger,
  type IMessageBus,
  type ITaskScheduler,
  type IMonotonicClock,
} from '@ancadeba/utilities'
import type { GameData } from './gameData.js'
import type { IGameLoader } from './gameLoader.js'
import type { EngineMessages } from './messages.js'
import { InputController, type IGameInput } from './input.js'
import { TimerService, type ITimerService } from './timers.js'
import type { GameRulesFactory, IGameActions } from './actions.js'
import { GameLifecycle, type GameInstance, type IGameLifecycle } from './gameLifecycle.js'
import { GameActionRuntime } from './gameActionRuntime.js'
import { GameMessageScopes } from './gameMessageScope.js'

export type EngineState = 'stopped' | 'starting' | 'running'

export interface EngineRuntimeServices {
  readonly createGameRules?: GameRulesFactory
  /** Return a fresh lifecycle for each loaded engine session. */
  readonly createGameLifecycle?: (game: GameData) => IGameLifecycle
  readonly scheduler: ITaskScheduler
  readonly clock: IMonotonicClock
}

export interface EngineHostSession {
  readonly lifecycle: IGameLifecycle
  readonly actions: IGameActions | undefined
  readonly input: IGameInput | undefined
  readonly messages: IMessageBus<EngineMessages>
  readonly timers: ITimerService
}

export interface IEngineHost {
  // Return a cleanup function that releases everything mounted for this run.
  mount(game: GameData, session: EngineHostSession): () => void
}

export interface IEngine {
  readonly lifecycle: IGameLifecycle | undefined
  readonly actions: IGameActions | undefined
  readonly state: EngineState
  readonly game: GameData | undefined
  readonly input: IGameInput | undefined
  readonly timers: ITimerService | undefined
  /** The latest session's bus, retained after stop and replaced on the next start. */
  readonly messages: IMessageBus<EngineMessages> | undefined
  start(): Promise<void>
  stop(): void
  flushMessages(): void
}

interface EngineSession {
  cancelled: Promise<undefined>
  cancel(): void
  messages: ScheduledMessageBus<EngineMessages>
  nextTimerId: number
  game?: GameData
  input?: InputController
  timers?: TimerService
  gameRuntimes: WeakMap<GameInstance, GameActionRuntime>
  lifecycle?: IGameLifecycle
  cleanup?: () => void
}

export class Engine implements IEngine {
  private session: EngineSession | undefined
  private latestMessages: IMessageBus<EngineMessages> | undefined
  private startup: Promise<void> = Promise.resolve()

  constructor(
    private readonly loader: IGameLoader,
    private readonly host: IEngineHost,
    private readonly logger: ILogger,
    private readonly createMessageBus: () => IMessageBus<EngineMessages>,
    private readonly runtime: EngineRuntimeServices,
  ) {}

  get state(): EngineState {
    if (!this.session) return 'stopped'
    return this.session.game ? 'running' : 'starting'
  }

  get game(): GameData | undefined {
    return this.session?.game
  }

  get lifecycle(): IGameLifecycle | undefined {
    return this.session?.game ? this.session.lifecycle : undefined
  }

  get messages(): IMessageBus<EngineMessages> | undefined {
    return this.latestMessages
  }

  get input(): IGameInput | undefined {
    return this.session?.game ? this.session.input : undefined
  }

  get timers(): ITimerService | undefined {
    return this.session?.game ? this.session.timers : undefined
  }

  get actions(): IGameActions | undefined {
    return this.session?.game ? this.session.lifecycle?.currentGame?.actions : undefined
  }

  flushMessages(): void {
    this.latestMessages?.flush()
  }

  start(): Promise<void> {
    if (this.session) return this.startup

    let cancel = () => {}
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined)
    })
    const scopes = new GameMessageScopes()
    const messages = new ScheduledMessageBus(
      this.createMessageBus(),
      this.runtime.scheduler,
      (error) => this.logger.error('Engine', 'Message dispatch failed', error),
      (topic, payload) =>
        topic.startsWith('engine.') ||
        (this.session === session && session.game !== undefined && scopes.shouldDeliver(payload)),
    )
    const session: EngineSession = {
      cancelled,
      cancel,
      messages,
      nextTimerId: 0,
      gameRuntimes: new WeakMap(),
    }
    this.session = session
    this.latestMessages = session.messages
    session.messages.publish('engine.starting', undefined)
    this.startup = Promise.resolve().then(() => this.startSession(session, scopes))
    return this.startup
  }

  stop(): void {
    const session = this.session
    if (!session) return

    this.session = undefined
    session.cancel()
    session.input?.dispose()
    session.timers?.dispose()
    try {
      const errors: unknown[] = []
      for (const cleanup of [() => session.lifecycle?.dispose(), () => session.cleanup?.()]) {
        try {
          cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'Engine cleanup failed')
    } catch (error) {
      session.messages.publish('engine.failed', { error })
      throw error
    } finally {
      session.messages.publish('engine.stopped', undefined)
      session.messages.seal()
    }
  }

  private async startSession(session: EngineSession, scopes: GameMessageScopes): Promise<void> {
    if (this.session !== session) return

    try {
      const game = await Promise.race([this.loader.load(), session.cancelled])
      if (this.session !== session || !game) return

      const lifecycle =
        this.runtime.createGameLifecycle?.(game) ??
        new GameLifecycle(game, {
          createGameState: () => undefined,
          createSceneState: () => undefined,
        })
      if (this.session !== session) {
        lifecycle.dispose()
        return
      }
      session.lifecycle = lifecycle
      lifecycle.bindGameRuntime((instance) => {
        const rules = this.runtime.createGameRules?.(game, instance) ?? { handlers: new Map() }
        if (this.session !== session) throw new Error('Engine stopped while creating game rules')
        const isRunning = () =>
          this.session === session &&
          session.game !== undefined &&
          lifecycle.currentGame === instance
        const runtime = new GameActionRuntime(
          rules,
          scopes.create(
            session.messages,
            () => lifecycle.currentGame === instance,
            () => lifecycle.activeScene?.type !== 'stand-alone',
          ),
          this.runtime.scheduler,
          this.runtime.clock,
          this.logger,
          isRunning,
          () => session.input?.reset(),
          () => ++session.nextTimerId,
          () => session.gameRuntimes.delete(instance),
        )
        session.gameRuntimes.set(instance, runtime)
        return runtime
      })
      if (game.input) {
        // A release/cancellation belongs to the same context as its original press.
        const inputOwners = new Map<string, GameActionRuntime | undefined>()
        session.input = new InputController(game.input, {
          publish(topic, payload) {
            const key = JSON.stringify([payload.context, payload.input])
            let owner: GameActionRuntime | undefined
            if (payload.phase === 'pressed') {
              owner =
                lifecycle.currentGame && lifecycle.activeScene?.type !== 'stand-alone'
                  ? session.gameRuntimes.get(lifecycle.currentGame)
                  : undefined
              inputOwners.set(key, owner)
            } else {
              owner = inputOwners.get(key)
              inputOwners.delete(key)
            }
            const messages = owner?.messages ?? session.messages
            messages.publish(topic, payload)
          },
        })
      }
      session.timers = new TimerService(
        session.messages,
        this.runtime.scheduler,
        this.runtime.clock,
        () => ++session.nextTimerId,
      )
      const cleanup = this.host.mount(game, {
        lifecycle,
        get actions() {
          return lifecycle.currentGame?.actions
        },
        input: session.input,
        messages: session.messages,
        timers: session.timers,
      })
      if (this.session !== session) {
        cleanup()
        return
      }

      session.cleanup = cleanup
      session.game = game
      const currentGame = lifecycle.currentGame
      if (currentGame) session.gameRuntimes.get(currentGame)?.start()
      this.logger.info('Engine', 'The engine workspace is ready.')
      if (this.session === session) session.messages.publish('engine.started', { game })
    } catch (error) {
      if (this.session !== session) return
      session.messages.publish('engine.failed', { error })
      this.stop()
      throw error
    }
  }
}
