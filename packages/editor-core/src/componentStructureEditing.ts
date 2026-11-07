import type { GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

/** Copies complete source components or changes their array order without changing placement. */
export function editComponentStructure(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    { type: 'scene.duplicateComponent' | 'scene.moveComponent' | 'scene.pasteComponent' }
  >,
): string[] {
  if (!game.scenes.includes(command.sceneId))
    throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
  const file = `scenes/${command.sceneId}.json`
  const source = object(documents[file])
  const components = Array.isArray(source.components) ? [...source.components] : []

  if (command.type === 'scene.pasteComponent') {
    if (components.some((entry) => object(entry).id === command.newId))
      throw new EditorError(409, 'component_exists', 'A component with this ID already exists')
    const component = JSON.parse(JSON.stringify(command.component))
    documents[file] = {
      ...source,
      components: [
        ...components,
        {
          ...component,
          id: command.newId,
          ...(command.placement
            ? { placement: { ...object(component.placement), ...command.placement } }
            : {}),
        },
      ],
    }

    return [file]
  }

  const index = components.findIndex((entry) => object(entry).id === command.componentId)

  if (index < 0) throw new EditorError(404, 'component_not_found', 'Component does not exist')

  if (command.type === 'scene.duplicateComponent') {
    if (components.some((entry) => object(entry).id === command.newId))
      throw new EditorError(409, 'component_exists', 'A component with this ID already exists')
    const component = object(components[index])

    if (['action-bar', 'shop', 'combat'].includes(String(component.type)))
      throw new EditorError(
        422,
        'singleton_component',
        'Only one of this component is allowed per scene',
      )
    components.splice(index + 1, 0, { ...JSON.parse(JSON.stringify(component)), id: command.newId })
  } else {
    if (command.index >= components.length)
      throw new EditorError(
        422,
        'invalid_component_index',
        'Choose a position within the scene component list',
      )
    const [component] = components.splice(index, 1)
    components.splice(command.index, 0, component)
  }

  documents[file] = { ...source, components }

  return [file]
}
