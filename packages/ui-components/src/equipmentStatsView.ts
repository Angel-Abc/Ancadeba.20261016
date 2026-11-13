import { combatStatNames, type EquipmentComponentDefinition } from '@ancadeba/schemas'
import type { SceneInstance } from '@ancadeba/game-runtime'
import { equipmentCombatEffectsText } from './equipmentCombatEffectsText.js'

/** Semantic markup inherits the game's existing styles. */
export function equipmentStatsView(
  document: Document,
  scene: SceneInstance,
  component: EquipmentComponentDefinition,
): HTMLElement {
  const root = document.createElement('section')
  root.className = 'ancadeba-equipment-stats'

  if (scene.type !== 'game') return root
  const profile = scene.game.data.inventory?.owners[component.owner]?.combatStats
  const stats = scene.game.combatStats

  if (!profile || !stats) return root
  const snapshot = stats.snapshot(component.owner)
  const issue = stats.reason(component.owner)

  if (issue) {
    const message = document.createElement('p')
    message.textContent = issue
    message.setAttribute('role', 'status')
    root.append(message)
  }

  if (!snapshot) return root
  const list = document.createElement('dl')

  for (const stat of combatStatNames) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = profile.messages[stat]
    value.textContent = `${profile.messages.base}: ${snapshot.base[stat]} · ${profile.messages.equipment}: +${snapshot.equipment[stat]} · ${profile.messages.total}: ${snapshot.total[stat]}`
    list.append(label, value)
  }

  for (const contribution of snapshot.contributions) {
    const item = scene.game.inventory?.snapshot.find((item) => item.id === contribution.item)

    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = item
      ? (scene.game.data.inventory?.itemTypes[item.itemType]?.label ?? contribution.item)
      : contribution.item
    value.textContent = combatStatNames
      .filter((stat) => contribution.bonuses[stat])
      .map((stat) => `${profile.messages[stat]} +${contribution.bonuses[stat]}`)
      .join(' · ')

    if (value.textContent) list.append(label, value)
  }

  for (const contribution of snapshot.temporary) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = `${profile.messages.temporary}: ${contribution.label}`
    value.textContent = (['attack', 'defense', 'guard'] as const)
      .filter((stat) => contribution.modifiers[stat])
      .map(
        (stat) =>
          `${profile.messages[stat]} ${(contribution.modifiers[stat] ?? 0) >= 0 ? '+' : ''}${contribution.modifiers[stat]}`,
      )
      .join(' · ')

    const percentages = (['attack', 'defense', 'guard'] as const)
      .filter((stat) => contribution.percentModifiers?.[stat])
      .map(
        (stat) =>
          `${profile.messages[stat]} ${(contribution.percentModifiers?.[stat] ?? 0) >= 0 ? '+' : ''}${contribution.percentModifiers?.[stat]}%`,
      )
      .join(' · ')

    value.textContent = [value.textContent, percentages].filter(Boolean).join(' · ')
    list.append(label, value)
  }

  const effectsText = (entries: typeof snapshot.equipmentEffects) =>
    (entries ?? [])
      .map(
        (entry) =>
          `${entry.label}: ${equipmentCombatEffectsText(
            entry.effects,
            profile.messages,
            (reference) =>
              scene.game.data.combatLibraries?.get(reference.library)?.moves[reference.id]?.label ??
              reference.id,
            (reference) =>
              scene.game.data.combatLibraries?.get(reference.library)?.passives?.[reference.id]
                ?.label ?? reference.id,
          )}`,
      )
      .join('\n') || profile.messages.noEquipmentEffects

  if (snapshot.equipmentEffects?.length) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = profile.messages.equipmentEffects
    value.textContent = effectsText(snapshot.equipmentEffects)
    list.append(label, value)
  }

  root.append(list)
  const selection = scene.game.equipment?.get(scene, component.id)

  if (!selection?.item) return root
  const comparison = stats.compare(component.owner, selection.item, selection.slot)
  const heading = document.createElement('h3')
  heading.textContent = profile.messages.comparison
  root.append(heading)

  if (!comparison) {
    const hint = document.createElement('p')
    hint.textContent = profile.messages.chooseSlot
    root.append(hint)

    return root
  }

  const changes = document.createElement('dl')

  for (const stat of combatStatNames) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = profile.messages[stat]
    value.textContent = `${comparison.current.total[stat]} → ${comparison.proposed.total[stat]} (${comparison.delta[stat] >= 0 ? '+' : ''}${comparison.delta[stat]})`
    changes.append(label, value)
  }

  if (comparison.current.health !== comparison.proposed.health) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = profile.messages.currentHealth
    value.textContent = `${comparison.current.health} → ${comparison.proposed.health}`
    changes.append(label, value)
  }

  root.append(changes)

  if (comparison.current.equipmentEffects?.length || comparison.proposed.equipmentEffects?.length) {
    const label = document.createElement('dt'),
      value = document.createElement('dd')

    label.textContent = profile.messages.equipmentEffects
    value.textContent = `${effectsText(comparison.current.equipmentEffects)} → ${effectsText(comparison.proposed.equipmentEffects)}`
    changes.append(label, value)
  }

  if (comparison.issue && comparison.issue !== issue) {
    const message = document.createElement('p')
    message.textContent = comparison.issue
    root.append(message)
  }

  return root
}
