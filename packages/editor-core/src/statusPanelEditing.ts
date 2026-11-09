import type { GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

export function editStatusPanel(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'scene.upsertStatusPanel' | 'scene.removeStatusPanel' }>,
): string[] {
  const file = `scenes/${command.sceneId}.json`
  const scene = object(documents[file])

  if (!game.scenes.includes(command.sceneId) || scene.type !== 'game')
    throw new EditorError(422, 'invalid_status_scene', 'Select an existing game scene')
  const components = Array.isArray(scene.components) ? [...scene.components] : []
  const id = command.type === 'scene.upsertStatusPanel' ? command.component.id : command.componentId
  const index = components.findIndex((entry) => object(entry).id === id)
  const previous = object(components[index])

  if (command.type === 'scene.upsertStatusPanel' && command.createOnly && index >= 0)
    throw new EditorError(409, 'component_exists', 'A component with this ID already exists')

  if (index >= 0 && previous.type !== 'status-panel')
    throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

  if (command.type === 'scene.removeStatusPanel') {
    if (index < 0) throw new EditorError(404, 'component_not_found', 'Status panel does not exist')
    components.splice(index, 1)
  } else {
    const panel = command.component
    const oldRows = Array.isArray(previous.rows) ? previous.rows.map(object) : []
    const oldEffects = Array.isArray(previous.effects) ? previous.effects.map(object) : []

    const next = {
      ...previous,
      ...panel,
      labelKey: panel.labelKey,
      nameKey: panel.nameKey,
      portrait: panel.portrait,
      placement: { ...object(previous.placement), ...panel.placement },
      rows: panel.rows.map((row) => ({
        ...oldRows.find((old) => old.id === row.id),
        ...row,
        labelKey: row.labelKey,
        maximum: row.type === 'bar' ? row.maximum : undefined,
        color: row.type === 'bar' ? row.color : undefined,
      })),
      effects: panel.effects.map((effect) => ({
        ...oldEffects.find((old) => old.id === effect.id),
        ...effect,
        labelKey: effect.labelKey,
        descriptionKey: effect.descriptionKey,
        icon: effect.icon,
        visibleWhen: effect.visibleWhen,
      })),
    }

    if (index < 0) components.push(next)
    else components[index] = next
  }

  documents[file] = { ...scene, components }

  return [file]
}
