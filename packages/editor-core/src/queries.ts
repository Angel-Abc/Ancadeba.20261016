import { levelingProfileSchema, levelingFile } from '@ancadeba/schemas'
import {
  gameSchema,
  sceneSchema,
  assetCatalogSchema,
  assetCatalogFile,
  inventorySchema,
  languageCatalogSchema,
  gameRulesSchema,
  mergeRuleSources,
  mergeInventorySources,
  inputSchema,
  inputFile,
  inventoryFile,
  combatFile,
  combatDefinitionSchema,
  mapDefinitionSchema,
  mapFile,
} from '@ancadeba/schemas'
import { validateProject } from './validation.js'
import {
  projectInventorySources,
  projectRuleSources,
  type ProjectSnapshot,
  type ProjectView,
} from './project.js'

export function inspectProject(project: ProjectSnapshot): ProjectView {
  const game = gameSchema.safeParse(project.documents['game.json'])

  const input = game.data?.input
    ? inputSchema.safeParse(project.documents[inputFile(game.data.input)])
    : undefined

  const assets = game.data?.assets
    ? assetCatalogSchema.safeParse(project.documents[assetCatalogFile(game.data.assets)])
    : undefined

  const inventorySources = projectInventorySources(
    game.data?.inventory,
    (file) => inventorySchema.safeParse(project.documents[file]).data,
  )

  const { inventory } = mergeInventorySources(inventorySources)

  const language = game.data?.languages?.default

  const sources = projectRuleSources(
    game.data?.rules,
    (file) => gameRulesSchema.safeParse(project.documents[file]).data,
  )

  const ruleFiles = Object.fromEntries(sources.map(({ id, rules }) => [id, rules]))

  const parsedFiles = <T>(
    ids: readonly string[] | undefined,
    file: (id: string) => string,
    parse: (document: unknown) => T | undefined,
  ) =>
    Object.fromEntries(
      (ids ?? []).flatMap((id) => {
        const data = parse(project.documents[file(id)])

        return data ? [[id, data]] : []
      }),
    )

  const maps = parsedFiles(game.data?.maps, mapFile, (document) => {
    return mapDefinitionSchema.safeParse(document).data
  })

  const inventoryFiles = parsedFiles(game.data?.inventory, inventoryFile, (document) => {
    return inventorySchema.safeParse(document).data
  })

  const catalog =
    language &&
    languageCatalogSchema.safeParse(project.documents[`languages/${language}/messages.json`])

  return {
    ...(game.data?.leveling?.length
      ? {
          leveling: parsedFiles(
            game.data.leveling,
            levelingFile,
            (value) => levelingProfileSchema.safeParse(value).data,
          ),
        }
      : {}),
    ...(game.data?.combat?.length
      ? {
          combat: Object.fromEntries(
            game.data.combat.flatMap((id) => {
              const result = combatDefinitionSchema.safeParse(project.documents[combatFile(id)])

              return result.success ? [[id, result.data]] : []
            }),
          ),
        }
      : {}),
    ...(input?.success ? { input: input.data } : {}),
    ...(sources.length ? { rules: mergeRuleSources(sources).rules, ruleFiles } : {}),
    ...(assets?.success ? { assets: assets.data } : {}),
    ...(inventory ? { inventory } : {}),
    ...(catalog && catalog.success
      ? { translationKeys: Object.keys(catalog.data).sort(), translations: catalog.data }
      : {}),
    ...(Object.keys(maps).length ? { maps } : {}),
    ...(Object.keys(inventoryFiles).length ? { inventoryFiles } : {}),
    revision: project.revision,
    game: game.success ? game.data : null,
    scenes: game.success
      ? game.data.scenes.flatMap((id) => {
          const result = sceneSchema.safeParse(project.documents[`scenes/${id}.json`])

          return result.success && result.data.id === id ? [result.data] : []
        })
      : [],
    diagnostics: validateProject(project.documents, project.sourceDiagnostics),
  }
}
