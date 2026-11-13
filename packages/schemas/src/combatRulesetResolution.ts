import { z } from 'zod'
import { bindCombatCondition, visitCombatCondition } from './combatConditions.js'
import type { CombatLibrary, CombatSource, CombatMechanicsOrigins } from './combatLibraries.js'
import type { CombatMechanicsDefinition, CombatTriggerEffect } from './combatMechanics.js'
import {
  applyCombatMechanicsOverrides,
  cloneCombatRules,
  combatRulesetReferences,
  type CombatRuleset,
} from './combatRulesets.js'

/** Collect implicit dependencies from the effective rules, after local exclusions/overrides. */
export function combatRulesetDependencies(mechanics: CombatMechanicsDefinition | undefined) {
  const moves = new Set<string>()
  const statuses = new Set<string>()

  const effect = (effect: CombatTriggerEffect) => {
    if ('status' in effect) statuses.add(effect.status)

    for (const condition of effect.conditions ?? [])
      visitCombatCondition(condition, (leaf) => {
        if ('status' in leaf) statuses.add(leaf.status)
      })
  }

  for (const trigger of Object.values(mechanics?.triggers ?? {})) {
    if (trigger.move) moves.add(trigger.move)

    if (trigger.status) statuses.add(trigger.status)

    for (const condition of trigger.conditions)
      visitCombatCondition(condition, (leaf) => {
        if ('status' in leaf) statuses.add(leaf.status)
      })
    trigger.effects.forEach(effect)
  }

  for (const phase of Object.values(mechanics?.phases ?? {})) {
    phase.onEnter.forEach(effect)

    for (const rotation of Object.values(phase.enemyRotations ?? {}))
      for (const move of rotation) moves.add(move)
  }

  return { moves, statuses }
}

export function bindCombatRulesetActors(
  ruleset: CombatRuleset,
  bindings: Readonly<Record<string, string>>,
): CombatMechanicsDefinition {
  const mechanics = cloneCombatRules(ruleset.mechanics)
  const actor = (id: string) => (id.startsWith('event.') ? id : (bindings[id] ?? id))

  const entry = (value: CombatTriggerEffect): CombatTriggerEffect => ({
    ...value,
    ...('actor' in value ? { actor: actor(value.actor) } : {}),
    ...('source' in value && value.source ? { source: actor(value.source) } : {}),
    ...(value.conditions
      ? { conditions: value.conditions.map((condition) => bindCombatCondition(condition, actor)) }
      : {}),
  })

  for (const resource of Object.values(mechanics.resources))
    if (resource.actor) resource.actor = actor(resource.actor)

  for (const trigger of Object.values(mechanics.triggers)) {
    if (trigger.actor) trigger.actor = actor(trigger.actor)

    if (trigger.source) trigger.source = actor(trigger.source)

    if (trigger.target) trigger.target = actor(trigger.target)
    trigger.conditions = trigger.conditions.map((condition) =>
      bindCombatCondition(condition, actor),
    )
    trigger.effects = trigger.effects.map(entry)
  }

  for (const phase of Object.values(mechanics.phases)) {
    phase.onEnter = phase.onEnter.map(entry)

    if (phase.enemyRotations)
      phase.enemyRotations = Object.fromEntries(
        Object.entries(phase.enemyRotations).map(([id, moves]) => [actor(id), moves]),
      )
  }

  return mechanics
}

export function resolveCombatRuleset(
  source: CombatSource,
  libraries: ReadonlyMap<string, CombatLibrary>,
  file = `combat/${source.id}.json`,
) {
  const issues: { file: string; path: (string | number)[]; message: string }[] = []
  const references = combatRulesetReferences(source)

  const conflicts: {
    section: string
    id: string
    previous: string
    next: string
    replaced: boolean
  }[] = []

  const baseOrigins: CombatMechanicsOrigins = { resources: {}, triggers: {}, phases: {} }

  if (!references.length)
    return {
      mechanics: source.mechanics,
      base: undefined,
      issues,
      origins: undefined,
      baseOrigins,
      conflicts,
    }

  const base: CombatMechanicsDefinition = {
    resources: {},
    triggers: {},
    phases: {},
    victory: 'enemies-defeated',
  }

  const actors = new Set([source.player, ...source.enemies].map((actor) => actor.id))
  let phaseOwner: string | undefined

  for (const [index, reference] of references.entries()) {
    const path = source.rulesets ? ['rulesets', index] : ['ruleset']
    const identity = `${reference.library}/${reference.id}`
    const ruleset = libraries.get(reference.library)?.rulesets?.[reference.id]

    if (!ruleset) {
      issues.push({ file, path, message: `Missing combat ruleset: ${identity}` })
      continue
    }

    const used = new Set<string>()

    for (const role of ruleset.actors) {
      const actor = reference.actors?.[role] ?? role

      if (!actors.has(actor))
        issues.push({
          file,
          path: [...path, 'actors', role],
          message: `Bind actor role ${role} to an encounter actor`,
        })

      if (used.has(actor))
        issues.push({
          file,
          path: [...path, 'actors', role],
          message: 'Ruleset actor roles must bind to distinct actors',
        })
      used.add(actor)
    }

    for (const role of Object.keys(reference.actors ?? {}))
      if (!ruleset.actors.includes(role))
        issues.push({
          file,
          path: [...path, 'actors', role],
          message: `Unknown ruleset actor role: ${role}`,
        })
    const bound = bindCombatRulesetActors(ruleset, reference.actors ?? {})

    const collision = (section: string, id: string, previous: string) => {
      const replaced = reference.collision === 'replace'
      conflicts.push({ section, id, previous, next: identity, replaced })

      if (!replaced)
        issues.push({
          file,
          path,
          message: `Ruleset conflict for ${section}/${id}: ${identity} collides with ${previous}; enable replacement on the later layer or use distinct IDs`,
        })
    }

    for (const section of ['resources', 'triggers', 'phases'] as const) {
      for (const [id, entry] of Object.entries(bound[section])) {
        const previous = baseOrigins[section][id]

        if (previous) collision(section, id, `${previous.library}/${previous.ruleset}`)
        // Replacements take their later layer's position in trigger execution order.
        delete base[section][id]
        Object.assign(base[section], { [id]: cloneCombatRules(entry) })
        baseOrigins[section][id] = {
          file: `combat-libraries/${reference.library}.json`,
          path: ['rulesets', reference.id, 'mechanics', section, id],
          library: reference.library,
          ruleset: reference.id,
        }
      }
    }

    if (bound.initialPhase) {
      if (base.initialPhase && base.initialPhase !== bound.initialPhase)
        collision('settings', 'initialPhase', phaseOwner!)
      base.initialPhase = bound.initialPhase
      phaseOwner = identity
    }

    // Environmental defaults must not accidentally turn off an objective-based victory.
    if (bound.victory === 'triggers') base.victory = 'triggers'
  }

  const origins: CombatMechanicsOrigins = { resources: {}, triggers: {}, phases: {} }

  try {
    const mechanics = applyCombatMechanicsOverrides(base, source.mechanicsOverrides)

    for (const section of ['resources', 'triggers', 'phases'] as const)
      for (const id of Object.keys(mechanics[section]))
        origins[section][id] = Object.hasOwn(source.mechanicsOverrides?.[section] ?? {}, id)
          ? { file, path: ['mechanicsOverrides', section, id] }
          : baseOrigins[section][id]!

    return {
      mechanics: issues.length ? undefined : mechanics,
      base,
      issues,
      origins,
      baseOrigins,
      conflicts,
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues)
        issues.push({
          file,
          path: [
            'mechanicsOverrides',
            ...issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          ],
          message: issue.message,
        })
    } else
      issues.push({
        file,
        path: ['mechanicsOverrides'],
        message: error instanceof Error ? error.message : String(error),
      })

    return { mechanics: undefined, base, issues, origins, baseOrigins, conflicts }
  }
}
