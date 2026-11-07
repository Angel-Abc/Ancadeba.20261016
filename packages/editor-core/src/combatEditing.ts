import { combatFile, type CombatActorDefinition, type GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { object, EditorError } from './project.js'

export function editCombat(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    { type: 'game.upsertCombat' | 'game.removeCombat' | 'scene.setCombat' }
  >,
): string[] {
  const files: string[] = []

  if (command.type === 'game.removeCombat') {
    if (!game.combat?.includes(command.encounterId))
      throw new EditorError(404, 'combat_not_found', 'Encounter does not exist')
    documents['game.json'] = {
      ...object(documents['game.json']),
      combat: game.combat.filter((id) => id !== command.encounterId),
    }

    return ['game.json']
  }

  if (command.type === 'game.upsertCombat') {
    const definition = command.encounter
    const file = combatFile(definition.id)
    const previous = object(documents[file])

    if (!game.combat?.includes(definition.id) && Object.hasOwn(documents, file))
      throw new EditorError(409, 'combat_exists', 'An encounter file already exists')
    const oldEnemies = Array.isArray(previous.enemies) ? previous.enemies.map(object) : []

    const actor = (actor: CombatActorDefinition, old: Record<string, unknown>) => ({
      ...old,
      ...actor,
      labelKey: actor.labelKey,
      descriptionKey: actor.descriptionKey,
      portrait: actor.portrait,
      leveling: actor.leveling,
      moveLevels: actor.moveLevels ? { ...actor.moveLevels } : undefined,
      health: { ...object(old.health), ...actor.health, fallback: actor.health.fallback },
      maximumHealth:
        typeof actor.maximumHealth === 'object'
          ? {
              ...object(old.maximumHealth),
              ...actor.maximumHealth,
              fallback: actor.maximumHealth.fallback,
            }
          : actor.maximumHealth,
    })

    const oldRewardNumeric = object(previous.rewards).numeric
    const oldRewardDrops = object(previous.rewards).drops
    documents[file] = {
      ...previous,
      ...definition,
      labelKey: definition.labelKey,
      descriptionKey: definition.descriptionKey,
      player: actor(definition.player, object(previous.player)),
      enemies: definition.enemies.map((entry) =>
        actor(entry, oldEnemies.find((old) => old.id === entry.id) ?? {}),
      ),
      moves: Object.fromEntries(
        Object.entries(definition.moves).map(([id, move]) => {
          const old = object(object(previous.moves)[id])

          return [
            id,
            {
              ...old,
              ...move,
              labelKey: move.labelKey,
              descriptionKey: move.descriptionKey,
              damage:
                move.type === 'attack' ? { ...object(old.damage), ...move.damage } : undefined,
              guard: move.type === 'guard' ? move.guard : undefined,
            },
          ]
        }),
      ),
      rewards: definition.rewards
        ? {
            ...object(previous.rewards),
            ...definition.rewards,
            lootOwner: definition.rewards.lootOwner,
            numeric: definition.rewards.numeric.map((entry) => {
              const old =
                (Array.isArray(oldRewardNumeric) ? oldRewardNumeric : [])
                  .map(object)
                  .find((value) => value.id === entry.id) ?? {}

              return {
                ...old,
                ...entry,
                labelKey: entry.labelKey,
                field: { ...object(old.field), ...entry.field, fallback: entry.field.fallback },
              }
            }),
            drops: definition.rewards.drops.map((entry) => {
              const old =
                (Array.isArray(oldRewardDrops) ? oldRewardDrops : [])
                  .map(object)
                  .find((value) => value.id === entry.id) ?? {}

              return { ...old, ...entry, colors: { ...entry.colors } }
            }),
          }
        : undefined,
      messages: { ...object(previous.messages), ...definition.messages },
      messageKeys: { ...definition.messageKeys },
      outcomes: {
        ...object(previous.outcomes),
        ...definition.outcomes,
        victory: definition.outcomes.victory,
        defeat: definition.outcomes.defeat,
        escaped: definition.outcomes.escaped,
      },
    }
    files.push(file)

    if (!game.combat?.includes(definition.id)) {
      documents['game.json'] = {
        ...object(documents['game.json']),
        combat: [...(game.combat ?? []), definition.id],
      }
      files.push('game.json')
    }
  }

  const sceneId = command.type === 'scene.setCombat' ? command.sceneId : command.scene?.id

  const component =
    command.type === 'scene.setCombat' ? command.component : command.scene?.component

  if (sceneId && component !== undefined) {
    const file = `scenes/${sceneId}.json`
    const scene = object(documents[file])

    if (!game.scenes.includes(sceneId) || scene.type !== 'game')
      throw new EditorError(422, 'invalid_combat_scene', 'Select a game scene')
    const components = Array.isArray(scene.components) ? [...scene.components] : []
    const index = components.findIndex((entry) => object(entry).type === 'combat')

    if (!component) {
      if (index >= 0) components.splice(index, 1)
    } else {
      if (
        components.some(
          (entry, position) => position !== index && object(entry).id === component.id,
        )
      )
        throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')
      const old = object(components[index])

      const next = {
        ...old,
        ...component,
        textTarget: component.textTarget,
        lootInventory: component.lootInventory,
        placement: { ...object(old.placement), ...component.placement },
      }

      if (index < 0) components.push(next)
      else components[index] = next
    }

    documents[file] = { ...scene, components }
    files.push(file)
  }

  return files
}
