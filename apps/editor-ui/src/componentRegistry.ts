import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import {
  inventoryComponentSchema,
  sceneComponentSchema,
  type SceneComponentDefinition,
} from '@ancadeba/schemas'
import {
  createComponentDraft,
  creatableComponentTypes,
  type BasicComponent,
} from './componentDrafts.js'

export type ComponentType = SceneComponentDefinition['type']

type Scene = ProjectView['scenes'][number]

export const componentGroups = {
  text: 'visuals',
  'message-history': 'visuals',
  graphic: 'visuals',
  'background-image': 'visuals',
  'map-view': 'visuals',
  button: 'interaction',
  'action-bar': 'interaction',
  'action-info': 'interaction',
  nearby: 'interaction',
  form: 'interaction',
  'character-view': 'character',
  'character-sheet': 'character',
  'character-progression': 'character',
  'status-panel': 'character',
  'quest-log': 'character',
  inventory: 'items',
  crafting: 'items',
  'item-details': 'items',
  equipment: 'items',
  shop: 'items',
  combat: 'items',
  'language-select': 'saving',
  'save-slots': 'saving',
  'save-status': 'saving',
  'save-point': 'saving',
} as const satisfies Record<ComponentType, string>

export const inspectorTypes = Object.keys(componentGroups).filter((type): type is ComponentType =>
  Object.hasOwn(componentGroups, type),
)

export const isBasicComponent = (
  component: SceneComponentDefinition,
): component is BasicComponent => creatableComponentTypes.some((type) => component.type === type)

const availableDescription = (scene: Scene) =>
  scene.components.find(
    (candidate) =>
      candidate.type === 'text' &&
      !scene.components.some(
        (component) => component.type === 'nearby' && component.descriptionTarget === candidate.id,
      ),
  )

export function componentUnavailable(
  type: ComponentType,
  scene: Scene,
  view: ProjectView,
): string | undefined {
  if (
    scene.type !== 'game' &&
    [
      'action-bar',
      'nearby',
      'character-progression',
      'status-panel',
      'inventory',
      'crafting',
      'item-details',
      'equipment',
      'shop',
      'combat',
      'save-point',
    ].includes(type)
  )
    return 'inspector.gameScene'

  if (
    ['action-bar', 'shop', 'combat'].includes(type) &&
    scene.components.some((entry) => entry.type === type)
  )
    return 'inspector.exists.' + type

  switch (type) {
    case 'nearby':
      return availableDescription(scene) ? undefined : 'inspector.textFirst'
    case 'map-view':
      return view.game?.maps?.length ? undefined : 'component.mapHelp'
    case 'graphic':
      return [view.assets?.images, view.assets?.parts, view.assets?.compositions].some(
        (items) => Object.keys(items ?? {}).length,
      )
        ? undefined
        : 'graphic.artFirst'
    case 'background-image':
      return Object.keys(view.assets?.images ?? {}).length ? undefined : 'graphic.artFirst'
    case 'combat':
      return Object.keys(view.combatSources ?? {}).length ? undefined : 'inspector.encounterFirst'
    case 'character-progression':
      return Object.keys(view.leveling ?? {}).length ? undefined : 'inspector.profileFirst'
    case 'character-view':
      return Object.keys(view.game?.appearances?.characters ?? {}).length
        ? undefined
        : 'appearance.createFirst'
    case 'character-sheet':
      return view.game?.characterProfile ? undefined : 'inspector.characterProfileFirst'
    case 'form':
      if (!view.game?.forms?.length) return 'forms.createFirst'

      if (scene.type === 'game') return undefined

      return view.scenes.some((entry) => entry.id !== scene.id && entry.type === 'game')
        ? undefined
        : 'inspector.destinationFirst'
    case 'crafting':
    case 'inventory':
      return Object.keys(view.inventory?.owners ?? {}).length ? undefined : 'items.ownerFirst'
    case 'equipment':
    case 'item-details':
      return scene.components.some(
        (entry) => entry.type === 'inventory' && (type !== 'equipment' || entry.owners.length),
      )
        ? undefined
        : 'items.panelFirst'
    case 'shop':
      return Object.keys(view.inventory?.owners ?? {}).length >= 2 &&
        view.rules?.state.some((field) => typeof field.value === 'number')
        ? undefined
        : 'inspector.shopNeeds'
    default:
      return undefined
  }
}

function uniqueId(scene: Scene, base: string) {
  let id = base
  let index = 2

  while (scene.components.some((component) => component.id === id)) id = base + '-' + index++

  return id
}

export function shopCreationPanels(scene: Scene, view: ProjectView) {
  const owners = Object.keys(view.inventory?.owners ?? {})

  return ['player-items', 'merchant-items'].map((base, index) =>
    inventoryComponentSchema.parse({
      id: uniqueId(scene, base),
      type: 'inventory',
      label: index ? 'Merchant inventory' : 'Your inventory',
      owners: [owners[index]],
      readOnly: true,
      placement: { row: 1, column: Math.min(index + 1, scene.screen.grid.columns) },
    }),
  )
}

export function newInspectorComponent(
  type: ComponentType,
  scene: Scene,
  view: ProjectView,
): SceneComponentDefinition | undefined {
  const basic = creatableComponentTypes.find((candidate) => candidate === type)

  if (basic) return createComponentDraft(view, scene.id, basic)

  if (componentUnavailable(type, scene, view)) return
  const base = { id: uniqueId(scene, type), type, placement: { row: 1, column: 1 } }

  const inventory = scene.components.find(
    (component) =>
      component.type === 'inventory' && (type !== 'equipment' || component.owners.length),
  )

  const asset = [view.assets?.images, view.assets?.parts, view.assets?.compositions].flatMap(
    (values) => Object.keys(values ?? {}),
  )[0]

  switch (type) {
    case 'graphic':
      return sceneComponentSchema.parse({ ...base, visual: asset, alt: '' })
    case 'nearby':
      return sceneComponentSchema.parse({
        ...base,
        descriptionTarget: availableDescription(scene)?.id,
        entries: {},
      })
    case 'inventory':
      return sceneComponentSchema.parse({
        ...base,
        owners: [Object.keys(view.inventory!.owners)[0]],
      })
    case 'item-details':
    case 'equipment':
      return sceneComponentSchema.parse({
        ...base,
        inventory: inventory?.id,
        owner: inventory?.type === 'inventory' ? inventory.owners[0] : undefined,
      })
    case 'combat':
      return sceneComponentSchema.parse({ ...base, encounter: Object.keys(view.combatSources!)[0] })
    case 'character-progression':
      return sceneComponentSchema.parse({ ...base, profile: Object.keys(view.leveling!)[0] })
    case 'shop': {
      const panels = shopCreationPanels(scene, view)

      return sceneComponentSchema.parse({
        ...base,
        playerInventory: panels[0]!.id,
        merchantInventory: panels[1]!.id,
        playerBalance: {
          source: 'game.state',
          path: view.rules!.state.find((field) => typeof field.value === 'number')!.path,
        },
        merchantFunds: { type: 'unlimited' },
        prices: {},
      })
    }

    case 'action-bar':
      return sceneComponentSchema.parse({ ...base, slots: {} })
    case 'status-panel':
      return sceneComponentSchema.parse(base)
  }
}

export function componentSaveCommand(
  sceneId: string,
  component: SceneComponentDefinition,
  creating: boolean,
  panels: ReturnType<typeof shopCreationPanels>,
): EditorCommand {
  const creation = creating ? { createOnly: true } : {}

  switch (component.type) {
    case 'graphic':
      return { type: 'scene.upsertGraphic', sceneId, component, ...creation }
    case 'nearby':
      return { type: 'scene.upsertNearby', sceneId, component }
    case 'action-bar':
      return { type: 'scene.setActionBar', sceneId, component }
    case 'status-panel':
      return { type: 'scene.upsertStatusPanel', sceneId, component, ...creation }
    case 'inventory':
    case 'equipment':
    case 'item-details':
      return { type: 'scene.upsertItemView', sceneId, component, ...creation }
    case 'shop':
      return { type: 'scene.upsertShop', sceneId, component, ...(creating ? { panels } : {}) }
    case 'combat':
      return { type: 'scene.setCombat', sceneId, component }
    case 'character-progression':
      return { type: 'scene.upsertLevelingView', sceneId, component }
    default:
      return { type: 'scene.upsertComponent', sceneId, component, ...creation }
  }
}
