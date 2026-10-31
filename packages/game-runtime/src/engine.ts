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
import { ActionProcessor } from './actionProcessor.js'
import type { GameRulesFactory, IGameActions } from './actions.js'
import { GameLifecycle, type IGameLifecycle } from './gameLifecycle.js'

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
  readonly actions: IGameActions
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
  game?: GameData
  input?: InputController
  timers?: TimerService
  actions?: ActionProcessor
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
    return this.session?.game ? this.session.actions : undefined
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
    const messages = new ScheduledMessageBus(
      this.createMessageBus(),
      this.runtime.scheduler,
      (error) => this.logger.error('Engine', 'Message dispatch failed', error),
      (topic) =>
        topic.startsWith('engine.') || (this.session === session && session.game !== undefined),
    )
    const session: EngineSession = { cancelled, cancel, messages }
    this.session = session
    this.latestMessages = session.messages
    session.messages.publish('engine.starting', undefined)
    this.startup = Promise.resolve().then(() => this.startSession(session))
    return this.startup
  }

  stop(): void {
    const session = this.session
    if (!session) return

    this.session = undefined
    session.cancel()
    session.actions?.dispose()
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

  private async startSession(session: EngineSession): Promise<void> {
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
      if (game.input) session.input = new InputController(game.input, session.messages)
      session.timers = new TimerService(
        session.messages,
        this.runtime.scheduler,
        this.runtime.clock,
      )
      const rules = this.runtime.createGameRules?.(game) ?? { handlers: new Map() }
      if (this.session !== session) return
      session.actions = new ActionProcessor(
        rules,
        session.messages,
        session.timers,
        this.runtime.clock,
        this.logger,
        () => this.session === session && session.game !== undefined,
      )
      const cleanup = this.host.mount(game, {
        lifecycle,
        actions: session.actions,
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
      session.actions.start()
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
