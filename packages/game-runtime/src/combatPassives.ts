import type {
  CombatDefinition,
  CombatEquipment,
  CombatPassiveSource,
  CombatPassiveReceipt,
} from '@ancadeba/schemas'
import type { CombatStatuses } from './combatEffects.js'

export function combatPassiveGrants(
  definition: CombatDefinition,
  statuses: CombatStatuses,
  equipment: CombatEquipment = {},
  health?: Readonly<Record<string, number>>,
) {
  const grants: CombatPassiveSource[] = []

  for (const actor of [definition.player, ...definition.enemies]) {
    if (health && !health[actor.id]) continue

    for (const item of equipment[actor.id] ?? [])
      for (const reference of item.effects.passives ?? [])
        grants.push({
          kind: 'equipment',
          actor: actor.id,
          id: item.item,
          library: reference.library,
          passive: reference.id,
        })

    for (const status of statuses[actor.id] ?? [])
      for (const reference of definition.statuses?.[status.id]?.passives ?? [])
        grants.push({
          kind: 'status',
          actor: actor.id,
          id: status.id,
          library: reference.library,
          passive: reference.id,
        })
  }

  if (grants.length > 1000) throw new Error('Active passive grant limit exceeded')

  return grants
}

export function combatPassiveActive(
  definition: CombatDefinition,
  source: CombatPassiveSource,
  statuses: CombatStatuses,
  equipment: CombatEquipment = {},
  health?: Readonly<Record<string, number>>,
) {
  if (health && !health[source.actor]) return false

  const references =
    source.kind === 'equipment'
      ? equipment[source.actor]?.find((item) => item.item === source.id)?.effects.passives
      : statuses[source.actor]?.some((status) => status.id === source.id)
        ? definition.statuses?.[source.id]?.passives
        : undefined

  return (
    references?.some(
      (reference) => reference.library === source.library && reference.id === source.passive,
    ) ?? false
  )
}

export function combatPassiveReceiptKey(receipt: CombatPassiveReceipt): string {
  return JSON.stringify([
    receipt.kind,
    receipt.actor,
    receipt.id,
    receipt.library,
    receipt.passive,
    receipt.trigger,
  ])
}
