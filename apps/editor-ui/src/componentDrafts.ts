import type { ProjectView } from '@ancadeba/editor-core'
import type { SceneComponentDefinition } from '@ancadeba/schemas'

export const creatableComponentTypes = [
  'save-slots',
  'save-status',
  'save-point',
  'text',
  'message-history',
  'button',
  'action-info',
  'map-view',
  'background-image',
  'language-select',
  'quest-log',
  'crafting',
  'form',
  'character-sheet',
  'character-view',
] as const

export type CreatableComponentType = (typeof creatableComponentTypes)[number]

export type BasicComponent = Extract<SceneComponentDefinition, { type: CreatableComponentType }>

/** Supplies unique IDs and grid-sized defaults without mutating the saved project. */
export function createComponentDraft(
  view: ProjectView,
  sceneId: string,
  type: CreatableComponentType,
): BasicComponent | undefined {
  const scene = view.scenes.find(({ id }) => id === sceneId)

  if (!scene) return
  let id: string = type
  let suffix = 2

  while (scene.components.some((component) => component.id === id)) id = `${type}-${suffix++}`

  const placement = {
    row: 1,
    column: 1,
    rowSpan: Math.min(type === 'map-view' ? 6 : type === 'text' ? 3 : 2, scene.screen.grid.rows),
    columnSpan: Math.min(type === 'button' ? 4 : 8, scene.screen.grid.columns),
  }

  if (type === 'background-image')
    return {
      id,
      type,
      image: Object.keys(view.assets?.images ?? {})[0] ?? '',
      fit: 'cover',
      placement: {
        row: 1,
        column: 1,
        rowSpan: scene.screen.grid.rows,
        columnSpan: scene.screen.grid.columns,
      },
    }

  if (type === 'text')
    return {
      id,
      type,
      text: 'New text',
      placement,
      presentation: { variant: 'body', align: 'start' },
    }

  if (type === 'button') return { id, type, label: 'Button', placement }

  if (type === 'message-history')
    return {
      id,
      type,
      label: 'Message history',
      placement: { ...placement, rowSpan: Math.min(5, scene.screen.grid.rows) },
    }

  if (type === 'action-info')
    return {
      id,
      type,
      label: 'Action information',
      emptyText: 'Hover over or focus an action to see its description.',
      placement,
    }

  if (type === 'save-slots') return { id, type, label: 'Save slots', placement, showName: true }

  if (type === 'save-status') return { id, type, label: 'Save status', placement }

  if (type === 'save-point') return { id, type, label: 'Save game', placement }

  if (type === 'language-select') return { id, type, label: 'Language', placement }

  if (type === 'form')
    return {
      id,
      type,
      label: view.forms?.[view.game?.forms?.[0] ?? '']?.label ?? 'Form',
      form: view.game?.forms?.[0] ?? '',
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      placement,
      continueScene:
        scene.type === 'stand-alone'
          ? view.scenes.find((entry) => entry.type === 'game')?.id
          : undefined,
    }

  if (type === 'character-view')
    return {
      id,
      type,
      label: 'Character',
      character: Object.keys(view.game?.appearances?.characters ?? {})[0] ?? '',
      view: 'full-body',
      placement,
    }

  if (type === 'character-sheet') return { id, type, label: 'Character', placement, rows: [] }

  if (type === 'quest-log')
    return { id, type, label: 'Quests', placement, statuses: ['active', 'ready', 'completed'] }

  if (type === 'crafting') {
    const owner = Object.keys(view.inventory?.owners ?? {})[0]

    if (!owner || scene.type !== 'game') return

    return { id, type, label: 'Crafting', owner, placement }
  }

  const mapId = view.game?.maps?.[0] ?? ''
  const map = view.maps?.[mapId]

  return {
    id,
    type,
    label: 'Map',
    map: mapId,
    placement,
    viewport: {
      columns: Math.min(8, map?.width ?? 8),
      rows: Math.min(6, map?.height ?? 6),
      x: 0,
      y: 0,
    },
  }
}
