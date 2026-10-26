import { gameSchema, type Game } from '@ancadeba/schemas'
import type { IJsonResourceLoader, ILogger, IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'

export type EngineState = 'stopped' | 'starting' | 'running'

export interface IEngineHost {
  // Return a cleanup function that releases everything mounted for this run.
  mount(game: Game): () => void
}

export interface IEngine {
  readonly state: EngineState
  readonly game: Game | undefined
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
  game?: Game
  cleanup?: () => void
}

export class Engine implements IEngine {
  private session: EngineSession | undefined
  private latestMessages: IMessageBus<EngineMessages> | undefined
  private startup: Promise<void> = Promise.resolve()

  constructor(
    private readonly loader: IJsonResourceLoader,
    private readonly host: IEngineHost,
    private readonly logger: ILogger,
    private readonly createMessageBus: () => IMessageBus<EngineMessages>,
  ) {}

  get state(): EngineState {
    if (!this.session) return 'stopped'
    return this.session.game ? 'running' : 'starting'
  }

  get game(): Game | undefined {
    return this.session?.game
  }

  get messages(): IMessageBus<EngineMessages> | undefined {
    return this.latestMessages
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
      const game = await Promise.race([
        this.loader.load('game.json', gameSchema),
        session.cancelled,
      ])
      if (this.session !== session || !game) return

      const cleanup = this.host.mount(game)
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
