import type { ILogger, IMessageBus } from '@ancadeba/utilities'
import type { GameData } from './gameData.js'
import type { IGameLoader } from './gameLoader.js'
import type { EngineMessages } from './messages.js'
import { InputController, type IGameInput } from './input.js'

export type EngineState = 'stopped' | 'starting' | 'running'

export interface EngineHostSession {
  readonly input: IGameInput | undefined
}

export interface IEngineHost {
  // Return a cleanup function that releases everything mounted for this run.
  mount(game: GameData, session: EngineHostSession): () => void
}

export interface IEngine {
  readonly state: EngineState
  readonly game: GameData | undefined
  readonly input: IGameInput | undefined
  /** The latest session's bus, retained after stop and replaced on the next start. */
  readonly messages: IMessageBus<EngineMessages> | undefined
  start(): Promise<void>
  stop(): void
  flushMessages(): void
}

interface EngineSession {
  cancelled: Promise<undefined>
  cancel(): void
  messages: IMessageBus<EngineMessages>
  game?: GameData
  input?: InputController
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
  ) {}

  get state(): EngineState {
    if (!this.session) return 'stopped'
    return this.session.game ? 'running' : 'starting'
  }

  get game(): GameData | undefined {
    return this.session?.game
  }

  get messages(): IMessageBus<EngineMessages> | undefined {
    return this.latestMessages
  }

  get input(): IGameInput | undefined {
    return this.session?.game ? this.session.input : undefined
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
    const session: EngineSession = { cancelled, cancel, messages: this.createMessageBus() }
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
    session.input?.dispose()
    try {
      session.cleanup?.()
    } catch (error) {
      session.messages.publish('engine.failed', { error })
      throw error
    } finally {
      session.messages.publish('engine.stopped', undefined)
    }
  }

  private async startSession(session: EngineSession): Promise<void> {
    if (this.session !== session) return

    try {
      const game = await Promise.race([this.loader.load(), session.cancelled])
      if (this.session !== session || !game) return

      if (game.input) session.input = new InputController(game.input, session.messages)
      const cleanup = this.host.mount(game, { input: session.input })
      if (this.session !== session) {
        cleanup()
        return
      }

      session.cleanup = cleanup
      session.game = game
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
