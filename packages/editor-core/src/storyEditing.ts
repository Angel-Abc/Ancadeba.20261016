import type { GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

const known = new Set([
  'schema-version',
  'id',
  'label',
  'labelKey',
  'description',
  'descriptionKey',
  'entry',
  'nodes',
  'transcriptCapacity',
  'messages',
  'messageKeys',
  'lines',
  'choices',
  'terminal',
  'speaker',
  'text',
  'bindings',
  'visibleWhen',
  'when',
  'unavailableText',
  'effects',
  'next',
  'end',
  'scene',
  'type',
  'path',
  'value',
  'textKey',
  'quest',
  'turnInWhen',
  'stages',
  'objectives',
  'progress',
  'binding',
  'target',
  'handIns',
  'item',
  'owner',
  'operation',
  'recipient',
  'rewards',
  'numeric',
  'items',
  'field',
  'amount',
  'itemType',
  'colors',
  'source',
  'fallback',
  'operator',
  'encounter',
  'outcome',
  'status',
  'stage',
])

/** Keep extension data at stable IDs while dropping removed authored entries and optional fields. */
type StoryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StoryValue[]
  | Record<string, unknown>

function mergeStory(previous: unknown, next: unknown, key = ''): StoryValue {
  if (Array.isArray(next)) {
    const before = Array.isArray(previous) ? previous : []

    return next.map((entry, index) => {
      const id = object(entry).id ?? object(entry).item

      return mergeStory(
        id === undefined
          ? before[index]
          : before.find((candidate) => (object(candidate).id ?? object(candidate).item) === id),
        entry,
      )
    })
  }

  if (
    next === null ||
    next === undefined ||
    typeof next === 'string' ||
    typeof next === 'number' ||
    typeof next === 'boolean'
  )
    return next

  if (typeof next !== 'object') return
  const before = object(previous)

  const extensions = ['nodes', 'colors', 'bindings', 'messages', 'messageKeys'].includes(key)
    ? {}
    : Object.fromEntries(Object.entries(before).filter(([name]) => !known.has(name)))

  return {
    ...extensions,
    ...Object.fromEntries(
      Object.entries(next).map(([name, value]) => [name, mergeStory(before[name], value, name)]),
    ),
  }
}

export function editStory(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    {
      type: 'game.upsertDialogue' | 'game.removeDialogue' | 'game.upsertQuest' | 'game.removeQuest'
    }
  >,
): string[] {
  const dialogue = command.type === 'game.upsertDialogue' || command.type === 'game.removeDialogue'
  const key = dialogue ? 'dialogues' : 'quests'

  const definition =
    command.type === 'game.upsertDialogue'
      ? command.dialogue
      : command.type === 'game.upsertQuest'
        ? command.quest
        : undefined

  const id =
    definition?.id ??
    ('dialogueId' in command ? command.dialogueId : 'questId' in command ? command.questId : '')

  const file = `${key}/${id}.json`

  if (!definition) {
    if (!game[key]?.includes(id))
      throw new EditorError(404, 'story_not_found', 'Definition does not exist')
    documents['game.json'] = {
      ...object(documents['game.json']),
      [key]: game[key]?.filter((entry) => entry !== id),
    }

    delete documents[file]

    return ['game.json', file]
  }

  if (!game[key]?.includes(id) && Object.hasOwn(documents, file))
    throw new EditorError(409, 'story_exists', 'A definition file already exists')
  documents[file] = mergeStory(documents[file], definition)

  if (game[key]?.includes(id)) return [file]
  documents['game.json'] = { ...object(documents['game.json']), [key]: [...(game[key] ?? []), id] }

  return [file, 'game.json']
}
