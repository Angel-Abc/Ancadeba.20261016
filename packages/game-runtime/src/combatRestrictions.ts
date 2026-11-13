import type { CombatDefinition, CombatMoveDefinition, CombatEquipment } from '@ancadeba/schemas'
import type { CombatStatuses } from './combatEffects.js'

export interface CombatRestrictionProfile {
  readonly statusImmunities: readonly string[]
  readonly blockedMoveCategories: readonly string[]
}

export interface CombatMoveRestriction {
  readonly category: string
  readonly status?: string | undefined
}

function owners(
  definition: CombatDefinition,
  actor: string,
  statuses: CombatStatuses,
  equipment: CombatEquipment = {},
) {
  const owner = [definition.player, ...definition.enemies].find((entry) => entry.id === actor)

  if (!owner) throw new Error('Unknown restricted combat actor')

  return [
    { owner, status: undefined },
    ...(equipment[actor] ?? []).map((entry) => ({ owner: entry.effects, status: undefined })),
    ...(statuses[actor] ?? []).flatMap((active) => {
      const status = definition.statuses?.[active.id]

      return status ? [{ owner: status, status: active.id }] : []
    }),
  ]
}

/** Categorical protections are a union, independent of stacks and intensity. */
export function combatRestrictionProfile(
  definition: CombatDefinition,
  actor: string,
  statuses: CombatStatuses = {},
  equipment: CombatEquipment = {},
): CombatRestrictionProfile {
  const entries = owners(definition, actor, statuses, equipment)

  return Object.freeze({
    statusImmunities: Object.freeze([
      ...new Set(entries.flatMap(({ owner }) => owner.statusImmunities ?? [])),
    ]),
    blockedMoveCategories: Object.freeze([
      ...new Set(entries.flatMap(({ owner }) => owner.blockedMoveCategories ?? [])),
    ]),
  })
}

export function combatStatusImmune(
  definition: CombatDefinition,
  actor: string,
  status: string,
  statuses: CombatStatuses = {},
  equipment: CombatEquipment = {},
): boolean {
  return owners(definition, actor, statuses, equipment).some(({ owner }) =>
    owner.statusImmunities?.includes(status),
  )
}

export function combatMoveRestriction(
  definition: CombatDefinition,
  actor: string,
  move: CombatMoveDefinition,
  statuses: CombatStatuses = {},
  equipment: CombatEquipment = {},
): CombatMoveRestriction | undefined {
  for (const entry of owners(definition, actor, statuses, equipment)) {
    const category = move.categories?.find((category) =>
      entry.owner.blockedMoveCategories?.includes(category),
    )

    if (category) return { category, ...(entry.status ? { status: entry.status } : {}) }
  }
}

export function combatMoveRestrictionText(
  definition: CombatDefinition,
  actor: string,
  move: CombatMoveDefinition,
  restriction: CombatMoveRestriction,
): string {
  return definition.messages.moveRestricted
    .replaceAll(
      '{actor}',
      [definition.player, ...definition.enemies].find((entry) => entry.id === actor)?.label ??
        actor,
    )
    .replaceAll('{move}', move.label)
    .replaceAll('{category}', restriction.category)
    .replaceAll('{status}', definition.statuses?.[restriction.status ?? '']?.label ?? '')
}
