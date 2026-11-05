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
  | TextComponentData
  | ButtonComponentData
  | LanguageSelectComponentData
  | GraphicComponentDefinition
  | MapViewComponentData
  | InventoryComponentData
  | ActionBarComponentDefinition

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
      readonly compactColumns?: readonly number[] | undefined
    }
  }
  readonly components: readonly SceneComponentData[]
}

export interface GameData {
  readonly assets?: AssetCatalog
  readonly inventory?: InventoryDefinition
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
): GameData {
  assertGameLanguages(definition, sceneDefinitions)

  const inventorySources = (definition.inventory ?? []).map((id) => {
    const file = inventoryFile(id)
    const inventory = inventoryDefinitions.get(id)

    if (!inventory) throw new Error(`Missing inventory definition: ${file}`)

    return { file, inventory }
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

    const { rows, columns, compactColumns } = scene.screen.grid

    scenes.set(id, {
      id: scene.id,
      title: scene.title,
      description: scene.description,
      type: scene.type,
      screen: {
        type: scene.screen.type,
        grid: { rows, columns, ...(compactColumns && { compactColumns: [...compactColumns] }) },
      },
      components: scene.components.map((component) => {
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
      if (component.type === 'action-bar') {
        const issue = actionBarIssues(component, inputDefinition, sceneDefinitions)[0]

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
        component.action.type === 'request-action'
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
