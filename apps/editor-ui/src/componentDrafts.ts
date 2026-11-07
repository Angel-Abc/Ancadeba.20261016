import type { ProjectView } from '@ancadeba/editor-core'
import {
  type ButtonComponentDefinition,
  type LanguageSelectComponentDefinition,
  type MapViewComponentDefinition,
  type QuestLogComponentDefinition,
  type TextComponentDefinition,
} from '@ancadeba/schemas'

export const creatableComponentTypes = [
  'text',
  'button',
  'map-view',
  'language-select',
  'quest-log',
] as const

export type CreatableComponentType = (typeof creatableComponentTypes)[number]

export type BasicComponent =
  | TextComponentDefinition
  | ButtonComponentDefinition
  | MapViewComponentDefinition
  | LanguageSelectComponentDefinition
  | QuestLogComponentDefinition

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

  if (type === 'text')
    return {
      id,
      type,
      text: 'New text',
      placement,
      presentation: { variant: 'body', align: 'start' },
    }

  if (type === 'button') return { id, type, label: 'Button', placement }

  if (type === 'language-select') return { id, type, label: 'Language', placement }

  if (type === 'quest-log')
    return { id, type, label: 'Quests', placement, statuses: ['active', 'ready', 'completed'] }
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
