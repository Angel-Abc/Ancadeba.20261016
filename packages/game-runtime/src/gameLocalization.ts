import type { Unsubscribe } from '@ancadeba/utilities'
import type { SceneData } from './gameData.js'
import type { InventoryDefinition } from '@ancadeba/schemas'

export interface GameLanguagePreferences {
  read(gameId: string): string | undefined
  write(gameId: string, language: string): void
}

export interface LocalizedGameContent {
  readonly language: string
  readonly title: string
  readonly description: string
  readonly scenes: ReadonlyMap<string, SceneData>
  readonly inventory?: InventoryDefinition | undefined
}

export interface GameLanguageOption {
  readonly tag: string
  readonly name: string
}

export interface IGameLocalization {
  readonly current: LocalizedGameContent
  readonly available: readonly GameLanguageOption[]
  select(language: string): void
  subscribe(handler: () => void): Unsubscribe
}

/** Changes presentation data without replacing playthrough or scene instances. */
export class GameLocalization implements IGameLocalization {
  private selected: LocalizedGameContent
  private readonly subscribers = new Set<() => void>()

  constructor(
    private readonly variants: ReadonlyMap<string, LocalizedGameContent>,
    readonly available: readonly GameLanguageOption[],
    language: string,
    private readonly onSelect: (language: string) => void = () => {},
  ) {
    const selected = variants.get(language)

    if (!selected) throw new Error(`Unsupported game language: ${language}`)
    this.selected = selected
  }

  get current(): LocalizedGameContent {
    return this.selected
  }

  select(language: string): void {
    const next = this.variants.get(language)

    if (!next) throw new Error(`Unsupported game language: ${language}`)

    if (next === this.selected) return
    this.selected = next
    this.onSelect(language)
    const errors: unknown[] = []

    for (const handler of [...this.subscribers]) {
      if (!this.subscribers.has(handler)) continue

      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Game language subscribers failed')
  }

  subscribe(handler: () => void): Unsubscribe {
    const subscriber = () => handler()
    this.subscribers.add(subscriber)

    return () => {
      this.subscribers.delete(subscriber)
    }
  }
}
