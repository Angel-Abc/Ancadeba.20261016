import {
  inventoryOwner,
  itemUseTextSchema,
  type CombatDefinition,
  type CombatMoveDefinition,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import type { IGameInventory, InventoryItemSnapshot } from './inventory.js'
import type { IGameBindings } from './gameBindings.js'
import type { CombatSnapshot } from './combat.js'

export function usableItem(
  inventory: IGameInventory | undefined,
  definition: InventoryDefinition | undefined,
  id: string,
  bindings?: IGameBindings,
  allowReserved = false,
) {
  const item = inventory?.snapshot.find((item) => item.id === id)
  const type = item && definition?.itemTypes[item.itemType]
  const use = type?.use
  const messages = use?.messages ?? itemUseTextSchema.parse({})
  const owner = inventoryOwner(new Map(inventory?.snapshot.map((item) => [item.id, item])), id)
  const lineage: InventoryItemSnapshot[] = []
  let ancestor = item

  while (ancestor && !lineage.includes(ancestor)) {
    lineage.push(ancestor)
    const placement = ancestor.placement
    ancestor =
      placement.type === 'inside'
        ? inventory?.snapshot.find((entry) => entry.id === placement.container)
        : undefined
  }

  const enabled = !use?.enabledWhen || bindings?.read(use.enabledWhen)

  const reason =
    !item || !use
      ? messages.selection
      : !allowReserved && inventory?.isReserved?.(id)
        ? messages.reserved
        : item.placement.type === 'equipped'
          ? messages.equipped
          : inventory?.snapshot.some(
                (entry) => entry.placement.type === 'inside' && entry.placement.container === id,
              )
            ? messages.container
            : enabled !== true && (enabled?.status !== 'resolved' || enabled.value !== true)
              ? messages.disabled
              : undefined

  return { item, type, use, owner, reason, messages, lineage }
}

export function abilityCanMatter(
  move: CombatMoveDefinition,
  definition: CombatDefinition,
  snapshot: Pick<CombatSnapshot, 'health' | 'maximumHealth' | 'statuses' | 'guard' | 'stats'>,
  target: string,
): boolean {
  if (move.type !== 'ability') return false

  return move.effects.some((effect) => {
    const recipient = effect.target === 'self' ? definition.player.id : target

    if (!snapshot.health[recipient]) return false

    if (effect.type === 'heal')
      return effect.amount > 0 && snapshot.health[recipient]! < snapshot.maximumHealth[recipient]!

    if (effect.type === 'remove-status')
      return Boolean(snapshot.statuses[recipient]?.some((status) => status.id === effect.status))

    if (effect.type === 'damage')
      return (
        effect.damage.max + (snapshot.stats[definition.player.id]?.attack ?? 0) >
        (snapshot.stats[recipient]?.defense ?? 0)
      )

    if (effect.type === 'guard')
      return effect.amount + (snapshot.stats[definition.player.id]?.guard ?? 0) > 0

    return true
  })
}
