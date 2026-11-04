import {
  gameSchema,
  sceneSchema,
  assetCatalogSchema,
  inventorySchema,
  languageCatalogSchema,
  gameRulesSchema,
  mergeRuleSources,
} from '@ancadeba/schemas'
import { validateProject } from './validation.js'
import { projectRuleSources, type ProjectSnapshot, type ProjectView } from './project.js'

export function inspectProject(project: ProjectSnapshot): ProjectView {
  const game = gameSchema.safeParse(project.documents['game.json'])

  const assets =
    game.success && typeof game.data.assets === 'string'
      ? assetCatalogSchema.safeParse(project.documents[game.data.assets])
      : undefined

  const inventory =
    game.data?.inventory && inventorySchema.safeParse(project.documents[game.data.inventory])

  const language = game.data?.languages?.default

  const sources = projectRuleSources(
    game.data?.rules,
    (file) => gameRulesSchema.safeParse(project.documents[file]).data,
  )

  const ruleFiles = Object.fromEntries(
    sources.filter(({ file }) => file !== 'game.json').map(({ file, rules }) => [file, rules]),
  )

  const catalog =
    language &&
    languageCatalogSchema.safeParse(project.documents[`languages/${language}/messages.json`])

  return {
    ...(sources.length ? { rules: mergeRuleSources(sources).rules, ruleFiles } : {}),
    ...(assets?.success ? { assets: assets.data } : {}),
    ...(inventory && inventory.success ? { inventory: inventory.data } : {}),
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
