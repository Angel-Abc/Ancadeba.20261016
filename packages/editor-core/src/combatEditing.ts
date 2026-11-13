import { mergeCombatDamageDefenses } from './combatDamageEditing.js'
import { mergeCombatEntries } from './combatEntryEditing.js'
import { mergeCombatEnemyAI } from './combatEnemyAIEditing.js'
import { mergeCombatMechanics } from './combatMechanicsEditing.js'
import { mergeCombatMechanicsOverrides } from './combatRulesetEditing.js'
import { combatFile, type CombatActorSource, type GameDefinition } from '@ancadeba/schemas'
import { mergeCombatAIOverrides } from './combatAIProfileEditing.js'
import { mergeCombatScenarios } from './combatScenarioEditing.js'
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

    const file = combatFile(command.encounterId)
    delete documents[file]

    return ['game.json', file]
  }

  if (command.type === 'game.upsertCombat') {
    const definition = command.encounter
    const file = combatFile(definition.id)
    const previous = object(documents[file])

    if (
      Object.keys(object(previous.simulationScenarios)).length &&
      definition.simulationScenarios === undefined
    )
      throw new EditorError(
        422,
        'simulation_scenarios_required',
        'Include simulationScenarios explicitly when saving an encounter that contains them',
      )

    if (previous.ruleset && definition.ruleset === undefined && definition.rulesets === undefined)
      throw new EditorError(
        422,
        'ruleset_reference_required',
        'Include ruleset explicitly when saving a linked encounter; use null to detach',
      )

    if (
      Array.isArray(previous.rulesets) &&
      previous.rulesets.length &&
      definition.rulesets === undefined &&
      definition.ruleset === undefined
    )
      throw new EditorError(
        422,
        'ruleset_reference_required',
        'Include rulesets explicitly when saving a composed encounter; use an empty array to detach',
      )

    if (
      Object.keys(object(previous.mechanicsOverrides)).length &&
      (definition.ruleset || definition.rulesets?.length) &&
      definition.mechanicsOverrides === undefined
    )
      throw new EditorError(
        422,
        'mechanics_overrides_required',
        'Include mechanicsOverrides explicitly when saving local changes; use an empty object to reset',
      )

    if (
      command.createOnly &&
      (game.combat ?? []).some((id) => id.toLowerCase() === definition.id.toLowerCase())
    )
      throw new EditorError(409, 'combat_exists', 'An encounter with this ID already exists')

    if (!game.combat?.includes(definition.id) && Object.hasOwn(documents, file))
      throw new EditorError(409, 'combat_exists', 'An encounter file already exists')

    for (const key of ['sharedMoves', 'sharedStatuses'] as const)
      if (Array.isArray(previous[key]) && previous[key].length && definition[key] === undefined)
        throw new EditorError(
          422,
          'shared_references_required',
          `Include ${key} explicitly when saving an encounter with imports`,
        )

    const oldReferences = (key: string, library: string, id: string) =>
      (Array.isArray(previous[key]) ? previous[key] : [])
        .map(object)
        .find((entry) => entry.library === library && entry.id === id)

    const oldEnemies = Array.isArray(previous.enemies) ? previous.enemies.map(object) : []

    const actor = (actor: CombatActorSource, old: Record<string, unknown>) => {
      if (old.aiProfile && actor.aiProfile === undefined)
        throw new EditorError(
          422,
          'ai_profile_required',
          'Include aiProfile explicitly when saving a linked enemy; use null to detach',
        )

      if (
        Object.keys(object(old.aiOverrides)).length &&
        actor.aiProfile &&
        actor.aiOverrides === undefined
      )
        throw new EditorError(
          422,
          'ai_overrides_required',
          'Include aiOverrides explicitly when saving local AI changes; use an empty object to reset',
        )

      return {
        ...old,
        ...actor,
        equipmentMoves: undefined,
        labelKey: actor.labelKey,
        descriptionKey: actor.descriptionKey,
        portrait: actor.portrait,
        damageDefenses: mergeCombatDamageDefenses(old.damageDefenses, actor.damageDefenses),
        statusImmunities: actor.statusImmunities ? [...actor.statusImmunities] : undefined,
        blockedMoveCategories: actor.blockedMoveCategories
          ? [...actor.blockedMoveCategories]
          : undefined,
        equipmentOwner: actor.equipmentOwner,
        leveling: actor.leveling,
        moveLevels: actor.moveLevels ? { ...actor.moveLevels } : undefined,
        ai: mergeCombatEnemyAI(old.ai, actor.ai),
        aiProfile: actor.aiProfile
          ? {
              ...object(old.aiProfile),
              ...actor.aiProfile,
              actors: actor.aiProfile.actors ? { ...actor.aiProfile.actors } : undefined,
            }
          : undefined,
        aiOverrides: mergeCombatAIOverrides(old.aiOverrides, actor.aiOverrides),
        health: { ...object(old.health), ...actor.health, fallback: actor.health.fallback },
        maximumHealth:
          typeof actor.maximumHealth === 'object'
            ? {
                ...object(old.maximumHealth),
                ...actor.maximumHealth,
                fallback: actor.maximumHealth.fallback,
              }
            : actor.maximumHealth,
      }
    }

    const oldRewardNumeric = object(previous.rewards).numeric
    const oldRewardDrops = object(previous.rewards).drops
    documents[file] = {
      ...previous,
      ...definition,
      passiveDefinitions: undefined,
      labelKey: definition.labelKey,
      descriptionKey: definition.descriptionKey,
      player: actor(definition.player, object(previous.player)),
      enemies: definition.enemies.map((entry) =>
        actor(entry, oldEnemies.find((old) => old.id === entry.id) ?? {}),
      ),
      ...mergeCombatEntries(previous, definition),
      simulationScenarios: mergeCombatScenarios(
        previous.simulationScenarios,
        definition.simulationScenarios,
      ),
      mechanics: mergeCombatMechanics(previous.mechanics, definition.mechanics),
      ruleset: definition.ruleset
        ? {
            ...object(previous.ruleset),
            ...definition.ruleset,
            actors: definition.ruleset.actors ? { ...definition.ruleset.actors } : undefined,
          }
        : undefined,
      rulesets: definition.rulesets?.map((reference) => ({
        ...oldReferences('rulesets', reference.library, reference.id),
        ...(object(previous.ruleset).library === reference.library &&
        object(previous.ruleset).id === reference.id
          ? object(previous.ruleset)
          : {}),
        ...reference,
        actors: reference.actors ? { ...reference.actors } : undefined,
        collision: reference.collision,
      })),
      mechanicsOverrides: mergeCombatMechanicsOverrides(
        previous.mechanicsOverrides,
        definition.mechanicsOverrides,
      ),
      itemUse: definition.itemUse
        ? { ...object(previous.itemUse), ...definition.itemUse }
        : undefined,
      sharedMoves: definition.sharedMoves?.map((ref) => ({
        ...oldReferences('sharedMoves', ref.library, ref.id),
        ...ref,
      })),
      sharedStatuses: definition.sharedStatuses?.map((ref) => ({
        ...oldReferences('sharedStatuses', ref.library, ref.id),
        ...ref,
      })),
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
