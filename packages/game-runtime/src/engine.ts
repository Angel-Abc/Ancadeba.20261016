import { gameSchema, type Game } from '@ancadeba/schemas'
import type { IJsonResourceLoader, ILogger } from '@ancadeba/utilities'

export type EngineState = 'stopped' | 'starting' | 'running'

export interface IEngineHost {
  // Return a cleanup function that releases everything mounted for this run.
  mount(game: Game): () => void
}

export interface IEngine {
  readonly state: EngineState
  readonly game: Game | undefined
  start(): Promise<void>
  stop(): void
}

interface EngineSession {
  cancelled: Promise<undefined>
  cancel(): void
  game?: Game
  cleanup?: () => void
}

export class Engine implements IEngine {
  private session: EngineSession | undefined
  private startup: Promise<void> = Promise.resolve()

  constructor(
    private readonly loader: IJsonResourceLoader,
    private readonly host: IEngineHost,
    private readonly logger: ILogger,
  ) {}

  get state(): EngineState {
    if (!this.session) return 'stopped'
    return this.session.game ? 'running' : 'starting'
  }

  get game(): Game | undefined {
    return this.session?.game
  }

  start(): Promise<void> {
    if (this.session) return this.startup

    let cancel = () => {}
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined)
    })
    const session: EngineSession = { cancelled, cancel }
    this.session = session
    this.startup = Promise.resolve().then(() => this.startSession(session))
    return this.startup
  }

  stop(): void {
    const session = this.session
    if (!session) return

    this.session = undefined
    session.cancel()
    session.cleanup?.()
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
    } catch (error) {
      if (this.session !== session) return
      this.stop()
      throw error
    }
  }
}
