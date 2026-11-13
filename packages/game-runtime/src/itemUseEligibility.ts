import { combatDamageProfile } from './combatDamage.js'
import { combatStatusImmune, combatMoveRestriction } from './combatRestrictions.js'
import { combatValueContext } from './combatValues.js'
import { combatAbilityEffectValues } from './combatResolution.js'
import { statusContributions } from './combatEffects.js'
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
import { combatConditionContext, combatConditionsMatch } from './combatConditions.js'
import { applyCombatStatus } from './combatStatusStacking.js'

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
  snapshot: Pick<
    CombatSnapshot,
    'health' | 'maximumHealth' | 'statuses' | 'guard' | 'stats' | 'resources'
  > &
    Partial<Pick<CombatSnapshot, 'bossPhase' | 'equipment'>>,
  target: string,
): boolean {
  if (move.type !== 'ability') return false

  if (
    combatMoveRestriction(
      definition,
      definition.player.id,
      move,
      snapshot.statuses,
      snapshot.equipment,
    )
  )
    return false

  const context = combatConditionContext(definition, {
    ...snapshot,
    phase: snapshot.bossPhase,
    self: definition.player.id,
    target,
  })

  if (!combatConditionsMatch(move.requirements, context)) return false

  return move.effects.some((effect) => {
    if (!combatConditionsMatch(effect.conditions, context)) return false

    if (effect.type === 'change-resource') {
      const value = snapshot.resources[effect.resource]
      const maximum = definition.mechanics?.resources[effect.resource]?.maximum

      return (
        value !== undefined &&
        maximum !== undefined &&
        (effect.amount > 0 ? value < maximum : effect.amount < 0 && value > 0)
      )
    }

    const recipient = effect.target === 'self' ? definition.player.id : target

    if (!snapshot.health[recipient]) return false

    const values = combatAbilityEffectValues(
      effect,
      snapshot.stats[definition.player.id],
      snapshot.stats[recipient]?.defense ?? 0,
      combatValueContext(
        definition,
        snapshot.resources,
        snapshot.statuses,
        definition.player.id,
        target,
      ),
      statusContributions(definition, snapshot.statuses[definition.player.id] ?? []),
      combatDamageProfile(definition, recipient, snapshot.statuses, snapshot.equipment),
    )

    if (effect.type === 'heal')
      return (
        (values.amount ?? 0) > 0 && snapshot.health[recipient]! < snapshot.maximumHealth[recipient]!
      )

    if (effect.type === 'remove-status')
      return Boolean(snapshot.statuses[recipient]?.some((status) => status.id === effect.status))

    if (effect.type === 'apply-status') {
      if (
        combatStatusImmune(
          definition,
          recipient,
          effect.status,
          snapshot.statuses,
          snapshot.equipment,
        )
      )
        return false
      const status = definition.statuses?.[effect.status]

      return Boolean(
        status &&
        applyCombatStatus(
          status,
          effect.status,
          definition.player.id,
          snapshot.statuses[recipient]?.find((active) => active.id === effect.status),
          effect,
        ).changed,
      )
    }

    if (effect.type === 'damage') return (values.max ?? 0) > 0

    if (effect.type === 'guard') return (values.amount ?? 0) > 0

    return true
  })
}
