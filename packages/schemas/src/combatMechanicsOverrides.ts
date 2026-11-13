import type { CombatMechanicsDefinition } from './combatMechanics.js'
import { cloneCombatRules, type CombatMechanicsOverrides } from './combatRulesets.js'

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true

  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((entry, index) => equal(entry, right[index]))

  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const entries = Object.entries(left)

    return (
      entries.length === Object.keys(right).length &&
      entries.every(([key, value]) =>
        equal(value, Object.getOwnPropertyDescriptor(right, key)?.value),
      )
    )
  }

  return false
}

function optionalField<T>(base: T | undefined, override: T | null | undefined): T | undefined {
  return override === null ? undefined : override === undefined ? base : override
}

/** Keep structured drafts editable while an intermediate override violates bounds or references. */
export function previewCombatMechanicsOverrides(
  base: CombatMechanicsDefinition,
  overrides?: CombatMechanicsOverrides,
): CombatMechanicsDefinition {
  const result = cloneCombatRules(base)

  if (!overrides) return result

  for (const [id, patch] of Object.entries(overrides.resources ?? {})) {
    if (patch === null) {
      delete result.resources[id]
      continue
    }

    const old = result.resources[id] ?? { label: id, description: '', initial: 0, maximum: 100 }
    result.resources[id] = {
      label: patch.label ?? old.label,
      description: patch.description ?? old.description,
      labelKey: optionalField(old.labelKey, patch.labelKey),
      descriptionKey: optionalField(old.descriptionKey, patch.descriptionKey),
      actor: optionalField(old.actor, patch.actor),
      initial: patch.initial ?? old.initial,
      maximum: patch.maximum ?? old.maximum,
    }
  }

  for (const [id, patch] of Object.entries(overrides.triggers ?? {})) {
    if (patch === null) {
      delete result.triggers[id]
      continue
    }

    const old: CombatMechanicsDefinition['triggers'][string] = result.triggers[id] ?? {
      event: 'round-end',
      once: false,
      conditions: [],
      effects: [],
    }

    result.triggers[id] = {
      source: optionalField(old.source, patch.source),
      target: optionalField(old.target, patch.target),
      damageType: optionalField(old.damageType, patch.damageType),
      delivery: optionalField(old.delivery, patch.delivery),
      includeReactions: optionalField(old.includeReactions, patch.includeReactions),
      event: patch.event ?? old.event,
      once: patch.once ?? old.once,
      actor: optionalField(old.actor, patch.actor),
      move: optionalField(old.move, patch.move),
      status: optionalField(old.status, patch.status),
      resource: optionalField(old.resource, patch.resource),
      phase: optionalField(old.phase, patch.phase),
      conditions: cloneCombatRules(patch.conditions ?? old.conditions),
      effects: cloneCombatRules(patch.effects ?? old.effects),
    }
  }

  for (const [id, patch] of Object.entries(overrides.phases ?? {})) {
    if (patch === null) {
      delete result.phases[id]
      continue
    }

    const old = result.phases[id] ?? { label: id, description: '', onEnter: [] }
    let enemyRotations = old.enemyRotations

    if (patch.enemyRotations === null) enemyRotations = undefined
    else if (patch.enemyRotations !== undefined) {
      enemyRotations = { ...enemyRotations }

      for (const [actor, rotation] of Object.entries(patch.enemyRotations)) {
        if (rotation === null) delete enemyRotations[actor]
        else enemyRotations[actor] = [...rotation]
      }
    }

    result.phases[id] = {
      label: patch.label ?? old.label,
      description: patch.description ?? old.description,
      labelKey: optionalField(old.labelKey, patch.labelKey),
      descriptionKey: optionalField(old.descriptionKey, patch.descriptionKey),
      onEnter: cloneCombatRules(patch.onEnter ?? old.onEnter),
      enemyRotations,
    }
  }

  result.initialPhase = optionalField(result.initialPhase, overrides.initialPhase)
  result.victory = overrides.victory ?? result.victory

  if (overrides.triggerOrder) {
    result.triggers = Object.fromEntries([
      ...overrides.triggerOrder.flatMap((id) =>
        result.triggers[id] ? [[id, result.triggers[id]] as const] : [],
      ),
      ...Object.entries(result.triggers).filter(([id]) => !overrides.triggerOrder!.includes(id)),
    ])
  }

  return result
}

function diffEntries<T, P extends Record<string, unknown>>(
  base: Record<string, T>,
  edited: Record<string, T>,
  fields: (previous: T | undefined, next: T) => P,
) {
  const patch: Record<string, P | null> = {}

  for (const id of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    const next = edited[id]

    if (!next) {
      patch[id] = null
      continue
    }

    const entry = fields(base[id], next)

    if (Object.keys(entry).length) patch[id] = entry
  }

  return patch
}

type PresentedMechanic = CombatMechanicsDefinition['resources'][string]

function diffPresentation(
  previous:
    | Pick<PresentedMechanic, 'label' | 'description' | 'labelKey' | 'descriptionKey'>
    | undefined,
  next: Pick<PresentedMechanic, 'label' | 'description' | 'labelKey' | 'descriptionKey'>,
) {
  return {
    ...(previous?.label !== next.label ? { label: next.label } : {}),
    ...(previous?.description !== next.description ? { description: next.description } : {}),
    ...(previous?.labelKey !== next.labelKey ? { labelKey: next.labelKey ?? null } : {}),
    ...(previous?.descriptionKey !== next.descriptionKey
      ? { descriptionKey: next.descriptionKey ?? null }
      : {}),
  }
}

/** Only changed typed fields are emitted. Draft numeric bounds are validated when saving. */
export function diffCombatMechanics(
  base: CombatMechanicsDefinition,
  edited: CombatMechanicsDefinition,
): CombatMechanicsOverrides {
  const patch: CombatMechanicsOverrides = {}

  const resources = diffEntries(base.resources, edited.resources, (previous, next) => ({
    ...diffPresentation(previous, next),
    ...(previous?.actor !== next.actor ? { actor: next.actor ?? null } : {}),
    ...(previous?.initial !== next.initial ? { initial: next.initial } : {}),
    ...(previous?.maximum !== next.maximum ? { maximum: next.maximum } : {}),
  }))

  const triggers = diffEntries(base.triggers, edited.triggers, (previous, next) => ({
    ...(previous?.source !== next.source ? { source: next.source ?? null } : {}),
    ...(previous?.target !== next.target ? { target: next.target ?? null } : {}),
    ...(previous?.damageType !== next.damageType ? { damageType: next.damageType ?? null } : {}),
    ...(previous?.delivery !== next.delivery ? { delivery: next.delivery ?? null } : {}),
    ...(previous?.includeReactions !== next.includeReactions
      ? { includeReactions: next.includeReactions ?? null }
      : {}),
    ...(previous?.event !== next.event ? { event: next.event } : {}),
    ...(previous?.actor !== next.actor ? { actor: next.actor ?? null } : {}),
    ...(previous?.move !== next.move ? { move: next.move ?? null } : {}),
    ...(previous?.status !== next.status ? { status: next.status ?? null } : {}),
    ...(previous?.resource !== next.resource ? { resource: next.resource ?? null } : {}),
    ...(previous?.phase !== next.phase ? { phase: next.phase ?? null } : {}),
    ...(previous?.once !== next.once ? { once: next.once } : {}),
    ...(!equal(previous?.conditions, next.conditions)
      ? { conditions: cloneCombatRules(next.conditions) }
      : {}),
    ...(!equal(previous?.effects, next.effects) ? { effects: cloneCombatRules(next.effects) } : {}),
  }))

  const phases = diffEntries(base.phases, edited.phases, (previous, next) => {
    const rotations: Record<string, string[] | null> = {}

    for (const actor of new Set([
      ...Object.keys(previous?.enemyRotations ?? {}),
      ...Object.keys(next.enemyRotations ?? {}),
    ]))
      if (!equal(previous?.enemyRotations?.[actor], next.enemyRotations?.[actor]))
        rotations[actor] = next.enemyRotations?.[actor] ?? null

    return {
      ...diffPresentation(previous, next),
      ...(!equal(previous?.onEnter, next.onEnter)
        ? { onEnter: cloneCombatRules(next.onEnter) }
        : {}),
      ...(!equal(previous?.enemyRotations, next.enemyRotations)
        ? { enemyRotations: next.enemyRotations === undefined ? null : rotations }
        : {}),
    }
  })

  if (Object.keys(resources).length) patch.resources = resources

  if (Object.keys(triggers).length) patch.triggers = triggers

  if (Object.keys(phases).length) patch.phases = phases

  if (base.initialPhase !== edited.initialPhase) patch.initialPhase = edited.initialPhase ?? null

  if (base.victory !== edited.victory) patch.victory = edited.victory

  const naturalOrder = [
    ...Object.keys(base.triggers).filter((id) => Object.hasOwn(edited.triggers, id)),
    ...Object.keys(edited.triggers).filter((id) => !Object.hasOwn(base.triggers, id)),
  ]

  if (!equal(naturalOrder, Object.keys(edited.triggers)))
    patch.triggerOrder = Object.keys(edited.triggers)

  return patch
}
