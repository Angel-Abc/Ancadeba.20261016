import {
  combatLibrarySchema,
  itemUseIssues,
  combatLibraryFile,
  combatLibraryIssues,
  combatSourceSchema,
  resolveCombatSource,
  combatStatsIssues,
  levelingFile,
  levelingProfileSchema,
  levelingIssues,
  localizeLeveling,
} from '@ancadeba/schemas'
import { combatLootViewIssues } from '@ancadeba/schemas'
import type { z } from 'zod'
import {
  gameSchema,
  inputSchema,
  inputFile,
  sceneSchema,
  languageCatalogSchema,
  localizeDefinitions,
  assertGameLanguages,
  type LanguageCatalog,
  type SceneDefinition,
  assetCatalogSchema,
  assetCatalogFile,
  assertGraphicReference,
  mapDefinitionSchema,
  resolveMapView,
  type MapDefinition,
  inventorySchema,
  validateInventorySources,
  inventoryPanelIssues,
  validateRuleSources,
  statusPanelIssues,
  localizeInventory,
  equipmentIssues,
  shopIssues,
  gameRulesSchema,
  actionBarIssues,
  combatFile,
  combatIssues,
  localizeCombat,
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

  const input = game.data.input ? check(inputFile(game.data.input), inputSchema).data : undefined

  const libraries = new Map(
    (game.data.combatLibraries ?? []).flatMap((id) => {
      const result = check(combatLibraryFile(id), combatLibrarySchema)

      if (result.success && result.data.id !== id)
        diagnostics.push({
          code: 'invalid_combat_library',
          file: combatLibraryFile(id),
          path: ['id'],
          message: `Expected library ID ${id}`,
        })

      return result.success ? [[id, result.data] as const] : []
    }),
  )

  const leveling = new Map(
    (game.data.leveling ?? []).flatMap((id) => {
      const result = check(levelingFile(id), levelingProfileSchema)

      return result.success ? [[id, result.data] as const] : []
    }),
  )

  const maps = new Map<string, MapDefinition>()

  for (const id of game.data.maps ?? []) {
    const map = check(`maps/${id}.json`, mapDefinitionSchema)

    if (map.success) maps.set(id, map.data)
  }

  const assets = game.data.assets
    ? check(assetCatalogFile(game.data.assets), assetCatalogSchema)
    : undefined

  const inventorySources = projectInventorySources(
    game.data.inventory,
    (file) => check(file, inventorySchema).data,
  )

  const { inventory, issues } = validateInventorySources(inventorySources, assets?.data)

  const combats = new Map(
    (game.data.combat ?? []).flatMap((id) => {
      const result = check(combatFile(id), combatSourceSchema)

      if (!result.success) return []
      const resolved = resolveCombatSource(result.data, libraries, combatFile(id), inventory)

      for (const issue of resolved.issues) diagnostics.push({ code: 'invalid_combat', ...issue })

      return resolved.definition ? [[id, resolved.definition] as const] : []
    }),
  )

  for (const issue of issues) diagnostics.push({ ...issue, code: 'invalid_inventory' })

  for (const [id, scene] of scenes) {
    scene.components.forEach((component, index) => {
      if (component.type === 'equipment')
        for (const issue of equipmentIssues(component, inventory))
          diagnostics.push({
            code: 'invalid_equipment',
            file: `scenes/${id}.json`,
            path: ['components', index, ...issue.path],
            message: issue.message,
          })

      if (component.type === 'status-panel')
        for (const issue of statusPanelIssues(component, assets?.data))
          diagnostics.push({
            code: 'invalid_status_panel',
            file: `scenes/${id}.json`,
            path: ['components', index, ...issue.path],
            message: issue.message,
          })

      if (component.type === 'action-bar')
        for (const issue of actionBarIssues(component, input, scenes, scene))
          diagnostics.push({
            code: 'invalid_action_bar',
            file: `scenes/${id}.json`,
            path: ['components', index, ...issue.path],
            message: issue.message,
          })

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

          if (inventory) localizeInventory(inventory, { fallback, messages })

          for (const combat of combats.values()) localizeCombat(combat, { fallback, messages })

          for (const profile of leveling.values()) localizeLeveling(profile, { fallback, messages })
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

  for (const library of libraries.values())
    for (const issue of combatLibraryIssues(
      library,
      assets?.data,
      defaultMessages ? { fallback: defaultMessages, messages: defaultMessages } : undefined,
    ))
      diagnostics.push({ code: 'invalid_combat_library', ...issue })

  const sources = projectRuleSources(game.data.rules, (file) => check(file, gameRulesSchema).data)

  const validatedRules = validateRuleSources(sources, scenes, maps, inventory, defaultMessages)
  const mergedRules = validatedRules.rules

  for (const issue of itemUseIssues(inventory, libraries, mergedRules))
    diagnostics.push({ code: 'invalid_item_use', file: 'game.json', ...issue })

  for (const issue of levelingIssues(
    leveling,
    mergedRules,
    combats,
    scenes,
    inventory,
    assets?.data,
  ))
    diagnostics.push({ code: 'invalid_leveling', ...issue })

  for (const [id, encounter] of combats) {
    if (encounter.id !== id)
      diagnostics.push({
        code: 'invalid_combat',
        file: combatFile(id),
        path: ['id'],
        message: 'Combat file ID must match its manifest reference',
      })

    for (const issue of combatIssues(
      encounter,
      mergedRules,
      new Set(game.data.scenes),
      assets?.data,
      inventory,
    ))
      diagnostics.push({ code: 'invalid_combat', file: combatFile(id), ...issue })
  }

  for (const issue of combatStatsIssues(inventory, mergedRules, combats, [
    scenes,
    assets?.data,
    mergedRules,
  ]))
    diagnostics.push({ code: 'invalid_combat_stats', file: 'game.json', ...issue })

  for (const [id, encounter] of combats)
    if (
      encounter.rewards?.lootOwner &&
      [...combats.values()].some(
        (other) =>
          other.id !== encounter.id && other.rewards?.lootOwner === encounter.rewards?.lootOwner,
      )
    )
      diagnostics.push({
        code: 'invalid_combat',
        file: combatFile(id),
        path: ['rewards', 'lootOwner'],
        message: 'Each encounter requires a distinct loot owner',
      })

  for (const [id, scene] of scenes)
    for (const issue of combatLootViewIssues(scene, combats))
      diagnostics.push({ code: 'invalid_combat', file: `scenes/${id}.json`, ...issue })

  for (const [id, scene] of scenes)
    scene.components.forEach((component, index) => {
      if (component.type === 'combat' && !combats.has(component.encounter))
        diagnostics.push({
          code: 'invalid_combat',
          file: `scenes/${id}.json`,
          path: ['components', index, 'encounter'],
          message: 'Unknown combat encounter',
        })

      if (component.type === 'action-bar')
        for (const [slotId, slot] of Object.entries(component.slots)) {
          const action = slot.action

          if (action.type !== 'combat-action' || action.command.type !== 'queue-move') continue

          const view = scene.components.find(
            (component) => component.type === 'combat' && component.id === action.combat,
          )

          if (
            view?.type !== 'combat' ||
            !combats.get(view.encounter)?.player.moves.includes(action.command.move)
          )
            diagnostics.push({
              code: 'invalid_combat',
              file: `scenes/${id}.json`,
              path: ['components', index, 'slots', slotId],
              message: 'Unknown player combat move',
            })
        }

      if (component.type === 'shop')
        for (const issue of shopIssues(component, inventory, mergedRules))
          diagnostics.push({
            code: 'invalid_shop',
            file: `scenes/${id}.json`,
            path: ['components', index, ...issue.path],
            message: issue.message,
          })
    })

  for (const issue of validatedRules.issues) diagnostics.push({ ...issue, code: 'invalid_rules' })

  try {
    assertGameLanguages(game.data, scenes)

    if (inventory && !game.data.languages) localizeInventory(inventory)

    if (!game.data.languages) {
      for (const combat of combats.values()) localizeCombat(combat)

      for (const profile of leveling.values()) localizeLeveling(profile)
    }
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
