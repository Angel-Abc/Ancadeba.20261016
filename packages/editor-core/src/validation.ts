import type { z } from 'zod'
import {
  gameSchema,
  inputSchema,
  sceneSchema,
  languageCatalogSchema,
  localizeDefinitions,
  assertGameLanguages,
  type LanguageCatalog,
  type SceneDefinition,
  assetCatalogSchema,
  assertGraphicReference,
  mapDefinitionSchema,
  resolveMapView,
  type MapDefinition,
  inventorySchema,
  validateInventorySources,
  inventoryPanelIssues,
  validateRuleSources,
  gameRulesSchema,
} from '@ancadeba/schemas'
import {
  projectInventorySources,
  projectRuleSources,
  type Diagnostic,
  type ProjectDocuments,
} from './project.js'

export function validateProject(
  documents: ProjectDocuments,
  sourceDiagnostics: readonly Diagnostic[] = [],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...sourceDiagnostics]

  const check = <T>(file: string, schema: z.ZodType<T>) => {
    const result = schema.safeParse(documents[file])

    if (!result.success && !sourceDiagnostics.some((diagnostic) => diagnostic.file === file)) {
      diagnostics.push(
        ...result.error.issues.map((issue) => ({
          code: 'invalid_document',
          file,
          path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          message: issue.message,
        })),
      )
    }

    return result
  }

  const game = check('game.json', gameSchema)

  if (!game.success) return diagnostics

  const scenes = new Map<string, SceneDefinition>()

  for (const id of game.data.scenes) {
    const file = `scenes/${id}.json`
    const scene = check(file, sceneSchema)

    if (scene.success) scenes.set(id, scene.data)

    if (scene.success && scene.data.id !== id) {
      diagnostics.push({
        code: 'scene_id_mismatch',
        file,
        path: ['id'],
        message: `Expected scene ID ${id}`,
      })
    }
  }

  if (game.data.input) check(game.data.input, inputSchema)

  const maps = new Map<string, MapDefinition>()

  for (const id of game.data.maps ?? []) {
    const map = check(`maps/${id}.json`, mapDefinitionSchema)

    if (map.success) maps.set(id, map.data)
  }

  const assets =
    typeof game.data.assets === 'string' ? check(game.data.assets, assetCatalogSchema) : undefined

  const inventorySources = projectInventorySources(
    game.data.inventory,
    (file) => check(file, inventorySchema).data,
  )

  const { inventory, issues } = validateInventorySources(inventorySources, assets?.data)

  for (const issue of issues) diagnostics.push({ ...issue, code: 'invalid_inventory' })

  for (const [id, scene] of scenes) {
    scene.components.forEach((component, index) => {
      if (component.type === 'inventory') {
        for (const issue of inventoryPanelIssues(
          component.owners,
          component.previews,
          inventory,
          assets?.data,
        ))
          diagnostics.push({
            code: 'invalid_inventory_panel',
            file: `scenes/${id}.json`,
            path: ['components', index, ...issue.path],
            message: issue.message,
          })
      }

      if (component.type !== 'graphic' && component.type !== 'map-view') return

      try {
        if (component.type === 'map-view')
          resolveMapView(maps, component.map, component.viewport, component.playerSpawn)
        else {
          if (!assets?.success) throw new Error('Graphic requires a valid asset catalogue')
          assertGraphicReference(assets.data, component.visual, component.appearance)
        }
      } catch (error) {
        diagnostics.push({
          code: component.type === 'graphic' ? 'invalid_graphic' : 'invalid_map_view',
          file: `scenes/${id}.json`,
          path: ['components', index],
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  let defaultMessages: LanguageCatalog | undefined

  if (game.data.languages) {
    const catalogs = new Map<string, LanguageCatalog>()

    for (const language of game.data.languages.available) {
      const catalog = check(`languages/${language}/messages.json`, languageCatalogSchema)

      if (catalog.success) catalogs.set(language, catalog.data)
    }

    const fallback = catalogs.get(game.data.languages.default)
    defaultMessages = fallback

    if (fallback && scenes.size === game.data.scenes.length) {
      for (const [language, messages] of catalogs) {
        try {
          localizeDefinitions(game.data, scenes, { fallback, messages })
        } catch (error) {
          diagnostics.push({
            code: 'invalid_translation',
            file: `languages/${language}/messages.json`,
            path: [],
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  const sources = projectRuleSources(game.data.rules, (file) => check(file, gameRulesSchema).data)

  for (const issue of validateRuleSources(sources, scenes, maps, inventory, defaultMessages).issues)
    diagnostics.push({ ...issue, code: 'invalid_rules' })

  try {
    assertGameLanguages(game.data, scenes)
  } catch (error) {
    diagnostics.push({
      code: 'missing_languages',
      file: 'game.json',
      path: ['languages'],
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return diagnostics
}
