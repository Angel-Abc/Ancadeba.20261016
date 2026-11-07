import {
  combatLibraryIssues,
  freezeCombatDefinition,
  resolveCombatSource,
  type CombatSource,
  type CombatLibrary,
  combatStatsIssues,
  levelingIssues,
  localizeLeveling,
  type LevelingProfile,
} from '@ancadeba/schemas'
import { combatLootViewIssues } from '@ancadeba/schemas'
import type {
  GameDefinition,
  InputDefinition,
  SceneDefinition,
  TextComponentDefinition,
  ButtonComponentDefinition,
  LanguageSelectComponentDefinition,
  GraphicComponentDefinition,
  MapDefinition,
  MapViewComponentDefinition,
  AssetCatalog,
  InventoryDefinition,
  InventoryComponentDefinition,
  GameRulesDefinition,
  GameTranslation,
  ActionBarComponentDefinition,
  NearbyComponentDefinition,
  StatusPanelComponentDefinition,
  ItemDetailsComponentDefinition,
  EquipmentComponentDefinition,
  ShopComponentDefinition,
  CombatDefinition,
} from '@ancadeba/schemas'
import type { TextTemplate } from './textBindings.js'
import {
  assertGameLanguages,
  assertGraphicReference,
  validateInventorySources,
  inventoryPanelIssues,
  inventoryFile,
  ruleFile,
  validateRuleSources,
  resolveMapView,
  actionBarIssues,
  statusPanelIssues,
  localizeInventory,
  equipmentIssues,
  shopIssues,
  combatIssues,
  localizeCombat,
} from '@ancadeba/schemas'
import type { IGameLocalization } from './gameLocalization.js'

export interface TextComponentData extends TextTemplate {
  readonly id: string
  readonly type: 'text'
  readonly text: string
  readonly placement: Readonly<TextComponentDefinition['placement']>
  readonly presentation: Readonly<TextComponentDefinition['presentation']>
}

export interface ButtonComponentData {
  readonly id: string
  readonly type: 'button'
  readonly label: string
  readonly placement: Readonly<ButtonComponentDefinition['placement']>
  readonly action?: Readonly<NonNullable<ButtonComponentDefinition['action']>> | undefined
}

export interface LanguageSelectComponentData {
  readonly id: string
  readonly type: 'language-select'
  readonly label: string
  readonly placement: Readonly<LanguageSelectComponentDefinition['placement']>
}

export type SceneComponentData =
  | Extract<SceneDefinition['components'][number], { type: 'combat' | 'character-progression' }>
  | TextComponentData
  | ButtonComponentData
  | LanguageSelectComponentData
  | GraphicComponentDefinition
  | MapViewComponentData
  | InventoryComponentData
  | ActionBarComponentDefinition
  | NearbyComponentDefinition
  | StatusPanelComponentDefinition
  | ItemDetailsComponentDefinition
  | EquipmentComponentDefinition
  | ShopComponentDefinition

export type GraphicComponentData = GraphicComponentDefinition

export type InventoryComponentData = InventoryComponentDefinition

export interface MapViewComponentData extends Omit<MapViewComponentDefinition, 'map'> {
  readonly map: MapDefinition
}

export interface InputData {
  readonly virtualKeys: readonly string[]
  readonly keyboard: Readonly<Record<string, string>>
  readonly contexts: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly initialContext: string
}

export interface SceneData {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly type: SceneDefinition['type']
  readonly screen: {
    readonly type: 'grid'
    readonly grid: {
      readonly rows: number
      readonly columns: number
    }
  }
  readonly components: readonly SceneComponentData[]
}

export interface GameData {
  readonly leveling?: ReadonlyMap<string, LevelingProfile> | undefined
  readonly combat?: ReadonlyMap<string, CombatDefinition> | undefined
  readonly assets?: AssetCatalog
  readonly inventory?: InventoryDefinition | undefined
  readonly rules?: GameRulesDefinition
  readonly ruleTranslation?: GameTranslation | undefined
  readonly localization?: IGameLocalization
  readonly language?: string
  readonly id: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly initialScene?: string
  /** Contents of the optional game stylesheet. */
  readonly stylesheet?: string
  readonly input?: InputData
  /** Iteration follows the manifest order. */
  readonly scenes: ReadonlyMap<string, SceneData>
}

/** Assemble already validated definitions without performing resource I/O. */
export function assembleGameData(
  definition: GameDefinition,
  sceneDefinitions: ReadonlyMap<string, SceneDefinition>,
  inputDefinition?: InputDefinition,
  assets?: AssetCatalog,
  maps: ReadonlyMap<string, MapDefinition> = new Map(),
  inventoryDefinitions: ReadonlyMap<string, InventoryDefinition> = new Map(),
  ruleTranslation?: GameTranslation,
  ruleDefinitions: ReadonlyMap<string, GameRulesDefinition> = new Map(),
  combatDefinitions: ReadonlyMap<string, CombatSource> = new Map(),
  levelingDefinitions: ReadonlyMap<string, LevelingProfile> = new Map(),
  combatLibraries: ReadonlyMap<string, CombatLibrary> = new Map(),
): GameData {
  assertGameLanguages(definition, sceneDefinitions)

  const inventorySources = (definition.inventory ?? []).map((id) => {
    const file = inventoryFile(id)
    const inventory = inventoryDefinitions.get(id)

    if (!inventory) throw new Error(`Missing inventory definition: ${file}`)

    return { file, inventory: localizeInventory(inventory, ruleTranslation) }
  })

  const { inventory, issues: inventoryDiagnostics } = validateInventorySources(
    inventorySources,
    assets,
  )

  const sources = (definition.rules ?? []).map((id) => {
    const file = ruleFile(id)
    const rules = ruleDefinitions.get(id)

    if (!rules) throw new Error(`Missing rule definition: ${file}`)

    return { file, rules }
  })

  const validated = sources.length
    ? validateRuleSources(sources, sceneDefinitions, maps, inventory, ruleTranslation?.fallback)
    : undefined

  const issue = validated?.issues[0]

  if (issue) throw new Error(`${issue.file} (${issue.path.join('.')}): ${issue.message}`)

  for (const id of definition.combatLibraries ?? []) {
    const library = combatLibraries.get(id)

    if (!library || library.id !== id)
      throw new Error(`Missing or mismatched combat library: ${id}`)
    const problem = combatLibraryIssues(library, assets, ruleTranslation)[0]

    if (problem) throw new Error(`${problem.file} (${problem.path.join('.')}): ${problem.message}`)
  }

  const declaredLibraries = new Map(
    [...combatLibraries].filter(([id]) => definition.combatLibraries?.includes(id)),
  )

  const combat = new Map<string, CombatDefinition>()

  for (const id of definition.combat ?? []) {
    const source = combatDefinitions.get(id)

    if (!source || source.id !== id)
      throw new Error(`Missing or mismatched combat definition: ${id}`)

    const resolved = resolveCombatSource(source, declaredLibraries)

    if (!resolved.definition)
      throw new Error(
        resolved.issues
          .map((issue) => `${issue.file} (${issue.path.join('.')}): ${issue.message}`)
          .join('\n'),
      )
    const encounter = resolved.definition

    const problem = combatIssues(
      encounter,
      validated?.rules,
      new Set(definition.scenes),
      assets,
      inventory,
    )[0]

    if (problem) throw new Error(`Combat ${id}: ${problem.message}`)

    if (
      encounter.rewards?.lootOwner &&
      [...combat.values()].some(
        (other) => other.rewards?.lootOwner === encounter.rewards?.lootOwner,
      )
    )
      throw new Error('Each encounter requires a distinct loot owner')
    combat.set(id, freezeCombatDefinition(localizeCombat(encounter, ruleTranslation)))
  }

  const leveling = new Map<string, LevelingProfile>()

  for (const id of definition.leveling ?? []) {
    const profile = levelingDefinitions.get(id)

    if (!profile) throw new Error(`Missing leveling profile: ${id}`)
    leveling.set(id, localizeLeveling(profile, ruleTranslation))
  }

  const levelingIssue = levelingIssues(
    leveling,
    validated?.rules,
    combat,
    sceneDefinitions,
    inventory,
    assets,
  )[0]

  if (levelingIssue) throw new Error(`${levelingIssue.file}: ${levelingIssue.message}`)

  const statIssue = combatStatsIssues(inventory, validated?.rules, combat, [
    sceneDefinitions,
    assets,
    validated?.rules,
  ])[0]

  if (statIssue) throw new Error(`Equipment stats: ${statIssue.message}`)

  if (Boolean(definition.assets) !== Boolean(assets))
    throw new Error('Asset catalogue must match the game assets reference')

  if (Boolean(definition.input) !== Boolean(inputDefinition)) {
    throw new Error('Input definition must match the game input reference')
  }

  const inventoryIssue = inventoryDiagnostics[0]

  if (inventoryIssue)
    throw new Error(
      `${inventoryIssue.file} (${inventoryIssue.path.join('.')}): ${inventoryIssue.message}`,
    )

  const scenes = new Map<string, SceneData>()

  for (const id of definition.scenes) {
    if (scenes.has(id)) throw new Error(`Duplicate scene reference: ${id}`)
    const scene = sceneDefinitions.get(id)

    if (!scene) throw new Error(`Missing scene definition: ${id}`)

    if (scene.id !== id) {
      throw new Error(`Scene scenes/${id}.json has ID ${scene.id}; expected ${id}`)
    }

    const lootIssue = combatLootViewIssues(scene, combat)[0]

    if (lootIssue) throw new Error(lootIssue.message)
    const { rows, columns } = scene.screen.grid

    scenes.set(id, {
      id: scene.id,
      title: scene.title,
      description: scene.description,
      type: scene.type,
      screen: {
        type: scene.screen.type,
        grid: { rows, columns },
      },
      components: scene.components.map((component) => {
        if (component.type === 'shop')
          return {
            ...component,
            placement: { ...component.placement },
            messages: { ...component.messages },
            messageKeys: { ...component.messageKeys },
            playerBalance: { ...component.playerBalance, path: [...component.playerBalance.path] },
            merchantFunds:
              component.merchantFunds.type === 'finite'
                ? {
                    ...component.merchantFunds,
                    balance: {
                      ...component.merchantFunds.balance,
                      path: [...component.merchantFunds.balance.path],
                    },
                  }
                : { ...component.merchantFunds },
            prices: Object.fromEntries(
              Object.entries(component.prices).map(([type, prices]) => [
                type,
                Object.fromEntries(
                  Object.entries(prices).map(([operation, value]) => [
                    operation,
                    typeof value === 'object' ? { ...value, path: [...value.path] } : value,
                  ]),
                ),
              ]),
            ),
          }

        if (component.type === 'equipment')
          return {
            ...component,
            placement: { ...component.placement },
            order: [...component.order],
          }

        if (component.type === 'status-panel')
          return {
            ...component,
            placement: { ...component.placement },
            rows: component.rows.map((row) =>
              row.type === 'bar'
                ? {
                    ...row,
                    value:
                      typeof row.value === 'object'
                        ? { ...row.value, path: [...row.value.path] }
                        : row.value,
                    maximum:
                      typeof row.maximum === 'object'
                        ? { ...row.maximum, path: [...row.maximum.path] }
                        : row.maximum,
                  }
                : {
                    ...row,
                    value:
                      typeof row.value === 'object'
                        ? { ...row.value, path: [...row.value.path] }
                        : row.value,
                  },
            ),
            effects: component.effects.map((effect) => ({
              ...effect,
              ...(effect.visibleWhen && {
                visibleWhen: { ...effect.visibleWhen, path: [...effect.visibleWhen.path] },
              }),
            })),
          }

        if (component.type === 'nearby')
          return {
            ...component,
            placement: { ...component.placement },
            entries: Object.fromEntries(
              Object.entries(component.entries).map(([id, entry]) => [
                id,
                {
                  ...entry,
                  ...(entry.visibleWhen && {
                    visibleWhen: { ...entry.visibleWhen, path: [...entry.visibleWhen.path] },
                  }),
                  actions: Object.fromEntries(
                    Object.entries(entry.actions).map(([id, action]) => [
                      id,
                      {
                        ...action,
                        ...(action.enabledWhen && {
                          enabledWhen: {
                            ...action.enabledWhen,
                            path: [...action.enabledWhen.path],
                          },
                        }),
                      },
                    ]),
                  ),
                },
              ]),
            ),
          }

        if (component.type === 'action-bar')
          return {
            ...component,
            placement: { ...component.placement },
            slots: Object.fromEntries(
              Object.entries(component.slots).map(([id, slot]) => [
                id,
                {
                  ...slot,
                  ...(slot.inputBinding && { inputBinding: { ...slot.inputBinding } }),
                  action: {
                    ...slot.action,
                    ...(slot.action.type === 'request-action' && slot.action.enabledWhen
                      ? {
                          enabledWhen: {
                            ...slot.action.enabledWhen,
                            path: [...slot.action.enabledWhen.path],
                          },
                        }
                      : {}),
                  },
                },
              ]),
            ),
          }

        if (component.type === 'map-view')
          return {
            ...component,
            placement: { ...component.placement },
            viewport: { ...component.viewport },
            ...(component.playerSpawn && { playerSpawn: { ...component.playerSpawn } }),
            map: resolveMapView(maps, component.map, component.viewport, component.playerSpawn),
          }

        if (component.type === 'button' && component.action) {
          const action = { ...component.action }

          if (action.type === 'request-action' && action.enabledWhen)
            action.enabledWhen = { ...action.enabledWhen, path: [...action.enabledWhen.path] }

          return { ...component, placement: { ...component.placement }, action }
        }

        return component.type !== 'text'
          ? { ...component, placement: { ...component.placement } }
          : {
              ...component,
              placement: { ...component.placement },
              presentation: { ...component.presentation },
              ...(component.bindings === undefined
                ? {}
                : {
                    bindings: Object.fromEntries(
                      Object.entries(component.bindings).map(([alias, binding]) => [
                        alias,
                        { ...binding, path: [...binding.path] },
                      ]),
                    ),
                  }),
            }
      }),
    })
  }

  if (sceneDefinitions.size !== scenes.size) {
    throw new Error('Scene definitions contain unreferenced scenes')
  }

  if (definition['initial-scene'] !== undefined && !scenes.has(definition['initial-scene'])) {
    throw new Error('Initial scene must reference a scene in the manifest')
  }

  for (const scene of scenes.values()) {
    for (const component of scene.components) {
      if (component.type === 'combat' && !combat.has(component.encounter))
        throw new Error(`Unknown combat encounter: ${component.encounter}`)

      if (component.type === 'action-bar')
        for (const slot of Object.values(component.slots)) {
          if (slot.action.type !== 'combat-action' || slot.action.command.type !== 'queue-move')
            continue
          const action = slot.action

          const view = scene.components.find(
            (component) => component.type === 'combat' && component.id === action.combat,
          )

          const definition = view?.type === 'combat' ? combat.get(view.encounter) : undefined

          if (!definition?.player.moves.includes(slot.action.command.move))
            throw new Error('Unknown player combat move')
        }

      if (component.type === 'shop') {
        const issue = shopIssues(component, inventory, validated?.rules)[0]

        if (issue) throw new Error(`Scene ${scene.id}, shop ${component.id}: ${issue.message}`)
      }

      if (component.type === 'equipment') {
        const issue = equipmentIssues(component, inventory)[0]

        if (issue) throw new Error(`Scene ${scene.id}, equipment ${component.id}: ${issue.message}`)
      }

      if (component.type === 'status-panel') {
        const issue = statusPanelIssues(component, assets)[0]

        if (issue)
          throw new Error(`Scene ${scene.id}, status panel ${component.id}: ${issue.message}`)
      }

      if (component.type === 'action-bar') {
        const issue = actionBarIssues(
          component,
          inputDefinition,
          sceneDefinitions,
          sceneDefinitions.get(scene.id),
        )[0]

        if (issue) throw new Error(`Scene ${scene.id}, bar ${component.id}: ${issue.message}`)
      }

      if (component.type === 'graphic') {
        if (!assets) throw new Error(`Graphic ${component.id} requires an asset catalogue`)
        assertGraphicReference(assets, component.visual, component.appearance)
      }

      if (component.type === 'inventory') {
        const issue = inventoryPanelIssues(
          component.owners,
          component.previews,
          inventory,
          assets,
        )[0]

        if (issue) throw new Error(`Scene ${scene.id}, panel ${component.id}: ${issue.message}`)
      }

      if (
        component.type !== 'button' ||
        !component.action ||
        (component.action.type !== 'new-game' && component.action.type !== 'enter-scene')
      )
        continue
      const target = scenes.get(component.action.scene)

      if (!target)
        throw new Error(`Button ${component.id} references missing scene ${component.action.scene}`)

      if (component.action.type === 'new-game' && target.type !== 'game') {
        throw new Error(`New game button ${component.id} must target a game scene`)
      }
    }
  }

  return {
    ...(leveling.size && { leveling }),
    ...(combat.size ? { combat } : {}),
    ...(assets ? { assets } : {}),
    ...(inventory ? { inventory } : {}),
    ...(validated ? { rules: validated.rules, ruleTranslation } : {}),
    id: definition.id,
    title: definition.title,
    description: definition.description,
    version: definition.version,
    ...(definition['initial-scene'] === undefined
      ? {}
      : { initialScene: definition['initial-scene'] }),
    ...(inputDefinition
      ? {
          input: {
            virtualKeys: [...inputDefinition['virtual-keys']],
            keyboard: { ...inputDefinition.keyboard },
            contexts: Object.fromEntries(
              Object.entries(inputDefinition.contexts).map(([id, mappings]) => [
                id,
                { ...mappings },
              ]),
            ),
            initialContext: inputDefinition['initial-context'],
          },
        }
      : {}),
    scenes,
  }
}
