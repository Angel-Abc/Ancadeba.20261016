import { gameSaveSchema, type GameSave } from '@ancadeba/schemas'

/** Hosts supply durable storage; the runtime does not depend on browser or filesystem globals. */
export interface GameSaveStore {
  read(gameId: string): string | undefined
  write(gameId: string, save: string): void
}

export type SaveError = 'unavailable' | 'storage' | 'invalid-save' | 'incompatible-save' | 'busy'

export interface IGameSaves {
  readonly canSave: boolean
  readonly canLoad: boolean
  readonly status: 'idle' | 'saved' | 'loaded' | 'error'
  readonly error: SaveError | undefined
  save(): boolean
  load(): boolean
  subscribe(listener: () => void): () => void
}

export class GameSaveError extends Error {
  constructor(readonly code: SaveError) {
    super(code)
  }
}

/** A single manual save slot per game. A failed write never replaces the in-memory playthrough. */
export class GameSaves implements IGameSaves {
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private working = false
  private notifying = false
  status: IGameSaves['status'] = 'idle'
  error: SaveError | undefined

  constructor(
    private readonly gameId: string,
    private readonly store: GameSaveStore,
    private readonly available: () => boolean,
    private readonly capture: () => GameSave,
    private readonly restore: (save: GameSave) => void,
    private readonly compatible: (save: GameSave) => boolean,
    private readonly onObserverError: (error: unknown) => void,
  ) {}

  get canSave(): boolean {
    return !this.disposed && !this.working && this.available()
  }

  get canLoad(): boolean {
    if (this.disposed || this.working) return false

    try {
      return this.store.read(this.gameId) !== undefined
    } catch {
      // Leave Load available so the player can request it and see the storage error.
      return true
    }
  }

  save(): boolean {
    if (this.working || this.disposed || this.notifying) return false

    if (!this.canSave) return this.fail('unavailable')

    return this.perform(() => {
      const save = gameSaveSchema.parse(this.capture())

      try {
        const text = JSON.stringify(save)

        if (text.length > 5 * 1024 * 1024) throw new Error('Save too large')
        this.store.write(this.gameId, text)
      } catch {
        throw new GameSaveError('storage')
      }

      this.status = 'saved'
    })
  }

  load(): boolean {
    if (this.disposed || this.working || this.notifying) return false

    return this.perform(() => {
      let text: string | undefined

      try {
        text = this.store.read(this.gameId)
      } catch {
        throw new GameSaveError('storage')
      }

      if (text === undefined) throw new GameSaveError('unavailable')
      let save: GameSave

      try {
        if (text.length > 5 * 1024 * 1024) throw new Error('Save too large')
        save = gameSaveSchema.parse(JSON.parse(text))
      } catch {
        throw new GameSaveError('invalid-save')
      }

      if (!this.compatible(save)) throw new GameSaveError('incompatible-save')
      this.restore(save)
      this.status = 'loaded'
    })
  }

  private perform(operation: () => void): boolean {
    this.working = true

    try {
      operation()
      this.error = undefined

      return true
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof GameSaveError ? error.code : 'invalid-save'

      return false
    } finally {
      this.working = false
      this.notify()
    }
  }

  private fail(error: SaveError): false {
    if (!this.disposed) {
      this.error = error
      this.status = 'error'
      this.notify()
    }

    return false
  }

  notify(): void {
    if (this.disposed || this.notifying) return
    this.notifying = true

    try {
      for (const listener of [...this.listeners]) {
        if (!this.listeners.has(listener)) continue

        try {
          listener()
        } catch (error) {
          this.onObserverError(error)
        }
      }
    } finally {
      this.notifying = false
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}
