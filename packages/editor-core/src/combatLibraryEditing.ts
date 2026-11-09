import {
  combatFile,
  combatLibraryFile,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  moveStatusIds,
  inventorySchema,
  inventoryFile,
  mergeInventorySources,
  type GameDefinition,
} from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'
import { mergeCombatEntries } from './combatEntryEditing.js'

function copyEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyEntry)

  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyEntry(entry)]))

  return value
}

export function editCombatLibrary(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    { type: 'game.upsertCombatLibrary' | 'game.removeCombatLibrary' | 'combat.copySharedEntry' }
  >,
): string[] {
  if (command.type === 'game.removeCombatLibrary') {
    if (!game.combatLibraries?.includes(command.libraryId))
      throw new EditorError(404, 'combat_library_not_found', 'Library does not exist')
    documents['game.json'] = {
      ...object(documents['game.json']),
      combatLibraries: game.combatLibraries.filter((id) => id !== command.libraryId),
    }

    const file = combatLibraryFile(command.libraryId)
    delete documents[file]

    return ['game.json', file]
  }

  if (command.type === 'game.upsertCombatLibrary') {
    const library = command.library
    const file = combatLibraryFile(library.id)
    const previous = object(documents[file])

    if (
      command.createOnly &&
      (game.combatLibraries ?? []).some((id) => id.toLowerCase() === library.id.toLowerCase())
    )
      throw new EditorError(409, 'combat_library_exists', 'A library with this ID already exists')

    if (!game.combatLibraries?.includes(library.id) && Object.hasOwn(documents, file))
      throw new EditorError(409, 'combat_library_exists', 'A library file already exists')
    documents[file] = { ...previous, ...library, ...mergeCombatEntries(previous, library) }

    if (game.combatLibraries?.includes(library.id)) return [file]
    documents['game.json'] = {
      ...object(documents['game.json']),
      combatLibraries: [...(game.combatLibraries ?? []), library.id],
    }

    return [file, 'game.json']
  }

  const file = combatFile(command.encounterId)

  if (!game.combat?.includes(command.encounterId))
    throw new EditorError(404, 'combat_not_found', 'Encounter does not exist')
  const source = combatSourceSchema.parse(documents[file])

  const libraries = new Map(
    (game.combatLibraries ?? []).map((id) => [
      id,
      combatLibrarySchema.parse(documents[combatLibraryFile(id)]),
    ]),
  )

  const { inventory } = mergeInventorySources(
    (game.inventory ?? []).map((id) => ({
      file: inventoryFile(id),
      inventory: inventorySchema.parse(documents[inventoryFile(id)]),
    })),
  )

  const resolved = resolveCombatSource(source, libraries, undefined, inventory)
  const { library, id } = command.reference
  const origin = libraries.get(library)?.[command.kind][id]

  if (!origin)
    throw new EditorError(404, 'combat_entry_not_found', 'Shared definition does not exist')

  if (command.localId === id || Object.hasOwn(resolved.origins[command.kind], command.localId))
    throw new EditorError(422, 'combat_id_in_use', 'Choose a distinct unused local ID')
  const raw = object(documents[combatLibraryFile(library)])
  const previous = object(documents[file])

  const next = {
    ...previous,
    [command.kind]: {
      ...object(previous[command.kind]),
      [command.localId]: copyEntry(object(raw[command.kind])[id]),
    },
  }

  if (command.kind === 'moves') {
    const move = libraries.get(library)!.moves[id]!

    const rawReferences = Array.isArray(previous.sharedStatuses)
      ? previous.sharedStatuses.map(object)
      : []

    const sharedStatuses = (source.sharedStatuses ?? []).map((ref) => ({
      ...rawReferences.find((entry) => entry.library === ref.library && entry.id === ref.id),
      ...ref,
    }))

    for (const status of moveStatusIds(move))
      if (!sharedStatuses.some((ref) => ref.library === library && ref.id === status))
        sharedStatuses.push({ library, id: status })
    documents[file] = { ...next, sharedStatuses }
  } else documents[file] = next

  return [file]
}
