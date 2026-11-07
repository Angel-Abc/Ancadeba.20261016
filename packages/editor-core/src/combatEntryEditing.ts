import type { CombatSource } from '@ancadeba/schemas'
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
            damage: move.type === 'attack' ? { ...object(old.damage), ...move.damage } : undefined,
            guard: move.type === 'guard' ? move.guard : undefined,
            cooldown: move.cooldown,
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
                      target: effect.target,
                      amount:
                        effect.type === 'heal' || effect.type === 'guard'
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
                labelKey: status.labelKey,
                descriptionKey: status.descriptionKey,
                icon: status.icon,
                amount:
                  status.type === 'damage' || status.type === 'regeneration'
                    ? status.amount
                    : undefined,
                modifiers:
                  status.type === 'modifier'
                    ? {
                        ...object(old.modifiers),
                        ...status.modifiers,
                        attack: status.modifiers.attack,
                        defense: status.modifiers.defense,
                        guard: status.modifiers.guard,
                      }
                    : undefined,
              },
            ]
          }),
        )
      : undefined,
  }
}
