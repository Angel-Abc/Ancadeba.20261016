import {
  cloneCombatRules,
  combatSimulationLoadoutSchema,
  combatStatNames,
  type CombatBonuses,
  type CombatDefinition,
} from '@ancadeba/schemas'
import { combatEquipmentFor, combatActorMoves } from './combatEquipment.js'
import type { CombatSimulationSetup } from './combatSimulation.js'

/** Rebuild grants and bonuses from current content; saved scenarios store item IDs, never copied effects. */
export function applyCombatSimulationLoadout(
  definition: CombatDefinition,
  setup: CombatSimulationSetup,
): CombatSimulationSetup {
  if (!setup.loadout || !Object.keys(setup.loadout).length) return setup
  const context = setup.equipmentContext

  if (!context) throw new Error('Simulation loadout requires inventory equipment context')
  const loadout = combatSimulationLoadoutSchema.parse(setup.loadout)
  const inventory = cloneCombatRules(context.inventory)
  const used = new Set<string>()

  for (const [id, slots] of Object.entries(loadout)) {
    const actor = [definition.player, ...definition.enemies].find((actor) => actor.id === id)
    const owner = actor?.equipmentOwner

    if (!owner || !inventory.owners[owner]?.combatStats)
      throw new Error(`Invalid loadout actor: ${id}`)

    for (const [slot, itemId] of Object.entries(slots)) {
      if (!Object.hasOwn(inventory.owners[owner]!.equipmentSlots, slot))
        throw new Error(`Unknown loadout slot: ${slot}`)

      if (itemId === null) continue
      const item = inventory.items[itemId]

      if (
        used.has(itemId) ||
        !item ||
        item.placement.type === 'inside' ||
        item.placement.owner !== owner ||
        !inventory.itemTypes[item.itemType]?.equipmentSlots.includes(slot)
      )
        throw new Error(`Invalid loadout item: ${itemId}`)
      used.add(itemId)
    }

    for (const item of Object.values(inventory.items))
      if (
        item.placement.type === 'equipped' &&
        item.placement.owner === owner &&
        Object.hasOwn(slots, item.placement.slot)
      )
        item.placement = { type: 'carried', owner }

    for (const itemId of Object.values(slots))
      if (itemId) inventory.items[itemId]!.placement = { type: 'carried', owner }

    for (const [slot, itemId] of Object.entries(slots))
      if (itemId) inventory.items[itemId]!.placement = { type: 'equipped', owner, slot }
  }

  const stats: Record<string, CombatBonuses> = cloneCombatRules(setup.stats ?? {})

  const maximumHealth = { ...setup.maximumHealth },
    health = { ...setup.health }

  for (const actor of [definition.player, ...definition.enemies]) {
    const base = context.baseStats[actor.id]

    if (!base || !actor.equipmentOwner) continue
    const total = { ...base }

    for (const stat of combatStatNames) {
      for (const item of Object.values(inventory.items))
        if (item.placement.type === 'equipped' && item.placement.owner === actor.equipmentOwner)
          total[stat] += inventory.itemTypes[item.itemType]?.combatBonuses?.[stat] ?? 0

      if (!Number.isSafeInteger(total[stat]) || total[stat] < (stat === 'maximumHealth' ? 1 : 0))
        throw new Error('Simulation loadout stat overflow')
    }

    stats[actor.id] = total
    maximumHealth[actor.id] = total.maximumHealth
  }

  const equipment = combatEquipmentFor(definition, inventory)

  return {
    ...setup,
    ...(setup.itemContext ? { itemContext: { ...setup.itemContext, inventory } } : {}),
    stats,
    maximumHealth,
    health,
    equipment,
    availableMoves: combatActorMoves(definition.player, equipment).filter(
      (id) =>
        !definition.player.leveling ||
        (definition.player.moveLevels?.[id] ?? 1) <= (context.level ?? 1),
    ),
  }
}
