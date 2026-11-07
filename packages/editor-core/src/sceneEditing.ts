import {
  sceneSchema,
  gameRulesSchema,
  dialogueSchema,
  questSchema,
  combatSourceSchema,
  type GameDefinition,
} from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object, type ProjectDocuments } from './project.js'

type Path = (string | number)[]

interface SceneReference {
  file: string
  path: Path
  scene: string
}

/** Inspect only schema-defined fields, preserving extension objects and literal text verbatim. */
function references(documents: ProjectDocuments, game: GameDefinition): SceneReference[] {
  const result: SceneReference[] = []

  const inspect = (value: unknown, file: string, path: Path = []) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspect(child, file, [...path, index]))

      return
    }

    for (const [key, child] of Object.entries(object(value))) {
      if (key === 'scene' && typeof child === 'string')
        result.push({ file, path: [...path, key], scene: child })
      else inspect(child, file, [...path, key])
    }
  }

  for (const id of game.scenes)
    inspect(sceneSchema.parse(documents[`scenes/${id}.json`]), `scenes/${id}.json`)

  for (const id of game.rules ?? [])
    inspect(gameRulesSchema.parse(documents[`rules/${id}.json`]), `rules/${id}.json`)

  for (const id of game.dialogues ?? [])
    inspect(dialogueSchema.parse(documents[`dialogues/${id}.json`]), `dialogues/${id}.json`)

  for (const id of game.quests ?? [])
    inspect(questSchema.parse(documents[`quests/${id}.json`]), `quests/${id}.json`)

  for (const id of game.combat ?? []) {
    const file = `combat/${id}.json`
    const combat = combatSourceSchema.parse(documents[file])

    for (const [outcome, scene] of Object.entries(combat.outcomes))
      if (scene) result.push({ file, path: ['outcomes', outcome], scene })
  }

  return result
}

type SceneReferenceValue = string | unknown[] | Record<string, unknown>

function replaceAt(
  value: unknown,
  path: readonly (string | number)[],
  next: string,
): SceneReferenceValue {
  const [key, ...rest] = path

  if (key === undefined) return next

  if (typeof key === 'number' && Array.isArray(value))
    return value.map((child, index) => (index === key ? replaceAt(child, rest, next) : child))
  const source = object(value)

  return { ...source, [key]: replaceAt(source[key], rest, next) }
}

export interface SceneEditResult {
  changedFiles: string[]
  createdFiles?: string[]
  removedFiles?: string[]
}

/** Scene identity and lifetime edits keep all validated scene references consistent. */
export function editSceneStructure(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    {
      type:
        | 'scene.rename'
        | 'scene.duplicate'
        | 'scene.remove'
        | 'game.setInitialScene'
        | 'scene.removeComponent'
    }
  >,
): SceneEditResult {
  const { sceneId } = command
  const file = `scenes/${sceneId}.json`

  if (!game.scenes.includes(sceneId))
    throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
  const source = object(documents[file])

  if (command.type === 'scene.removeComponent') {
    const components = sceneSchema.parse(source).components

    if (!components.some(({ id }) => id === command.componentId))
      throw new EditorError(404, 'component_not_found', 'Component does not exist')
    documents[file] = {
      ...source,
      components: (Array.isArray(source.components) ? source.components : []).filter(
        (entry) => object(entry).id !== command.componentId,
      ),
    }

    return { changedFiles: [file] }
  }

  const manifest = object(documents['game.json'])

  if (command.type === 'game.setInitialScene') {
    documents['game.json'] = { ...manifest, 'initial-scene': sceneId }

    return { changedFiles: ['game.json'] }
  }

  if (command.type === 'scene.rename' || command.type === 'scene.duplicate') {
    if (game.scenes.some((id) => id.toLowerCase() === command.newId.toLowerCase()))
      throw new EditorError(
        409,
        'scene_exists',
        'Choose an unused scene ID; case-only renames are not supported',
      )
    const destination = `scenes/${command.newId}.json`

    if (Object.hasOwn(documents, destination))
      throw new EditorError(409, 'scene_exists', 'Scene file already exists')
    const affected = new Set<string>()
    let copy: unknown = JSON.parse(JSON.stringify(source))

    for (const ref of references(documents, game)) {
      if (ref.scene !== sceneId) continue

      if (command.type === 'scene.duplicate') {
        if (ref.file === file) copy = replaceAt(copy, ref.path, command.newId)
      } else {
        documents[ref.file] = replaceAt(documents[ref.file], ref.path, command.newId)
        affected.add(ref.file)
      }
    }

    documents[destination] =
      command.type === 'scene.duplicate'
        ? { ...object(copy), id: command.newId, title: command.title, titleKey: undefined }
        : { ...object(documents[file]), id: command.newId }
    documents['game.json'] = {
      ...manifest,
      scenes:
        command.type === 'scene.duplicate'
          ? [...game.scenes, command.newId]
          : game.scenes.map((id) => (id === sceneId ? command.newId : id)),
      ...(command.type === 'scene.rename' && game['initial-scene'] === sceneId
        ? { 'initial-scene': command.newId }
        : {}),
    }
    affected.delete(file)

    if (command.type === 'scene.rename') delete documents[file]

    return {
      changedFiles: [
        destination,
        ...affected,
        'game.json',
        ...(command.type === 'scene.rename' ? [file] : []),
      ],
      createdFiles: [destination],
      removedFiles: command.type === 'scene.rename' ? [file] : [],
    }
  }

  if (game.scenes.length === 1)
    throw new EditorError(422, 'last_scene', 'Create another scene before deleting the last scene')
  const replacement = command.replacementScene

  if (replacement && (replacement === sceneId || !game.scenes.includes(replacement)))
    throw new EditorError(
      422,
      'invalid_replacement',
      'Choose a different, existing replacement scene',
    )

  const incoming = references(documents, game).filter(
    (ref) => ref.scene === sceneId && ref.file !== file,
  )

  if (incoming.length && !replacement)
    throw new EditorError(
      422,
      'scene_in_use',
      'Choose a replacement scene or update incoming links before deleting',
      incoming.map((ref) => ({
        code: 'scene_in_use',
        file: ref.file,
        path: ref.path,
        message: `References scene ${sceneId}`,
      })),
    )
  const affected = new Set<string>()

  for (const ref of incoming) {
    documents[ref.file] = replaceAt(documents[ref.file], ref.path, replacement!)
    affected.add(ref.file)
  }

  const remaining = game.scenes.filter((id) => id !== sceneId)
  documents['game.json'] = {
    ...manifest,
    scenes: remaining,
    ...(game['initial-scene'] === sceneId ? { 'initial-scene': replacement ?? remaining[0] } : {}),
  }
  delete documents[file]

  return { changedFiles: [...affected, 'game.json', file], removedFiles: [file] }
}
