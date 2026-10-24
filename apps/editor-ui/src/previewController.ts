import type { EngineState, IEngine } from '@ancadeba/game-runtime'

export type PreviewStateListener = (state: EngineState, error?: string) => void

export class EditorPreviewController {
  private engine: IEngine | undefined
  private disposed = false

  constructor(
    private readonly createInstance: (folder: string) => IEngine,
    private readonly onStateChange: PreviewStateListener,
  ) {}

  async start(folder: string): Promise<void> {
    if (this.disposed || this.engine) return

    let engine: IEngine | undefined
    try {
      engine = this.createInstance(folder)
      this.engine = engine
      this.onStateChange('starting')
      await engine.start()
      if (this.disposed || this.engine !== engine) return

      if (engine.state === 'stopped') this.engine = undefined
      this.onStateChange(engine.state)
    } catch (error) {
      if (this.disposed || this.engine !== engine) return
      this.engine = undefined
      engine?.stop()
      this.onStateChange('stopped', error instanceof Error ? error.message : String(error))
    }
  }

  stop(): void {
    if (this.disposed) return
    const engine = this.engine
    this.engine = undefined
    try {
      engine?.stop()
      this.onStateChange('stopped')
    } catch (error) {
      this.onStateChange('stopped', error instanceof Error ? error.message : String(error))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const engine = this.engine
    this.engine = undefined
    engine?.stop()
  }
}
