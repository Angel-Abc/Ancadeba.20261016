import type { InventoryDefinition } from './inventory.js'
import type { CombatLibrary } from './combatLibraries.js'
import type { CombatDefinition } from './combat.js'
import type { GameRulesDefinition } from './rules.js'

export function itemUseIssues(
  inventory: InventoryDefinition | undefined,
  libraries: ReadonlyMap<string, CombatLibrary>,
  rules?: GameRulesDefinition,
) {
  const issues: { path: (string | number)[]; message: string }[] = []

  const passive = (reference: { library: string; id: string }, path: (string | number)[]) => {
    if (!libraries.get(reference.library)?.passives?.[reference.id])
      issues.push({ path, message: `Missing shared passive: ${reference.library}/${reference.id}` })
  }

  for (const [library, data] of libraries)
    for (const [id, status] of Object.entries(data.statuses))
      for (const [index, reference] of (status.passives ?? []).entries())
        passive(reference, ['combatLibraries', library, 'statuses', id, 'passives', index])

  for (const [id, item] of Object.entries(inventory?.itemTypes ?? {})) {
    for (const [index, reference] of (item.combatEffects?.passives ?? []).entries())
      passive(reference, ['itemTypes', id, 'combatEffects', 'passives', index])

    for (const [index, reference] of (item.combatEffects?.grantedMoves ?? []).entries())
      if (!libraries.get(reference.library)?.moves[reference.id])
        issues.push({
          path: ['itemTypes', id, 'combatEffects', 'grantedMoves', index],
          message: `Equipment requires an existing shared move: ${reference.library}/${reference.id}`,
        })
    const use = item.use

    if (!use) continue
    const ability = libraries.get(use.ability.library)?.moves[use.ability.id]

    if (!ability || ability.type !== 'ability')
      issues.push({
        path: ['itemTypes', id, 'use', 'ability'],
        message: `Item use requires a shared ability: ${use.ability.library}/${use.ability.id}`,
      })
    else if (
      use.contexts.includes('outside-combat') &&
      (ability.target !== 'self' ||
        Boolean(ability.apCostScaling) ||
        Boolean(ability.requirements?.length) ||
        ability.effects.some(
          (effect) =>
            effect.type !== 'heal' || Boolean(effect.conditions?.length) || Boolean(effect.scaling),
        ) ||
        Object.keys(ability.resourceCosts ?? {}).length > 0)
    )
      issues.push({
        path: ['itemTypes', id, 'use', 'contexts'],
        message:
          'Outside-combat use requires fixed, unconditional self-targeted healing-only abilities without action requirements or encounter resource costs',
      })

    if (
      use.enabledWhen?.source === 'game.state' &&
      !rules?.state.some(
        (field) =>
          JSON.stringify(field.path) === JSON.stringify(use.enabledWhen?.path) &&
          typeof field.value === 'boolean',
      )
    )
      issues.push({
        path: ['itemTypes', id, 'use', 'enabledWhen'],
        message: 'Item enablement requires a declared boolean field',
      })
  }

  return issues
}

export function combatItemUseIssues(combat: CombatDefinition, inventory?: InventoryDefinition) {
  const issues: { path: (string | number)[]; message: string }[] = []

  if (!combat.itemUse) return issues
  const owner = inventory?.owners[combat.itemUse.owner]

  if (!owner) issues.push({ path: ['itemUse', 'owner'], message: 'Unknown item-use owner' })
  else if (
    (owner.combatStats || combat.player.equipmentOwner) &&
    combat.player.equipmentOwner !== combat.itemUse.owner
  )
    issues.push({
      path: ['itemUse', 'owner'],
      message: 'Item-use owner must match the player equipment stat owner',
    })

  return issues
}
