import {
  combatTriggerActivationSchema,
  type CombatDefinition,
  type CombatMechanicsState,
  type CombatPassiveSource,
  type CombatTriggerDefinition,
  type CombatTriggerActivation,
} from '@ancadeba/schemas'

export interface CombatTriggerLimitsTrace {
  readonly priority: number
  readonly chargesRemaining?: number | undefined
  readonly perTurnRemaining?: number | undefined
  readonly cooldownRemaining: number
  readonly blockers: readonly ('once' | 'charges' | 'per-turn' | 'cooldown')[]
}

export function combatTriggerHasLimits(trigger: CombatTriggerDefinition): boolean {
  return trigger.charges !== undefined || trigger.perTurn !== undefined || Boolean(trigger.cooldown)
}

export function combatTriggerActivationKey(trigger: string, passive?: CombatPassiveSource): string {
  return JSON.stringify(
    passive
      ? [
          'passive',
          passive.kind,
          passive.actor,
          passive.id,
          passive.library,
          passive.passive,
          trigger,
        ]
      : ['encounter', trigger],
  )
}

export function combatTriggerLimits(
  trigger: CombatTriggerDefinition,
  previous: CombatTriggerActivation | undefined,
  turn: number,
  round: number,
  onceFired: boolean,
): CombatTriggerLimitsTrace {
  const chargesRemaining =
    trigger.charges === undefined ? undefined : Math.max(0, trigger.charges - (previous?.uses ?? 0))

  const perTurnRemaining =
    trigger.perTurn === undefined
      ? undefined
      : Math.max(0, trigger.perTurn - (previous?.turn === turn ? previous.turnUses : 0))

  const cooldownRemaining = Math.max(0, (previous?.readyRound ?? 0) - round)
  const blockers: ('once' | 'charges' | 'per-turn' | 'cooldown')[] = []

  if (trigger.once && onceFired) blockers.push('once')

  if (chargesRemaining === 0) blockers.push('charges')

  if (perTurnRemaining === 0) blockers.push('per-turn')

  if (cooldownRemaining) blockers.push('cooldown')

  return {
    priority: trigger.priority ?? 0,
    chargesRemaining,
    perTurnRemaining,
    cooldownRemaining,
    blockers,
  }
}

/** Reserve before effects execute, including effects that synchronously dispatch another packet. */
export function activateCombatTrigger(
  state: CombatMechanicsState,
  trigger: CombatTriggerDefinition,
  id: string,
  passive: CombatPassiveSource | undefined,
  round: number,
): CombatTriggerActivation | undefined {
  if (!combatTriggerHasLimits(trigger)) return
  const key = combatTriggerActivationKey(id, passive)
  const entries = (state.activations ??= [])

  const index = entries.findIndex(
    (entry) => combatTriggerActivationKey(entry.trigger, entry.passive) === key,
  )

  const previous = entries[index]
  const turn = state.turn ?? 0

  const next = combatTriggerActivationSchema.parse({
    trigger: id,
    ...(passive ? { passive: { ...passive } } : {}),
    uses: (previous?.uses ?? 0) + 1,
    turn,
    turnUses: (previous?.turn === turn ? previous.turnUses : 0) + 1,
    readyRound: trigger.cooldown ? round + trigger.cooldown + 1 : 0,
  })

  if (index < 0) {
    if (entries.length >= 10000) throw new Error('Combat trigger activation limit exceeded')
    entries.push(next)
  } else entries[index] = next

  return next
}

export function validateCombatTriggerActivations(
  definition: CombatDefinition,
  state: CombatMechanicsState,
): void {
  const entries = state.activations ?? []

  if (
    (state.turn !== undefined && (!Number.isSafeInteger(state.turn) || state.turn < 0)) ||
    entries.length > 10000 ||
    new Set(entries.map((entry) => combatTriggerActivationKey(entry.trigger, entry.passive)))
      .size !== entries.length
  )
    throw new Error('Invalid combat trigger activation history')

  for (const entry of entries) {
    if (!combatTriggerActivationSchema.safeParse(entry).success)
      throw new Error('Invalid combat trigger activation counters')
    const source = entry.passive

    const trigger = source
      ? definition.passiveDefinitions?.[source.library]?.[source.passive]?.triggers[entry.trigger]
      : definition.mechanics?.triggers[entry.trigger]

    const actor =
      source &&
      [definition.player, ...definition.enemies].find((actor) => actor.id === source.actor)

    if (
      !trigger ||
      !combatTriggerHasLimits(trigger) ||
      entry.turn > (state.turn ?? 0) ||
      entry.turnUses > entry.uses ||
      (trigger.charges !== undefined && entry.uses > trigger.charges) ||
      (trigger.perTurn !== undefined && entry.turnUses > trigger.perTurn) ||
      (trigger.once && entry.uses > 1) ||
      (!trigger.cooldown && entry.readyRound !== 0) ||
      (source &&
        (!actor ||
          (source.kind === 'equipment'
            ? !actor.equipmentOwner
            : !definition.statuses?.[source.id]?.passives?.some(
                (reference) =>
                  reference.library === source.library && reference.id === source.passive,
              ))))
    )
      throw new Error('Invalid combat trigger activation reference')
  }
}
