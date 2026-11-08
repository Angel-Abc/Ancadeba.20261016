import { levelingFile, type GameDefinition, type LevelingProfile } from '@ancadeba/schemas'
import { object, EditorError } from './project.js'
import type { EditorCommand } from './commands.js'

export function editLeveling(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    {
      type:
        | 'game.upsertLeveling'
        | 'game.removeLeveling'
        | 'scene.upsertLevelingView'
        | 'scene.removeLevelingView'
    }
  >,
): string[] {
  const files: string[] = []

  if (command.type === 'game.removeLeveling') {
    if (!game.leveling?.includes(command.profileId))
      throw new EditorError(404, 'leveling_not_found', 'Unknown leveling profile')
    documents['game.json'] = {
      ...object(documents['game.json']),
      leveling: game.leveling.filter((id) => id !== command.profileId),
    }

    const file = levelingFile(command.profileId)
    delete documents[file]

    return ['game.json', file]
  }

  if (command.type === 'game.upsertLeveling') {
    const file = levelingFile(command.profile.id)

    if (!game.leveling?.includes(command.profile.id) && Object.hasOwn(documents, file))
      throw new EditorError(409, 'leveling_exists', 'A profile file already exists')
    const previous = object(documents[file])
    const oldLevels = Array.isArray(previous.levels) ? previous.levels.map(object) : []

    const field = (next: LevelingProfile['xp'], old: unknown) => ({
      ...object(old),
      ...next,
      fallback: next.fallback,
    })

    documents[file] = {
      ...previous,
      ...command.profile,
      labelKey: command.profile.labelKey,
      xp: field(command.profile.xp, previous.xp),
      level: field(command.profile.level, previous.level),
      health: command.profile.health
        ? {
            ...object(previous.health),
            ...command.profile.health,
            current: field(command.profile.health.current, object(previous.health).current),
            maximum: field(command.profile.health.maximum, object(previous.health).maximum),
          }
        : undefined,
      levels: command.profile.levels.map((level, index) => {
        const old = oldLevels.find((value) => value.xp === level.xp) ?? oldLevels[index] ?? {}
        const oldGains = Array.isArray(old.gains) ? old.gains.map(object) : []

        return {
          ...old,
          ...level,
          gains: level.gains.map((gain) => {
            const old = oldGains.find((value) => value.id === gain.id) ?? {}

            return { ...old, ...gain, labelKey: gain.labelKey, field: field(gain.field, old.field) }
          }),
        }
      }),
      messages: { ...object(previous.messages), ...command.profile.messages },
      messageKeys: { ...command.profile.messageKeys },
    }
    files.push(file)

    if (!game.leveling?.includes(command.profile.id)) {
      documents['game.json'] = {
        ...object(documents['game.json']),
        leveling: [...(game.leveling ?? []), command.profile.id],
      }
      files.push('game.json')
    }
  }

  const sceneId = command.type === 'game.upsertLeveling' ? command.scene?.id : command.sceneId

  const component =
    command.type === 'game.upsertLeveling'
      ? command.scene?.component
      : command.type === 'scene.upsertLevelingView'
        ? command.component
        : undefined

  if (!sceneId) return files
  const file = `scenes/${sceneId}.json`
  const scene = object(documents[file])

  if (!game.scenes.includes(sceneId) || scene.type !== 'game')
    throw new EditorError(422, 'invalid_leveling_scene', 'Choose a game scene')
  const components = Array.isArray(scene.components) ? [...scene.components] : []
  const id = command.type === 'scene.removeLevelingView' ? command.componentId : component?.id
  const index = components.findIndex((value) => object(value).id === id)

  if (index >= 0 && object(components[index]).type !== 'character-progression')
    throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

  if (command.type === 'scene.removeLevelingView') {
    if (index >= 0) components.splice(index, 1)
  } else if (component) {
    const old = object(components[index])

    const next = {
      ...old,
      ...component,
      textTarget: component.textTarget,
      placement: { ...object(old.placement), ...component.placement },
    }

    if (index >= 0) components[index] = next
    else components.push(next)
  }

  documents[file] = { ...scene, components }
  files.push(file)

  return files
}
