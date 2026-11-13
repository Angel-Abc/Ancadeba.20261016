import type { GameSaveStore, GameSaveLocation, GameSaveSlotId } from '@ancadeba/game-runtime'

export interface SaveStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Storage errors propagate to the runtime so players never receive a false success message. */
export class BrowserGameSaveStore implements GameSaveStore {
  constructor(
    private readonly storage: () => SaveStorage,
    private readonly namespace = '',
  ) {}

  read(gameId: string, slot: GameSaveLocation = '1'): string | undefined {
    return this.storage().getItem(this.key(gameId, slot)) ?? undefined
  }

  write(gameId: string, save: string, slot: GameSaveLocation = '1'): void {
    this.storage().setItem(this.key(gameId, slot), save)
  }

  remove(gameId: string, slot: GameSaveSlotId = '1'): void {
    this.storage().removeItem(this.key(gameId, slot))
  }

  private key(gameId: string, slot: GameSaveLocation): string {
    const base = `ancadeba.save.${encodeURIComponent(this.namespace)}.${encodeURIComponent(gameId)}`

    return slot === '1' ? base : `${base}.slot.${slot}`
  }
}
