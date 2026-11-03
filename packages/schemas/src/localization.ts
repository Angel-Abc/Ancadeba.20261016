import { sceneSchema, type SceneDefinition } from './scene.js'
import type { GameDefinition } from './game.js'
import type { LanguageCatalog } from './languages.js'

export interface GameTranslation {
  readonly fallback: LanguageCatalog
  readonly messages: LanguageCatalog
}

/** Resolve catalog strings before game bindings, so translated templates use the same aliases. */
export function localizeDefinitions(
  game: GameDefinition,
  scenes: ReadonlyMap<string, SceneDefinition>,
  translation: GameTranslation,
) {
  const text = (key: string | undefined, literal: string, required = false): string => {
    if (key === undefined) return literal

    if (!Object.hasOwn(translation.fallback, key))
      throw new Error(`Missing default translation: ${key}`)

    const value = Object.hasOwn(translation.messages, key)
      ? translation.messages[key]!
      : translation.fallback[key]!

    if (required && !value.trim()) throw new Error(`Translation must not be empty: ${key}`)

    return value
  }

  const metadata = (definition: GameDefinition | SceneDefinition) => ({
    title: text(definition.titleKey, definition.title, true),
    description: text(definition.descriptionKey, definition.description),
  })

  const localizedGame = { ...game, ...metadata(game) }

  if (!localizedGame.title.trim()) throw new Error('Translated game title must not be empty')

  return {
    game: localizedGame,
    scenes: new Map<string, SceneDefinition>(
      [...scenes].map(([id, scene]) => [
        id,
        sceneSchema.parse({
          ...scene,
          ...metadata(scene),
          components: scene.components.map((component) =>
            component.type === 'text'
              ? { ...component, text: text(component.textKey, component.text) }
              : { ...component, label: text(component.labelKey, component.label, true) },
          ),
        }),
      ]),
    ),
  }
}

/** Keys cannot silently render as empty text when the manifest has no language catalogs. */
export function assertGameLanguages(
  game: GameDefinition,
  scenes: ReadonlyMap<string, SceneDefinition>,
): void {
  if (game.languages) return

  const keyed =
    game.titleKey !== undefined ||
    game.descriptionKey !== undefined ||
    [...scenes.values()].some(
      (scene) =>
        scene.titleKey !== undefined ||
        scene.descriptionKey !== undefined ||
        scene.components.some((component) =>
          component.type === 'text'
            ? component.textKey !== undefined
            : component.labelKey !== undefined,
        ),
    )

  if (keyed) throw new Error('Translation keys require languages in game.json')
}
