import { mergeCombatPassiveReferences } from './combatPassiveEditing.js'
import type { EquipmentCombatEffects } from '@ancadeba/schemas'
import { object } from './project.js'
import { mergeCombatDamageDefenses } from './combatDamageEditing.js'

export function mergeEquipmentCombatEffects(
  previous: unknown,
  effects: EquipmentCombatEffects | undefined,
) {
  if (!effects) return undefined
  const old = object(previous)
  const references = Array.isArray(old.grantedMoves) ? old.grantedMoves.map(object) : []

  return {
    ...old,
    ...effects,
    passives: mergeCombatPassiveReferences(old.passives, effects.passives),
    damageDefenses: mergeCombatDamageDefenses(old.damageDefenses, effects.damageDefenses),
    statusImmunities: effects.statusImmunities ? [...effects.statusImmunities] : undefined,
    blockedMoveCategories: effects.blockedMoveCategories
      ? [...effects.blockedMoveCategories]
      : undefined,
    resourceGains: effects.resourceGains
      ? Object.fromEntries(
          Object.entries(effects.resourceGains).map(([id, modifier]) => [
            id,
            {
              ...object(object(old.resourceGains)[id]),
              ...modifier,
              flat: modifier.flat,
              percent: modifier.percent,
            },
          ]),
        )
      : undefined,
    grantedMoves: effects.grantedMoves?.map((reference) => ({
      ...references.find(
        (entry) => entry.library === reference.library && entry.id === reference.id,
      ),
      ...reference,
    })),
  }
}
