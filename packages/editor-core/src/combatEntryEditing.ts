import { mergeCombatPassiveReferences } from './combatPassiveEditing.js'
import { mergeCombatDamageDefenses } from './combatDamageEditing.js'
import { mergeCombatScaling, mergeCombatEffectValueScaling } from './combatValueEditing.js'
import { combatPercentModifierNames } from '@ancadeba/schemas'
import type { CombatSource } from '@ancadeba/schemas'
import { mergeCombatRuleConditions } from './combatRuleEntryEditing.js'
import { object } from './project.js'

export function mergeCombatEntries(
  previous: Record<string, unknown>,
  definition: Pick<CombatSource, 'moves' | 'statuses'>,
) {
  return {
    moves: Object.fromEntries(
      Object.entries(definition.moves).map(([id, move]) => {
        const old = object(object(previous.moves)[id])

        return [
          id,
          {
            ...old,
            ...move,
            labelKey: move.labelKey,
            descriptionKey: move.descriptionKey,
            requirements: move.requirements
              ? mergeCombatRuleConditions(old.requirements, move.requirements)
              : undefined,
            categories: move.categories ? [...move.categories] : undefined,
            damageType: move.type === 'attack' ? move.damageType : undefined,
            damage: move.type === 'attack' ? { ...object(old.damage), ...move.damage } : undefined,
            guard: move.type === 'guard' ? move.guard : undefined,
            cooldown: move.cooldown,
            apCostScaling: mergeCombatScaling(old.apCostScaling, move.apCostScaling),
            resourceCostScaling: move.resourceCostScaling
              ? Object.fromEntries(
                  Object.entries(move.resourceCostScaling).map(([id, scaling]) => [
                    id,
                    mergeCombatScaling(object(old.resourceCostScaling)[id], scaling),
                  ]),
                )
              : undefined,
            scaling:
              move.type !== 'ability' ? mergeCombatScaling(old.scaling, move.scaling) : undefined,
            resourceCosts: move.resourceCosts ? { ...move.resourceCosts } : undefined,
            target: move.type === 'ability' ? move.target : undefined,
            effects:
              move.type === 'ability'
                ? move.effects.map((effect) => {
                    const previous = (Array.isArray(old.effects) ? old.effects : [])
                      .map(object)
                      .find((entry) => entry.id === effect.id)

                    return {
                      ...previous,
                      ...effect,
                      valueScaling: mergeCombatEffectValueScaling(
                        previous?.valueScaling,
                        effect.valueScaling,
                      ),
                      duration: effect.type === 'apply-status' ? effect.duration : undefined,
                      target: effect.target,
                      damageType: effect.type === 'damage' ? effect.damageType : undefined,
                      scaling:
                        'scaling' in effect
                          ? mergeCombatScaling(previous?.scaling, effect.scaling)
                          : undefined,
                      conditions: effect.conditions
                        ? mergeCombatRuleConditions(previous?.conditions, effect.conditions)
                        : undefined,
                      amount:
                        effect.type === 'heal' ||
                        effect.type === 'guard' ||
                        effect.type === 'change-resource'
                          ? effect.amount
                          : undefined,
                      damage:
                        effect.type === 'damage'
                          ? { ...object(previous?.damage), ...effect.damage }
                          : undefined,
                      status:
                        effect.type === 'apply-status' || effect.type === 'remove-status'
                          ? effect.status
                          : undefined,
                      resource: effect.type === 'change-resource' ? effect.resource : undefined,
                      stacks:
                        effect.type === 'apply-status' || effect.type === 'remove-status'
                          ? effect.stacks
                          : undefined,
                      intensity: effect.type === 'apply-status' ? effect.intensity : undefined,
                    }
                  })
                : undefined,
          },
        ]
      }),
    ),
    statuses: definition.statuses
      ? Object.fromEntries(
          Object.entries(definition.statuses).map(([id, status]) => {
            const old = object(object(previous.statuses)[id])

            return [
              id,
              {
                ...old,
                ...status,
                valueScaling: mergeCombatEffectValueScaling(old.valueScaling, status.valueScaling),
                passives: mergeCombatPassiveReferences(old.passives, status.passives),
                labelKey: status.labelKey,
                descriptionKey: status.descriptionKey,
                icon: status.icon,
                statusImmunities: status.statusImmunities
                  ? [...status.statusImmunities]
                  : undefined,
                blockedMoveCategories: status.blockedMoveCategories
                  ? [...status.blockedMoveCategories]
                  : undefined,
                damageType:
                  status.type === 'damage' ||
                  (status.type === 'composite' && status.damage !== undefined)
                    ? status.damageType
                    : undefined,
                damageDefenses: mergeCombatDamageDefenses(
                  old.damageDefenses,
                  status.damageDefenses,
                ),
                stacking: status.stacking
                  ? { ...object(old.stacking), ...status.stacking }
                  : undefined,
                intensity: status.intensity
                  ? { ...object(old.intensity), ...status.intensity }
                  : undefined,
                damage: status.type === 'composite' ? status.damage : undefined,
                regeneration: status.type === 'composite' ? status.regeneration : undefined,
                stun: status.type === 'composite' ? status.stun : undefined,
                amount:
                  status.type === 'damage' || status.type === 'regeneration'
                    ? status.amount
                    : undefined,
                percentModifiers:
                  (status.type === 'modifier' || status.type === 'composite') &&
                  status.percentModifiers
                    ? {
                        ...object(old.percentModifiers),
                        ...Object.fromEntries(
                          combatPercentModifierNames.map((stat) => [
                            stat,
                            status.percentModifiers?.[stat],
                          ]),
                        ),
                      }
                    : undefined,
                modifiers:
                  status.type === 'modifier' || (status.type === 'composite' && status.modifiers)
                    ? {
                        ...object(old.modifiers),
                        ...status.modifiers,
                        attack: status.modifiers?.attack,
                        defense: status.modifiers?.defense,
                        guard: status.modifiers?.guard,
                        ap: status.modifiers?.ap,
                        apCost: status.modifiers?.apCost,
                      }
                    : undefined,
              },
            ]
          }),
        )
      : undefined,
  }
}
