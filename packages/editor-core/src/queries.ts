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

  const catalog =
    language &&
    languageCatalogSchema.safeParse(project.documents[`languages/${language}/messages.json`])

  return {
    ...(input?.success ? { input: input.data } : {}),
    ...(sources.length ? { rules: mergeRuleSources(sources).rules, ruleFiles } : {}),
    ...(assets?.success ? { assets: assets.data } : {}),
    ...(inventory ? { inventory } : {}),
    ...(catalog && catalog.success ? { translationKeys: Object.keys(catalog.data).sort() } : {}),
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
