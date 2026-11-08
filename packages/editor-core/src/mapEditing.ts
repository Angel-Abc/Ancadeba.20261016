import { mapFile, type GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

interface MapEditResult {
  changedFiles: string[]
  createdFiles?: string[]
}

export function editMap(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'game.upsertMap' | 'game.removeMap' }>,
): MapEditResult {
  const file = mapFile(command.mapId)
  const exists = game.maps?.includes(command.mapId) === true

  if (command.type === 'game.removeMap') {
    if (!exists) throw new EditorError(404, 'map_not_found', 'Map does not exist')
    documents['game.json'] = {
      ...object(documents['game.json']),
      maps: game.maps?.filter((id) => id !== command.mapId),
    }
    delete documents[file]

    return { changedFiles: ['game.json', file] }
  }

  if (command.createOnly && exists)
    throw new EditorError(409, 'map_exists', 'Map ID already exists')

  if (
    !exists &&
    (game.maps?.some((id) => id.toLowerCase() === command.mapId.toLowerCase()) ||
      Object.hasOwn(documents, file))
  )
    throw new EditorError(409, 'map_exists', 'Choose an unused map ID')
  const previous = object(documents[file])
  const terrain = object(previous.terrain)
  documents[file] = {
    ...previous,
    ...command.map,
    tilesets: command.map.tilesets,
    layers: command.map.layers?.map((layer) => ({
      ...object(
        Array.isArray(previous.layers)
          ? previous.layers.find((value) => object(value).id === layer.id)
          : undefined,
      ),
      ...layer,
      name: layer.name,
      visible: layer.visible,
      collision: layer.collision,
    })),
    terrain: Object.fromEntries(
      Object.entries(command.map.terrain).map(([id, definition]) => [
        id,
        {
          ...object(terrain[id]),
          ...definition,
          color: definition.color,
          tile: definition.tile,
          walkable: definition.walkable,
          movementCostMs: definition.movementCostMs,
        },
      ]),
    ),
  }

  if (exists) return { changedFiles: [file] }
  documents['game.json'] = {
    ...object(documents['game.json']),
    maps: [...(game.maps ?? []), command.mapId],
  }

  return { changedFiles: [file, 'game.json'], createdFiles: [file] }
}
