import type { GameLanguagePreferences } from '@ancadeba/game-runtime'

export interface LanguagePreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Storage can be blocked, full, or unavailable. Language selection must still work. */
export class BrowserGameLanguagePreferences implements GameLanguagePreferences {
  constructor(private readonly storage: () => LanguagePreferenceStorage) {}

  read(gameId: string): string | undefined {
    try {
      return this.storage().getItem(this.key(gameId)) ?? undefined
    } catch {
      return undefined
    }
  }

  write(gameId: string, language: string): void {
    try {
      this.storage().setItem(this.key(gameId), language)
    } catch {
      // Keep the in-memory selection when persistent storage is unavailable.
    }
  }

  private key(gameId: string): string {
    return `ancadeba.game.${encodeURIComponent(gameId)}.language`
  }
}
