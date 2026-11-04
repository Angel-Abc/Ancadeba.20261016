import {
  gameSchema,
  inputSchema,
  inputFile,
  languageCatalogSchema,
  localizeDefinitions,
  sceneSchema,
  selectLanguage,
  assetCatalogSchema,
  assetCatalogFile,
  mapDefinitionSchema,
  inventorySchema,
  inventoryFile,
  gameRulesSchema,
  ruleFile,
} from '@ancadeba/schemas'
import type { IJsonResourceLoader } from '@ancadeba/utilities'
import { assembleGameData, type GameData } from './gameData.js'
import { GameLocalization, type GameLanguagePreferences } from './gameLocalization.js'

interface LocalizedGameData extends GameData {
  readonly language: string
}

export interface IGameLoader {
  load(): Promise<GameData>
}

export class GameLoader implements IGameLoader {
  constructor(
    private readonly resources: IJsonResourceLoader,
    private readonly preferredLanguages: readonly string[] = [],
    private readonly preferences?: GameLanguagePreferences,
  ) {}

  async load(): Promise<GameData> {
    const definition = await this.resources.load('game.json', gameSchema)

    const styling = definition.stylesheet
      ? { stylesheet: await this.resources.readText(definition.stylesheet) }
      : {}

    const scenes = await Promise.all(
      definition.scenes.map(async (id) => {
        const scene = await this.resources.load(`scenes/${id}.json`, sceneSchema)

        return [id, scene] as const
      }),
    )

    const maps = new Map(
      await Promise.all(
        (definition.maps ?? []).map(async (id) => {
          const map = await this.resources.load(`maps/${id}.json`, mapDefinitionSchema)

          return [id, map] as const
        }),
      ),
    )

    const input = definition.input
      ? await this.resources.load(inputFile(definition.input), inputSchema)
      : undefined

    const assets = definition.assets
      ? await this.resources.load(assetCatalogFile(definition.assets), assetCatalogSchema)
      : undefined

    const inventory = new Map(
      await Promise.all(
        (definition.inventory ?? []).map(
          async (id) =>
            [id, await this.resources.load(inventoryFile(id), inventorySchema)] as const,
        ),
      ),
    )

    const rules = new Map(
      await Promise.all(
        (definition.rules ?? []).map(
          async (id) => [id, await this.resources.load(ruleFile(id), gameRulesSchema)] as const,
        ),
      ),
    )

    if (!definition.languages)
      return {
        ...assembleGameData(
          definition,
          new Map(scenes),
          input,
          assets,
          maps,
          inventory,
          undefined,
          rules,
        ),
        ...styling,
      }

    const { available, default: fallbackLanguage } = definition.languages
    const saved = this.preferences?.read(definition.id)

    const language = selectLanguage(available, fallbackLanguage, [
      ...this.preferredLanguages,
      ...(saved ? [saved] : []),
    ])

    const catalogs = new Map(
      await Promise.all(
        available.map(
          async (tag) =>
            [
              tag,
              await this.resources.load(`languages/${tag}/messages.json`, languageCatalogSchema),
            ] as const,
        ),
      ),
    )

    const fallback = catalogs.get(fallbackLanguage)!
    const variants = new Map<string, LocalizedGameData>()

    for (const [tag, messages] of catalogs) {
      const localized = localizeDefinitions(definition, new Map(scenes), { fallback, messages })
      variants.set(tag, {
        ...assembleGameData(
          localized.game,
          localized.scenes,
          input,
          assets,
          maps,
          inventory,
          {
            fallback,
            messages,
          },
          rules,
        ),
        ...styling,
        language: tag,
      })
    }

    const localization = new GameLocalization(
      variants,
      available.map((tag) => ({ tag, name: catalogs.get(tag)!['language.name']?.trim() || tag })),
      language,
      (selected) => this.preferences?.write(definition.id, selected),
    )

    return {
      ...variants.get(language)!,
      localization,
      get language() {
        return localization.current.language
      },
      get title() {
        return localization.current.title
      },
      get description() {
        return localization.current.description
      },
      get scenes() {
        return localization.current.scenes
      },
      get ruleTranslation() {
        return variants.get(localization.current.language)?.ruleTranslation
      },
    }
  }
}
