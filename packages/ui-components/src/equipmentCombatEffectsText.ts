import type { EquipmentCombatEffects, CombatStatsProfile } from '@ancadeba/schemas'

export function equipmentCombatEffectsText(
  effects: EquipmentCombatEffects,
  messages: CombatStatsProfile['messages'],
  moveLabel: (reference: { library: string; id: string }) => string = (reference) => reference.id,
  passiveLabel: (reference: { library: string; id: string }) => string = (reference) =>
    reference.id,
): string {
  const lines: string[] = []

  for (const [type, amount] of Object.entries(effects.damageDefenses?.resistances ?? {}))
    lines.push(
      messages.damageResistance.replaceAll('{type}', type).replaceAll('{amount}', String(amount)),
    )

  for (const [type, amount] of Object.entries(effects.damageDefenses?.vulnerabilities ?? {}))
    lines.push(
      messages.damageVulnerability
        .replaceAll('{type}', type)
        .replaceAll('{amount}', String(amount)),
    )

  for (const type of effects.damageDefenses?.immunities ?? [])
    lines.push(messages.damageImmunity.replaceAll('{type}', type))

  for (const status of effects.statusImmunities ?? [])
    lines.push(messages.statusImmunity.replaceAll('{status}', status))

  for (const category of effects.blockedMoveCategories ?? [])
    lines.push(messages.blockedCategory.replaceAll('{category}', category))

  for (const [resource, modifier] of Object.entries(effects.resourceGains ?? {}))
    lines.push(
      messages.resourceGain
        .replaceAll('{resource}', resource)
        .replaceAll('{flat}', `${(modifier.flat ?? 0) >= 0 ? '+' : ''}${modifier.flat ?? 0}`)
        .replaceAll(
          '{percent}',
          `${(modifier.percent ?? 0) >= 0 ? '+' : ''}${modifier.percent ?? 0}`,
        ),
    )

  for (const reference of effects.grantedMoves ?? [])
    lines.push(messages.grantedMove.replaceAll('{move}', moveLabel(reference)))

  for (const reference of effects.passives ?? [])
    lines.push(messages.grantedPassive.replaceAll('{passive}', passiveLabel(reference)))

  return lines.join(' · ')
}
