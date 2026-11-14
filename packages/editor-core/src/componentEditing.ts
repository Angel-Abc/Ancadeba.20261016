import { buttonActionSchema, type GameDefinition } from '@ancadeba/schemas'
import { basicComponentSchema, type EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

const actionFields = new Set(
  buttonActionSchema.options.flatMap((option) => Object.keys(option.shape)),
)

/** Saves a text, button, language selector, or map view in place, keeping its list position. */
export function editComponent(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'scene.upsertComponent' }>,
): string[] {
  const file = `scenes/${command.sceneId}.json`

  if (!game.scenes.includes(command.sceneId))
    throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
  const scene = object(documents[file])
  const components = Array.isArray(scene.components) ? [...scene.components] : []
  const { component } = command
  const index = components.findIndex((entry) => object(entry).id === component.id)
  const previous = object(components[index])

  if (command.createOnly && index >= 0)
    throw new EditorError(409, 'component_exists', 'A component with this ID already exists')

  if (index >= 0 && previous.type !== component.type)
    throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

  const schema = basicComponentSchema.options.find(
    (option) => option.shape.type.value === component.type,
  )

  // Known fields the author cleared are removed; unknown extension fields are kept.
  const cleared = Object.fromEntries(
    Object.keys(schema?.shape ?? {})
      .filter((key) => !Object.hasOwn(component, key))
      .map((key) => [key, undefined]),
  )

  const next = {
    ...previous,
    ...cleared,
    ...component,
    placement: { ...object(previous.placement), ...component.placement },
    ...(component.type === 'text'
      ? { presentation: { ...object(previous.presentation), ...component.presentation } }
      : {}),
    ...(component.type === 'map-view'
      ? {
          viewport: { ...object(previous.viewport), ...component.viewport },
          playerSpawn: component.playerSpawn
            ? { ...object(previous.playerSpawn), ...component.playerSpawn }
            : undefined,
        }
      : {}),
    ...(component.type === 'button' && component.action
      ? {
          action: {
            ...Object.fromEntries(
              Object.entries(object(previous.action)).filter(([key]) => !actionFields.has(key)),
            ),
            ...component.action,
            ...(component.action.type === 'request-action' && component.action.enabledWhen
              ? {
                  enabledWhen: {
                    ...object(object(previous.action).enabledWhen),
                    ...component.action.enabledWhen,
                    fallback: component.action.enabledWhen.fallback,
                  },
                }
              : {}),
            ...(component.action.type === 'enter-scene' && component.action.position
              ? {
                  position: {
                    ...object(object(previous.action).position),
                    ...component.action.position,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(component.type === 'text' && component.bindings !== undefined
      ? {
          bindings: Object.fromEntries(
            Object.entries(component.bindings).map(([alias, binding]) => [
              alias,
              {
                ...object(object(previous.bindings)[alias]),
                ...binding,
                fallback: binding.fallback,
              },
            ]),
          ),
        }
      : {}),
  }

  if (index < 0) components.push(next)
  else components[index] = next
  documents[file] = { ...scene, components }

  return [file]
}
