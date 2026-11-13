import { combatEquipmentFor, combatActorMoves } from './combatEquipment.js'
import {
  combatStatNames,
  type CombatDefinition,
  type CombatBonuses,
  type InventoryDefinition,
  type GameBindingDefinition,
} from '@ancadeba/schemas'
import type { CombatSimulationSetup } from './combatSimulation.js'

/** Resolve starting fields and equipped bonuses through an injected binding reader. */
export function combatSimulationSetup(
  definition: CombatDefinition,
  read: (binding: GameBindingDefinition) => unknown,
  inventory?: InventoryDefinition,
  level?: number,
): CombatSimulationSetup {
  const health: Record<string, number> = {}
  const maximumHealth: Record<string, number> = {}
  const stats: Record<string, CombatBonuses> = {}
  const baseStats: Record<string, CombatBonuses> = {}

  const number = (source: number | GameBindingDefinition) => {
    const value = typeof source === 'number' ? source : read(source)

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error('Simulation requires resolved nonnegative integer bindings')

    return value
  }

  for (const actor of [definition.player, ...definition.enemies]) {
    health[actor.id] = number(actor.health)

    const profile = actor.equipmentOwner
      ? inventory?.owners[actor.equipmentOwner]?.combatStats
      : undefined

    if (actor.equipmentOwner && !profile)
      throw new Error(`Missing equipment profile: ${actor.equipmentOwner}`)

    if (profile) {
      if (JSON.stringify(profile.health.path) !== JSON.stringify(actor.health.path))
        throw new Error(`Equipment health binding differs: ${actor.id}`)
      const total: CombatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 0 }
      const base: CombatBonuses = { ...total }

      for (const stat of combatStatNames) {
        total[stat] = number(profile[stat])
        base[stat] = total[stat]

        for (const item of Object.values(inventory?.items ?? {}))
          if (item.placement.type === 'equipped' && item.placement.owner === actor.equipmentOwner)
            total[stat] += inventory?.itemTypes[item.itemType]?.combatBonuses?.[stat] ?? 0

        if (!Number.isSafeInteger(total[stat]))
          throw new Error('Simulation equipment stat overflow')
      }

      stats[actor.id] = total
      baseStats[actor.id] = base
      maximumHealth[actor.id] = total.maximumHealth
    } else maximumHealth[actor.id] = number(actor.maximumHealth)
  }

  if (definition.player.leveling && (!Number.isSafeInteger(level) || level! < 1))
    throw new Error('Simulation requires a resolved character level')

  const equipment = combatEquipmentFor(definition, inventory)

  return {
    ...(inventory && Object.keys(baseStats).length
      ? { equipmentContext: { inventory, baseStats, level } }
      : {}),
    ...(Object.keys(equipment).length ? { equipment } : {}),
    health,
    maximumHealth,
    stats,
    availableMoves: combatActorMoves(definition.player, equipment).filter(
      (id) => !definition.player.leveling || (definition.player.moveLevels?.[id] ?? 1) <= level!,
    ),
  }
}
