import {
  gameSchema,
  inputSchema,
  languageCatalogSchema,
  localizeDefinitions,
  sceneSchema,
  selectLanguage,
} from '@ancadeba/schemas'
import type { IJsonResourceLoader } from '@ancadeba/utilities'
import { assembleGameData, type GameData } from './gameData.js'

export interface IGameLoader {
  load(): Promise<GameData>
}

export class GameLoader implements IGameLoader {
  constructor(
    private readonly resources: IJsonResourceLoader,
    private readonly preferredLanguages: readonly string[] = [],
  ) {}

  async load(): Promise<GameData> {
    const definition = await this.resources.load('game.json', gameSchema)

    const scenes = await Promise.all(
      definition.scenes.map(async (id) => {
        const scene = await this.resources.load(`scenes/${id}.json`, sceneSchema)

        return [id, scene] as const
      }),
    )

    const input = definition.input
      ? await this.resources.load(definition.input, inputSchema)
      : undefined

    if (!definition.languages) return assembleGameData(definition, new Map(scenes), input)

    const { available, default: fallbackLanguage } = definition.languages
    const language = selectLanguage(available, fallbackLanguage, this.preferredLanguages)

    const fallback = await this.resources.load(
      `languages/${fallbackLanguage}/messages.json`,
      languageCatalogSchema,
    )

    const fallbackDefinitions = localizeDefinitions(definition, new Map(scenes), {
      fallback,
      messages: fallback,
    })

    const messages =
      language === fallbackLanguage
        ? fallback
        : await this.resources.load(`languages/${language}/messages.json`, languageCatalogSchema)

    const localized =
      language === fallbackLanguage
        ? fallbackDefinitions
        : localizeDefinitions(definition, new Map(scenes), { fallback, messages })

    return { ...assembleGameData(localized.game, localized.scenes, input), language }
  }
}
