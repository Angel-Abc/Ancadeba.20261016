import { actionBarSlotSchema, inputFile, type GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

type ControlCommand = Extract<
  EditorCommand,
  { type: 'scene.setActionBar' | 'game.updateInput' | 'scene.upsertNearby' }
>

const actionFields = new Set(
  actionBarSlotSchema.shape.action.options.flatMap((option) => Object.keys(option.shape)),
)

export function editControls(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: ControlCommand,
): string[] {
  if (command.type === 'game.updateInput') {
    if (game.input && game.input !== command.inputId)
      throw new EditorError(422, 'input_id_mismatch', 'Edit the input file referenced by this game')
    const file = inputFile(command.inputId)

    if (!game.input && Object.hasOwn(documents, file))
      throw new EditorError(409, 'input_exists', 'An input file already exists with that ID')
    documents[file] = { ...object(documents[file]), ...command.input }

    if (game.input) return [file]
    documents['game.json'] = { ...object(documents['game.json']), input: command.inputId }

    return [file, 'game.json']
  }

  const file = `scenes/${command.sceneId}.json`
  const scene = object(documents[file])

  if (!game.scenes.includes(command.sceneId) || scene.type !== 'game')
    throw new EditorError(422, 'invalid_action_bar_scene', 'Select an existing game scene')
  const components = Array.isArray(scene.components) ? [...scene.components] : []

  if (command.type === 'scene.upsertNearby') {
    const next = command.component
    const index = components.findIndex((entry) => object(entry).id === next.id)
    const previous = object(components[index])

    if (index >= 0 && previous.type !== 'nearby')
      throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')
    const entries = object(previous.entries)

    const component = {
      ...previous,
      ...next,
      labelKey: next.labelKey,
      placement: { ...object(previous.placement), ...next.placement },
      entries: Object.fromEntries(
        Object.entries(next.entries).map(([id, entry]) => {
          const old = object(entries[id])
          const oldActions = object(old.actions)

          return [
            id,
            {
              ...old,
              ...entry,
              labelKey: entry.labelKey,
              descriptionKey: entry.descriptionKey,
              dialogue: entry.dialogue,
              conversationId: entry.conversationId,
              visibleWhen: entry.visibleWhen,
              actions: Object.fromEntries(
                Object.entries(entry.actions).map(([id, action]) => [
                  id,
                  {
                    ...object(oldActions[id]),
                    ...action,
                    enabledWhen: action.enabledWhen,
                  },
                ]),
              ),
            },
          ]
        }),
      ),
    }

    if (index < 0) components.push(component)
    else components[index] = component
    documents[file] = { ...scene, components }

    return [file]
  }

  const index = components.findIndex((component) => object(component).type === 'action-bar')
  const previous = object(components[index])
  const component = command.component

  if (!component) {
    if (index < 0) return []
    components.splice(index, 1)
  } else {
    if (components.some((entry, other) => other !== index && object(entry).id === component.id))
      throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')
    const slots = object(previous.slots)

    const next = {
      ...previous,
      ...component,
      placement: { ...object(previous.placement), ...component.placement },
      slots: Object.fromEntries(
        Object.entries(component.slots).map(([id, slot]) => {
          const previousSlot = object(slots[id])

          return [
            id,
            {
              ...previousSlot,
              ...slot,
              labelKey: slot.labelKey,
              action: {
                // Keep extension data while replacing all schema-defined action fields.
                ...Object.fromEntries(
                  Object.entries(object(previousSlot.action)).filter(
                    ([key]) => !actionFields.has(key),
                  ),
                ),
                ...slot.action,
              },
              inputBinding: slot.inputBinding
                ? { ...object(previousSlot.inputBinding), ...slot.inputBinding }
                : undefined,
            },
          ]
        }),
      ),
    }

    if (index < 0) components.push(next)
    else components[index] = next
  }

  documents[file] = { ...scene, components }

  return [file]
}
