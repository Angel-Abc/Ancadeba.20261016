import { gameSaveSchema, type GameSave } from '@ancadeba/schemas'

export const gameSaveSlotIds = ['1', '2', '3', '4', '5'] as const

export type GameSaveSlotId = (typeof gameSaveSlotIds)[number]

export type GameSaveLocation = GameSaveSlotId | 'autosave'

export const maxGameSaveBytes = 5 * 1024 * 1024

export interface GameSaveSlot {
  readonly id: GameSaveSlotId
  readonly name: string
  readonly occupied: boolean
  readonly available: boolean
}

export interface GameSaveFile {
  readonly fileName: string
  readonly text: string
}

/** Hosts supply durable storage; the runtime does not depend on browser or filesystem globals. */
export interface GameSaveStore {
  read(gameId: string, slot?: GameSaveLocation): string | undefined
  write(gameId: string, save: string, slot?: GameSaveLocation): void
  /** Omit when the host does not support deleting manual saves. */
  remove?(gameId: string, slot?: GameSaveSlotId): void
}

export type SaveError =
  | 'unavailable'
  | 'storage'
  | 'invalid-save'
  | 'incompatible-save'
  | 'busy'
  | 'invalid-name'
  | 'too-large'
  | 'delete-unavailable'

export interface IGameSaves {
  readonly selectedSlot: GameSaveSlotId
  readonly slots: readonly GameSaveSlot[]
  readonly canSave: boolean
  readonly canLoad: boolean
  readonly canDelete: boolean
  readonly canLoadAutosave: boolean
  readonly canImport: boolean
  readonly autosaveStatus: 'idle' | 'saved' | 'error'
  readonly autosaveError: SaveError | undefined
  readonly status: 'idle' | 'saved' | 'loaded' | 'imported' | 'exported' | 'deleted' | 'error'
  readonly error: SaveError | undefined
  selectSlot(id: string): boolean
  save(name?: string): boolean
  load(): boolean
  delete(): boolean
  loadAutosave(): boolean
  importFile(text: string, name?: string): boolean
  exportFile(): GameSaveFile | undefined
  subscribe(listener: () => void): () => void
}

export class GameSaveError extends Error {
  constructor(readonly code: SaveError) {
    super(code)
  }
}

/** Count UTF-8 bytes without a browser or Node encoding dependency. */
function saveByteLength(text: string): number {
  let bytes = 0

  for (const character of text) {
    const code = character.codePointAt(0)!
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4

    if (bytes > maxGameSaveBytes) return bytes
  }

  return bytes
}

/** Independent named slots and portable snapshots; failed imports never replace saved or live progress. */
export class GameSaves implements IGameSaves {
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private working = false
  private notifying = false
  private slot: GameSaveSlotId = '1'
  status: IGameSaves['status'] = 'idle'
  error: SaveError | undefined
  autosaveStatus: IGameSaves['autosaveStatus'] = 'idle'
  autosaveError: SaveError | undefined

  constructor(
    private readonly gameId: string,
    private readonly store: GameSaveStore,
    private readonly available: () => boolean,
    private readonly capture: () => GameSave,
    private readonly restore: (save: GameSave) => void,
    private readonly compatible: (save: GameSave) => boolean,
    private readonly validate: (save: GameSave) => void,
    private readonly onObserverError: (error: unknown) => void,
  ) {}

  get selectedSlot(): GameSaveSlotId {
    return this.slot
  }

  get slots(): readonly GameSaveSlot[] {
    return gameSaveSlotIds.map((id) => {
      try {
        const text = this.store.read(this.gameId, id)
        let name = ''

        if (text !== undefined) {
          try {
            name = this.parse(text).slotName ?? ''
          } catch {
            // Keep damaged slots selectable so Load and Export can report their errors.
          }
        }

        return { id, name, occupied: text !== undefined, available: true }
      } catch {
        return { id, name: '', occupied: false, available: false }
      }
    })
  }

  get canImport(): boolean {
    return !this.disposed && !this.working
  }

  selectSlot(id: string): boolean {
    if (this.disposed || this.working || this.notifying) return false
    const slot = gameSaveSlotIds.find((slot) => slot === id)

    if (!slot) return false

    if (this.slot === slot) return true
    this.slot = slot
    this.status = 'idle'
    this.error = undefined
    this.notify()

    return true
  }

  get canSave(): boolean {
    return !this.disposed && !this.working && this.available()
  }

  get canLoad(): boolean {
    return this.hasSave(this.slot)
  }

  get canDelete(): boolean {
    return this.store.remove !== undefined && this.hasSave(this.slot)
  }

  get canLoadAutosave(): boolean {
    return this.hasSave('autosave')
  }

  private hasSave(location: GameSaveLocation): boolean {
    if (this.disposed || this.working) return false

    try {
      return this.store.read(this.gameId, location) !== undefined
    } catch {
      // Leave Load available so the player can request it and see the storage error.
      return true
    }
  }

  save(name?: string): boolean {
    if (this.working || this.disposed || this.notifying) return false

    if (!this.canSave) return this.fail('unavailable')

    return this.perform(() => {
      const slotName = this.name(name ?? this.slots.find(({ id }) => id === this.slot)?.name)
      const save = gameSaveSchema.parse({ ...this.capture(), slotName })
      this.write(save)

      this.status = 'saved'
    })
  }

  load(): boolean {
    return this.loadFrom(this.slot)
  }

  /** Clears only the selected manual slot, including damaged or incompatible snapshots. */
  delete(): boolean {
    if (this.disposed || this.working || this.notifying) return false

    return this.perform(() => {
      if (!this.store.remove) throw new GameSaveError('delete-unavailable')

      try {
        this.store.remove(this.gameId, this.slot)
      } catch {
        throw new GameSaveError('storage')
      }

      this.status = 'deleted'
    })
  }

  loadAutosave(): boolean {
    return this.loadFrom('autosave')
  }

  /** Background checkpoints have separate feedback and never change the selected manual slot. */
  autosave(): boolean {
    if (this.disposed || this.working || this.notifying || !this.available()) return false
    this.working = true

    try {
      this.write(gameSaveSchema.parse(this.capture()), 'autosave')
      this.autosaveStatus = 'saved'
      this.autosaveError = undefined

      return true
    } catch (error) {
      const code = error instanceof GameSaveError ? error.code : 'invalid-save'

      // Movement and message dispatch are transient; retain the last safe checkpoint.
      if (code !== 'busy' && code !== 'unavailable') {
        this.autosaveStatus = 'error'
        this.autosaveError = code
      }

      return false
    } finally {
      this.working = false
      this.notify()
    }
  }

  private loadFrom(location: GameSaveLocation): boolean {
    if (this.disposed || this.working || this.notifying) return false

    return this.perform(() => {
      let text: string | undefined

      try {
        text = this.store.read(this.gameId, location)
      } catch {
        throw new GameSaveError('storage')
      }

      if (text === undefined) throw new GameSaveError('unavailable')
      const save = this.parse(text)

      if (!this.compatible(save)) throw new GameSaveError('incompatible-save')
      this.restore(save)
      this.status = 'loaded'
    })
  }

  importFile(text: string, name?: string): boolean {
    if (this.disposed || this.working || this.notifying) return false

    return this.perform(() => {
      const save = this.parse(text)

      if (!this.compatible(save)) throw new GameSaveError('incompatible-save')
      this.validate(save)
      this.write({ ...save, slotName: this.name(name ?? save.slotName) })
      this.status = 'imported'
    })
  }

  exportFile(): GameSaveFile | undefined {
    if (this.disposed || this.working || this.notifying) return
    let file: GameSaveFile | undefined
    this.perform(() => {
      let text: string | undefined

      try {
        text = this.store.read(this.gameId, this.slot)
      } catch {
        throw new GameSaveError('storage')
      }

      if (text === undefined) throw new GameSaveError('unavailable')
      this.parse(text)
      file = { fileName: `${this.gameId}-slot-${this.slot}.save.json`, text }
      this.status = 'exported'
    })

    return file
  }

  private name(value: string | undefined): string | undefined {
    const parsed = gameSaveSchema.shape.slotName.safeParse(value)

    if (!parsed.success) throw new GameSaveError('invalid-name')

    return parsed.data || undefined
  }

  private parse(text: string): GameSave {
    if (saveByteLength(text) > maxGameSaveBytes) throw new GameSaveError('too-large')

    try {
      return gameSaveSchema.parse(JSON.parse(text))
    } catch {
      throw new GameSaveError('invalid-save')
    }
  }

  private write(save: GameSave, location: GameSaveLocation = this.slot): void {
    const text = JSON.stringify(save)

    if (saveByteLength(text) > maxGameSaveBytes) throw new GameSaveError('too-large')

    try {
      this.store.write(this.gameId, text, location)
    } catch {
      throw new GameSaveError('storage')
    }
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
