import type { GameSaveStore } from '@ancadeba/game-runtime'

export interface SaveStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Storage errors propagate to the runtime so players never receive a false success message. */
export class BrowserGameSaveStore implements GameSaveStore {
  constructor(
    private readonly storage: () => SaveStorage,
    private readonly namespace = '',
  ) {}

  read(gameId: string): string | undefined {
    return this.storage().getItem(this.key(gameId)) ?? undefined
  }

  write(gameId: string, save: string): void {
    this.storage().setItem(this.key(gameId), save)
  }

  private key(gameId: string): string {
    return `ancadeba.save.${encodeURIComponent(this.namespace)}.${encodeURIComponent(gameId)}`
  }
}
