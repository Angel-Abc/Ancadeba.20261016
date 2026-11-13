import type { CombatLibrary, CombatPassiveReference } from '@ancadeba/schemas'
import { object } from './project.js'
import { mergeCombatMechanics } from './combatMechanicsEditing.js'

export function mergeCombatPassiveReferences(
  previous: unknown,
  references: readonly CombatPassiveReference[] | undefined,
) {
  const old = (Array.isArray(previous) ? previous : []).map(object)

  return references?.map((reference) => ({
    ...old.find((entry) => entry.library === reference.library && entry.id === reference.id),
    ...reference,
  }))
}

export function mergeCombatPassives(previous: unknown, passives: CombatLibrary['passives']) {
  if (!passives) return undefined

  return Object.fromEntries(
    Object.entries(passives).map(([id, passive]) => {
      const old = object(object(previous)[id])

      return [
        id,
        {
          ...old,
          ...passive,
          labelKey: passive.labelKey,
          descriptionKey: passive.descriptionKey,
          triggers: mergeCombatMechanics(
            { triggers: old.triggers },
            { resources: {}, phases: {}, triggers: passive.triggers, victory: 'enemies-defeated' },
          )!.triggers,
        },
      ]
    }),
  )
}
