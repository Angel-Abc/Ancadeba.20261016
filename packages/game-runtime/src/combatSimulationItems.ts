import { inventoryOwner, type CombatDefinition, type InventoryDefinition } from '@ancadeba/schemas'

export interface CombatSimulationItemContext {
  readonly inventory: InventoryDefinition
  readonly enabled?: Readonly<Record<string, boolean>> | undefined
}

/** Uses authored item identities and current simulated loadout; no real inventory adapter is mutated. */
export function combatSimulationItem(
  definition: CombatDefinition,
  context: CombatSimulationItemContext | undefined,
  id: string,
) {
  const inventory = context?.inventory,
    item = inventory?.items[id]

  const use = item && inventory?.itemTypes[item.itemType]?.use

  const reason =
    !item || !use
      ? 'Unknown usable simulation item'
      : !definition.itemUse?.itemTypes.includes(item.itemType) || !use.contexts.includes('combat')
        ? 'Item is not enabled for this encounter'
        : inventoryOwner(new Map(Object.entries(inventory!.items)), id) !== definition.itemUse.owner
          ? 'Item does not belong to the combat player'
          : item.placement.type === 'equipped'
            ? 'Unequip the item before using it'
            : Object.values(inventory!.items).some(
                  (other) => other.placement.type === 'inside' && other.placement.container === id,
                )
              ? 'Empty the container before using it'
              : use.enabledWhen && context?.enabled?.[item.itemType] !== true
                ? 'Item is disabled by its starting binding'
                : !definition.moves[use.ability.id] ||
                    definition.moves[use.ability.id]?.type !== 'ability'
                  ? 'Item ability is unavailable'
                  : undefined

  return { item, use, reason }
}
