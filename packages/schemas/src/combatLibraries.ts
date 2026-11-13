import {
  combatPassiveSchema,
  combatPassiveLibraryIssues,
  type CombatPassiveDefinitions,
} from './combatPassives.js'
import {
  combatEquipmentMoveReferences,
  combatEquipmentPassiveReferences,
} from './combatEquipment.js'
import { combatMoveScalings, combatScalingIssues } from './combatValues.js'
import { combatStatusImmunityIssues } from './combatRestrictions.js'
import { combatConditionIssues, visitCombatCondition } from './combatConditions.js'
import { z } from 'zod'
import { gameIdSchema } from './game.js'
import {
  combatDefinitionSchema,
  combatFieldsSchema,
  combatMoveSchema,
  combatActorSchema,
  type CombatDefinition,
  type CombatMoveDefinition,
} from './combat.js'
import { combatStatusSchema, combatStatusApplicationIssues } from './combatAbilities.js'
import {
  combatRulesetSchema,
  combatRulesetLayerSchema,
  combatRulesetReferences,
  combatRulesetReferenceSchema,
  combatMechanicsOverridesSchema,
} from './combatRulesets.js'
import { resolveCombatRuleset, combatRulesetDependencies } from './combatRulesetResolution.js'
import { combatMechanicsReferenceIssues } from './combatMechanicsValidation.js'
import {
  combatAIProfileSchema,
  combatAIProfileReferenceSchema,
  combatAIOverridesSchema,
} from './combatAIProfiles.js'
import { resolveCombatEnemyAI } from './combatAIProfileResolution.js'
import { combatSimulationScenarioSchema } from './combatSimulationScenarios.js'
import { assertGraphicReference, graphicAppearanceSchema, type AssetCatalog } from './assets.js'
import type { GameTranslation } from './localization.js'
import type { InventoryDefinition } from './inventory.js'

const entryId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine(
    (id) => !['__proto__', 'constructor', 'prototype'].includes(id),
    'Reserved combat identifier',
  )

export const combatReferenceSchema = z.object({ library: gameIdSchema, id: entryId })

export const combatActorSourceSchema = combatActorSchema
  .safeExtend({
    aiProfile: combatAIProfileReferenceSchema.nullable().optional(),
    aiOverrides: combatAIOverridesSchema.optional(),
  })
  .superRefine((actor, context) => {
    if (actor.aiProfile && actor.ai)
      context.addIssue({
        code: 'custom',
        path: ['ai'],
        message: 'Use aiOverrides with an AI profile, or inline ai without a profile',
      })

    if (actor.aiOverrides && !actor.aiProfile)
      context.addIssue({
        code: 'custom',
        path: ['aiOverrides'],
        message: 'AI overrides require a profile',
      })
  })

export type CombatActorSource = z.infer<typeof combatActorSourceSchema>

export const combatSourceSchema = combatFieldsSchema
  .extend({
    player: combatActorSourceSchema,
    enemies: z.array(combatActorSourceSchema).min(1).max(32),
    moves: z.record(entryId, combatMoveSchema).default({}),
    sharedMoves: z.array(combatReferenceSchema).optional(),
    sharedStatuses: z.array(combatReferenceSchema).optional(),
    ruleset: combatRulesetReferenceSchema.nullable().optional(),
    rulesets: z
      .array(combatRulesetLayerSchema)
      .max(16)
      .refine(
        (layers) =>
          new Set(layers.map((layer) => `${layer.library}/${layer.id}`)).size === layers.length,
        'Composed rulesets must be unique',
      )
      .optional(),
    mechanicsOverrides: combatMechanicsOverridesSchema.optional(),
    simulationScenarios: z
      .record(entryId, combatSimulationScenarioSchema)
      .refine(
        (entries) => Object.keys(entries).length <= 100,
        'At most 100 simulation scenarios are supported',
      )
      .optional(),
  })
  .superRefine((source, context) => {
    if (source.player.aiProfile || source.player.aiOverrides)
      context.addIssue({
        code: 'custom',
        path: ['player', 'aiProfile'],
        message: 'AI profiles are only supported for enemies',
      })

    if (source.ruleset && source.rulesets !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['rulesets'],
        message: 'Use ruleset or rulesets, not both',
      })
    const linked = combatRulesetReferences(source).length > 0

    if (linked && source.mechanics)
      context.addIssue({
        code: 'custom',
        path: ['mechanics'],
        message: 'Use mechanicsOverrides with a ruleset, or inline mechanics without a ruleset',
      })

    if (source.mechanicsOverrides && !linked)
      context.addIssue({
        code: 'custom',
        path: ['mechanicsOverrides'],
        message: 'Mechanics overrides require a ruleset',
      })
  })

export function moveStatusIds(move: CombatMoveDefinition): string[] {
  const ids = new Set<string>()

  for (const condition of move.requirements ?? [])
    visitCombatCondition(condition, (leaf) => {
      if ('status' in leaf) ids.add(leaf.status)
    })

  for (const { scaling } of combatMoveScalings(move))
    for (const term of scaling.terms) if (term.type === 'status') ids.add(term.status)

  if (move.type === 'ability')
    for (const effect of move.effects) {
      if ('status' in effect) ids.add(effect.status)

      for (const condition of effect.conditions ?? [])
        visitCombatCondition(condition, (leaf) => {
          if ('status' in leaf) ids.add(leaf.status)
        })
    }

  return [...ids]
}

export const combatLibrarySchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    moves: z.record(entryId, combatMoveSchema).default({}),
    statuses: z.record(entryId, combatStatusSchema).default({}),
    passives: z
      .record(entryId, combatPassiveSchema)
      .refine(
        (entries) => Object.keys(entries).length <= 100,
        'At most 100 passives per library are supported',
      )
      .optional(),
    rulesets: z
      .record(entryId, combatRulesetSchema)
      .refine((entries) => Object.keys(entries).length <= 100, 'At most 100 rulesets are supported')
      .optional(),
    aiProfiles: z
      .record(entryId, combatAIProfileSchema)
      .refine(
        (entries) => Object.keys(entries).length <= 100,
        'At most 100 AI profiles are supported',
      )
      .optional(),
  })
  .superRefine((library, context) => {
    for (const [id, passive] of Object.entries(library.passives ?? {}))
      for (const issue of combatPassiveLibraryIssues(passive, library.moves, library.statuses))
        context.addIssue({
          code: 'custom',
          path: ['passives', id, ...issue.path],
          message: issue.message,
        })

    for (const [id, status] of Object.entries(library.statuses))
      for (const issue of combatStatusImmunityIssues(status, library.statuses, ['statuses', id]))
        context.addIssue({ code: 'custom', ...issue })

    for (const [id, move] of Object.entries(library.moves)) {
      for (const [index, condition] of (move.requirements ?? []).entries())
        for (const issue of combatConditionIssues(condition, { statuses: library.statuses }, [
          'moves',
          id,
          'requirements',
          index,
        ]))
          context.addIssue({ code: 'custom', ...issue })

      for (const resource of Object.keys(move.resourceCostScaling ?? {}))
        if (!Object.hasOwn(move.resourceCosts ?? {}, resource))
          context.addIssue({
            code: 'custom',
            path: ['moves', id, 'resourceCostScaling', resource],
            message: 'Scaling requires a declared resource cost',
          })

      for (const { scaling, path } of combatMoveScalings(move))
        for (const issue of combatScalingIssues(scaling, { statuses: library.statuses }, [
          'moves',
          id,
          ...path,
        ]))
          context.addIssue({ code: 'custom', ...issue })
    }

    for (const [id, move] of Object.entries(library.moves))
      if (move.type === 'ability')
        for (const [index, effect] of move.effects.entries())
          for (const [conditionIndex, condition] of (effect.conditions ?? []).entries())
            for (const issue of combatConditionIssues(condition, { statuses: library.statuses }, [
              'moves',
              id,
              'effects',
              index,
              'conditions',
              conditionIndex,
            ]))
              context.addIssue({ code: 'custom', ...issue })

    for (const [id, profile] of Object.entries(library.aiProfiles ?? {}))
      for (const [index, rule] of profile.ai.rules.entries()) {
        const path = ['aiProfiles', id, 'ai', 'rules', index]

        if (!Object.hasOwn(library.moves, rule.move))
          context.addIssue({
            code: 'custom',
            path: [...path, 'move'],
            message: `Unknown profile move: ${rule.move}`,
          })

        for (const [index, condition] of rule.conditions.entries())
          for (const issue of combatConditionIssues(
            condition,
            { actors: profile.actors, statuses: library.statuses },
            [...path, 'conditions', index],
          ))
            context.addIssue({ code: 'custom', ...issue })
      }

    for (const [id, move] of Object.entries(library.moves))
      if (move.type === 'ability')
        for (const [index, effect] of move.effects.entries())
          if (effect.type === 'apply-status' || effect.type === 'remove-status') {
            const status = library.statuses[effect.status]

            if (status)
              for (const issue of combatStatusApplicationIssues(effect, status))
                context.addIssue({
                  code: 'custom',
                  path: ['moves', id, 'effects', index, ...issue.path],
                  message: issue.message,
                })
          }

    for (const [id, ruleset] of Object.entries(library.rulesets ?? {}))
      for (const issue of combatMechanicsReferenceIssues({
        mechanics: ruleset.mechanics,
        actors: ruleset.actors,
        moves: library.moves,
        statuses: library.statuses,
        enemyMoves: new Map(ruleset.actors.map((role) => [role, Object.keys(library.moves)])),
      }))
        context.addIssue({
          code: 'custom',
          path: ['rulesets', id, ...issue.path],
          message: issue.message,
        })

    for (const [id, move] of Object.entries(library.moves))
      for (const status of moveStatusIds(move))
        if (!Object.hasOwn(library.statuses, status))
          context.addIssue({
            code: 'custom',
            path: ['moves', id, 'effects'],
            message: `Unknown library status: ${status}`,
          })
  })

export type CombatSource = z.infer<typeof combatSourceSchema>

export type CombatLibrary = z.infer<typeof combatLibrarySchema>

export type CombatReference = z.infer<typeof combatReferenceSchema>

export const combatOriginSchema = z.object({
  file: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  library: gameIdSchema.optional(),
  ruleset: entryId.optional(),
})

export type CombatOrigin = z.infer<typeof combatOriginSchema>

export const combatMechanicsOriginsSchema = z.object({
  resources: z.record(z.string(), combatOriginSchema),
  triggers: z.record(z.string(), combatOriginSchema),
  phases: z.record(z.string(), combatOriginSchema),
})

export type CombatMechanicsOrigins = z.infer<typeof combatMechanicsOriginsSchema>

export const combatOriginsSchema = z.object({
  moves: z.record(z.string(), combatOriginSchema),
  statuses: z.record(z.string(), combatOriginSchema),
  mechanics: combatMechanicsOriginsSchema.optional(),
})

export type CombatOrigins = z.infer<typeof combatOriginsSchema>

export interface CombatLibraryIssue {
  file: string
  path: (string | number)[]
  message: string
}

export function combatLibraryFile(id: string): string {
  return `combat-libraries/${id}.json`
}

/** Definitions contain only JSON values. Session state must never be written into them. */
export function freezeCombatDefinition(definition: CombatDefinition): CombatDefinition {
  return freezeCombatData(definition)
}

function freezeCombatData<T>(definition: T): T {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return

    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }

  freeze(definition)

  return definition
}

/** Pure source-to-runtime resolution. Authored references are never materialized back into source. */
export function resolveCombatSource(
  source: CombatSource,
  libraries: ReadonlyMap<string, CombatLibrary>,
  file = `combat/${source.id}.json`,
  inventory?: InventoryDefinition,
) {
  const moves = { ...source.moves }
  const statuses = { ...source.statuses }
  const origins: CombatOrigins = { moves: {}, statuses: {} }
  const ruleset = resolveCombatRuleset(source, libraries, file)
  const issues: CombatLibraryIssue[] = [...ruleset.issues]

  if (ruleset.origins) origins.mechanics = ruleset.origins

  for (const id of Object.keys(moves)) origins.moves[id] = { file, path: ['moves', id] }

  for (const id of Object.keys(statuses)) origins.statuses[id] = { file, path: ['statuses', id] }

  const addStatus = (ref: CombatReference, path: (string | number)[]) => {
    const library = libraries.get(ref.library)
    const status = library?.statuses[ref.id]

    if (!status) {
      issues.push({
        file,
        path,
        message: `Missing shared status ${ref.library}/${ref.id} (${combatLibraryFile(ref.library)})`,
      })

      return
    }

    const old = origins.statuses[ref.id]

    if (old && old.library !== ref.library) {
      issues.push({
        file,
        path,
        message: `Status ID ${ref.id} conflicts with ${old.file}; imported from ${combatLibraryFile(ref.library)}`,
      })

      return
    }

    if (old?.library === ref.library) return

    statuses[ref.id] = status
    origins.statuses[ref.id] = {
      library: ref.library,
      file: combatLibraryFile(ref.library),
      path: ['statuses', ref.id],
      ...(path[0] === 'ruleset' && source.ruleset
        ? { ruleset: source.ruleset.id }
        : path[0] === 'rulesets' && typeof path[1] === 'number'
          ? { ruleset: source.rulesets?.[path[1]]?.id }
          : {}),
    }

    for (const id of status.statusImmunities ?? []) addStatus({ library: ref.library, id }, path)
  }

  const addMove = (
    ref: CombatReference,
    path: (string | number)[],
    implicit = false,
    localDependencies = false,
  ) => {
    const move = libraries.get(ref.library)?.moves[ref.id]

    if (!move) {
      issues.push({
        file,
        path,
        message: `Missing shared move ${ref.library}/${ref.id} (${combatLibraryFile(ref.library)})`,
      })

      return
    }

    if (Object.hasOwn(moves, ref.id)) {
      if (implicit && origins.moves[ref.id]?.library === ref.library) return
      issues.push({
        file,
        path,
        message: `Move ID ${ref.id} conflicts with ${origins.moves[ref.id]?.file}; imported from ${combatLibraryFile(ref.library)}`,
      })

      return
    }

    moves[ref.id] = move
    origins.moves[ref.id] = {
      library: ref.library,
      file: combatLibraryFile(ref.library),
      path: ['moves', ref.id],
      ...(path[0] === 'ruleset' && source.ruleset
        ? { ruleset: source.ruleset.id }
        : path[0] === 'rulesets' && typeof path[1] === 'number'
          ? { ruleset: source.rulesets?.[path[1]]?.id }
          : {}),
    }

    for (const id of moveStatusIds(move))
      if (!localDependencies || !Object.hasOwn(statuses, id))
        addStatus({ library: ref.library, id }, path)
  }

  for (const key of ['sharedMoves', 'sharedStatuses'] as const) {
    const seen = new Set<string>()

    for (const [index, ref] of (source[key] ?? []).entries()) {
      const path = [key, index]
      const identity = `${ref.library}/${ref.id}`

      if (seen.has(identity)) {
        issues.push({ file, path, message: `Duplicate shared reference: ${identity}` })
        continue
      }

      seen.add(identity)

      if (key === 'sharedStatuses') {
        addStatus(ref, path)
        continue
      }

      addMove(ref, path)
    }
  }

  for (const [index, type] of (source.itemUse?.itemTypes ?? []).entries()) {
    const use = inventory?.itemTypes[type]?.use
    const path = ['itemUse', 'itemTypes', index]

    if (!use || !use.contexts.includes('combat'))
      issues.push({ file, path, message: `Item type does not support combat use: ${type}` })
    else addMove(use.ability, path, true)
  }

  const equipmentMoves = new Map<string, string[]>()

  for (const [actorIndex, actor] of [source.player, ...source.enemies].entries()) {
    if (!actor.equipmentOwner) continue
    const ids = new Set<string>()

    for (const reference of combatEquipmentMoveReferences(inventory, actor.equipmentOwner)) {
      ids.add(reference.id)
      addMove(
        reference,
        actorIndex === 0
          ? ['player', 'equipmentOwner']
          : ['enemies', actorIndex - 1, 'equipmentOwner'],
        true,
      )
    }

    if (ids.size) equipmentMoves.set(actor.id, [...ids])
  }

  const enemies = source.enemies.map((enemy, index) => {
    const resolved = resolveCombatEnemyAI(enemy, [source.player, ...source.enemies], libraries)

    for (const issue of resolved.issues)
      issues.push({ file, path: ['enemies', index, ...issue.path], message: issue.message })

    if (enemy.aiProfile && resolved.ai) {
      const library = enemy.aiProfile.library
      const path = ['enemies', index, 'aiProfile']
      const definitions = libraries.get(library)

      // Available moves remain dependencies even when their conditional rule is excluded.
      // Another mechanics library may provide the other encounter moves later.
      const requiredMoves = new Set([
        ...enemy.moves.filter((id) => Object.hasOwn(definitions?.moves ?? {}, id)),
        ...resolved.ai.rules.map((rule) => rule.move),
      ])

      for (const id of requiredMoves) {
        if (!Object.hasOwn(moves, id)) addMove({ library, id }, path, true, true)
        else if (
          origins.moves[id]?.library &&
          origins.moves[id]?.library !== library &&
          Object.hasOwn(definitions?.moves ?? {}, id)
        )
          issues.push({
            file,
            path,
            message: `AI profile move ${id} conflicts with ${origins.moves[id]?.file}`,
          })

        if (origins.moves[id]?.library === library)
          for (const status of moveStatusIds(moves[id]!))
            if (origins.statuses[status]?.library && origins.statuses[status]?.library !== library)
              issues.push({
                file,
                path,
                message: `AI profile status ${status} conflicts with ${origins.statuses[status]?.file}`,
              })
      }

      for (const rule of resolved.ai.rules) {
        for (const condition of rule.conditions)
          visitCombatCondition(condition, (leaf) => {
            if ('status' in leaf) {
              if (!Object.hasOwn(statuses, leaf.status))
                addStatus({ library, id: leaf.status }, path)
              else if (
                origins.statuses[leaf.status]?.library &&
                origins.statuses[leaf.status]?.library !== library &&
                Object.hasOwn(definitions?.statuses ?? {}, leaf.status)
              )
                issues.push({
                  file,
                  path,
                  message: `AI profile status ${leaf.status} conflicts with ${origins.statuses[leaf.status]?.file}`,
                })
            }
          })
      }
    }

    return { ...enemy, ai: resolved.ai, equipmentMoves: equipmentMoves.get(enemy.id) }
  })

  const references = combatRulesetReferences(source)

  if (references.length && ruleset.mechanics) {
    const requireEntry = (kind: 'moves' | 'statuses', id: string, owner?: CombatOrigin) => {
      const existing = origins[kind][id]

      const candidates = references.filter((reference) =>
        Object.hasOwn(libraries.get(reference.library)?.[kind] ?? {}, id),
      )

      const preferred =
        candidates.find(
          (reference) => reference.library === owner?.library && reference.id === owner?.ruleset,
        ) ?? candidates.find((reference) => reference.library === owner?.library)

      const suppliers = [...new Set(candidates.map((reference) => reference.library))]

      const path = owner?.ruleset
        ? source.rulesets
          ? [
              'rulesets',
              references.findIndex(
                (reference) =>
                  reference.library === owner.library && reference.id === owner.ruleset,
              ),
            ]
          : ['ruleset']
        : ['mechanicsOverrides']

      if (existing) {
        if (existing.library && preferred && existing.library !== preferred.library)
          issues.push({
            file,
            path,
            message: `Ruleset ${kind === 'moves' ? 'move' : 'status'} ${id} conflicts with ${existing.file}; required by ${owner?.library}/${owner?.ruleset}`,
          })

        return
      }

      if (!preferred && suppliers.length !== 1) {
        issues.push({
          file,
          path,
          message: suppliers.length
            ? `Ambiguous ruleset ${kind === 'moves' ? 'move' : 'status'} ${id}: supplied by ${suppliers.join(', ')}; import it explicitly`
            : `Missing shared ${kind === 'moves' ? 'move' : 'status'}: ${id}`,
        })

        return
      }

      const reference = preferred ?? candidates[0]!

      const dependencyPath = source.rulesets
        ? ['rulesets', references.indexOf(reference)]
        : ['ruleset']

      if (kind === 'statuses') addStatus({ library: reference.library, id }, dependencyPath)
      else {
        addMove({ library: reference.library, id }, dependencyPath, true, true)

        for (const status of moveStatusIds(moves[id]!)) {
          const previous = origins.statuses[status]

          if (previous?.library && previous.library !== reference.library)
            issues.push({
              file,
              path: dependencyPath,
              message: `Ruleset move ${id} requires status ${status} from ${reference.library}, conflicting with ${previous.file}`,
            })
        }
      }
    }

    // Attribute dependencies to the effective entry's supplying layer, after replacements/exclusions.
    for (const section of ['triggers', 'phases'] as const)
      for (const [id, entry] of Object.entries(ruleset.mechanics[section])) {
        const part = { ...ruleset.mechanics, triggers: {}, phases: {}, [section]: { [id]: entry } }
        const dependencies = combatRulesetDependencies(part)
        const owner = ruleset.baseOrigins[section][id]

        for (const status of dependencies.statuses) requireEntry('statuses', status, owner)

        for (const move of dependencies.moves) requireEntry('moves', move, owner)
      }

    for (const actor of [source.player, ...source.enemies])
      for (const move of actor.moves) requireEntry('moves', move)
  }

  const passiveDefinitions: CombatPassiveDefinitions = {}
  const pending = Object.values(statuses).flatMap((status) => status.passives ?? [])

  for (const actor of [source.player, ...source.enemies])
    pending.push(...combatEquipmentPassiveReferences(inventory, actor.equipmentOwner))
  const seenPassives = new Set<string>()

  while (pending.length) {
    const reference = pending.shift()!
    const identity = `${reference.library}/${reference.id}`

    if (seenPassives.has(identity)) continue
    seenPassives.add(identity)

    if (seenPassives.size > 1000) {
      issues.push({
        file,
        path: ['passiveDefinitions'],
        message: 'Passive dependency limit exceeded',
      })
      break
    }

    const passive = libraries.get(reference.library)?.passives?.[reference.id]

    if (!passive) {
      issues.push({
        file,
        path: ['passiveDefinitions'],
        message: `Missing shared passive: ${identity}`,
      })
      continue
    }

    ;(passiveDefinitions[reference.library] ??= {})[reference.id] = passive

    const dependencies = combatRulesetDependencies({
      resources: {},
      phases: {},
      triggers: passive.triggers,
      victory: 'enemies-defeated',
    })

    const checkProvider = (kind: 'moves' | 'statuses', id: string) => {
      const previous = origins[kind][id]

      if (previous?.library && previous.library !== reference.library)
        issues.push({
          file,
          path: ['passiveDefinitions', reference.library, reference.id],
          message: `Passive ${identity} requires ${kind} ${id} from ${reference.library}, conflicting with ${previous.file}`,
        })
    }

    for (const kind of ['moves', 'statuses'] as const)
      for (const id of dependencies[kind]) {
        checkProvider(kind, id)

        if (kind === 'moves') {
          if (!Object.hasOwn(moves, id))
            addMove(
              { library: reference.library, id },
              ['passiveDefinitions', reference.library, reference.id],
              true,
              true,
            )

          if (origins.moves[id]?.library === reference.library)
            for (const status of moveStatusIds(moves[id]!)) checkProvider('statuses', status)
        } else if (!Object.hasOwn(statuses, id))
          addStatus({ library: reference.library, id }, [
            'passiveDefinitions',
            reference.library,
            reference.id,
          ])
      }

    for (const status of Object.values(statuses))
      for (const reference of status.passives ?? [])
        if (
          !seenPassives.has(`${reference.library}/${reference.id}`) &&
          !pending.some((entry) => entry.library === reference.library && entry.id === reference.id)
        )
          pending.push(reference)
  }

  const resolved = combatDefinitionSchema.safeParse({
    ...source,
    passiveDefinitions: Object.keys(passiveDefinitions).length ? passiveDefinitions : undefined,
    player: { ...source.player, equipmentMoves: equipmentMoves.get(source.player.id) },
    enemies,
    moves,
    statuses,
    mechanics: ruleset.mechanics,
  })

  if (!resolved.success)
    for (const issue of resolved.error.issues)
      issues.push({
        file,
        path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
        message: issue.message,
      })

  return {
    definition:
      !issues.length && resolved.success ? freezeCombatDefinition(resolved.data) : undefined,
    origins,
    issues,
  }
}

export function localizeCombatLibrary(
  library: CombatLibrary,
  translation?: GameTranslation,
): CombatLibrary {
  const text = (key: string | undefined, literal: string) =>
    key ? (translation?.messages[key] ?? translation?.fallback[key] ?? literal) : literal

  const entries = <
    T extends {
      label: string
      labelKey?: string | undefined
      description: string
      descriptionKey?: string | undefined
    },
  >(
    values: Record<string, T>,
  ) =>
    Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        id,
        {
          ...value,
          label: text(value.labelKey, value.label),
          description: text(value.descriptionKey, value.description),
        },
      ]),
    )

  return freezeCombatData(
    combatLibrarySchema.parse({
      ...library,
      moves: entries(library.moves),
      statuses: entries(library.statuses),
      ...(library.aiProfiles && { aiProfiles: entries(library.aiProfiles) }),
      ...(library.passives && { passives: entries(library.passives) }),
      ...(library.rulesets && {
        rulesets: Object.fromEntries(
          Object.entries(entries(library.rulesets)).map(([id, ruleset]) => [
            id,
            {
              ...ruleset,
              mechanics: {
                ...ruleset.mechanics,
                resources: entries(ruleset.mechanics.resources),
                phases: entries(ruleset.mechanics.phases),
              },
            },
          ]),
        ),
      }),
    }),
  )
}

/** Validate every library entry, including definitions not yet imported by any encounter. */
export function combatLibraryIssues(
  library: CombatLibrary,
  assets?: AssetCatalog,
  translation?: GameTranslation,
): CombatLibraryIssue[] {
  const issues: CombatLibraryIssue[] = []
  const file = combatLibraryFile(library.id)

  for (const [id, profile] of Object.entries(library.aiProfiles ?? {}))
    for (const key of ['labelKey', 'descriptionKey'] as const)
      if (profile[key] && (!translation || !Object.hasOwn(translation.fallback, profile[key])))
        issues.push({
          file,
          path: ['aiProfiles', id, key],
          message: `Missing combat translation: ${profile[key]}`,
        })

  for (const [id, ruleset] of Object.entries(library.rulesets ?? {})) {
    const entries = [
      { entry: ruleset, path: ['rulesets', id] },
      ...(['resources', 'phases'] as const).flatMap((section) =>
        Object.entries(ruleset.mechanics[section]).map(([key, entry]) => ({
          entry,
          path: ['rulesets', id, 'mechanics', section, key],
        })),
      ),
    ]

    for (const { entry, path } of entries)
      for (const key of ['labelKey', 'descriptionKey'] as const)
        if (entry[key] && (!translation || !Object.hasOwn(translation.fallback, entry[key])))
          issues.push({
            file,
            path: [...path, key],
            message: `Missing combat translation: ${entry[key]}`,
          })
  }

  for (const kind of ['moves', 'statuses'] as const)
    for (const [id, entry] of Object.entries(library[kind])) {
      for (const key of ['labelKey', 'descriptionKey'] as const)
        if (entry[key] && (!translation || !Object.hasOwn(translation.fallback, entry[key])))
          issues.push({
            file,
            path: [kind, id, key],
            message: `Missing combat translation: ${entry[key]}`,
          })

      if ('icon' in entry && entry.icon)
        try {
          if (!assets) throw new Error('Status icons require an asset catalogue')
          assertGraphicReference(assets, entry.icon, graphicAppearanceSchema.parse({}))
        } catch (error) {
          issues.push({
            file,
            path: [kind, id, 'icon'],
            message: error instanceof Error ? error.message : String(error),
          })
        }
    }

  return issues
}
