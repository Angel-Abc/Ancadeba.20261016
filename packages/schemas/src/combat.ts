import { combatDamageTypeSchema, combatDamageDefensesSchema } from './combatDamage.js'
import {
  combatMoveCategoriesSchema,
  combatRestrictionFields,
  combatStatusImmunityIssues,
} from './combatRestrictions.js'
import { combatScalingSchema } from './combatValues.js'
import { combatConditionIssues } from './combatConditions.js'
import { z } from 'zod'
import { combatMechanicsSchema } from './combatMechanics.js'
import { combatEnemyAISchema } from './combatEnemyAI.js'
import { combatMechanicsIssues } from './combatMechanicsValidation.js'
import { combatItemUseIssues } from './itemUseValidation.js'
import { combatItemUseSchema } from './itemUse.js'
import {
  abilityEffectSchema,
  combatStatusSchema,
  combatStatusApplicationIssues,
} from './combatAbilities.js'
import { gameBindingSchema, bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import { assertGraphicReference, graphicAppearanceSchema, type AssetCatalog } from './assets.js'
import type { GameRulesDefinition } from './rules.js'
import type { GameTranslation } from './localization.js'
import { victoryRewardsSchema, combatRewardIssues } from './combatRewards.js'
import type { InventoryDefinition } from './inventory.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()

const label = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
}

const moveCategories = { categories: combatMoveCategoriesSchema.optional() }

const resourceCosts = z.record(id, amount.positive()).optional()

export const combatHealthSchema = gameBindingSchema.safeExtend({
  source: z.literal('game.state'),
  path: z
    .array(id.refine((part) => !['__proto__', 'constructor', 'prototype'].includes(part)))
    .min(1),
})

export const combatMoveSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('attack'),
      ...moveCategories,
      damageType: combatDamageTypeSchema.optional(),
      scaling: combatScalingSchema.optional(),
      resourceCosts,
      apCostScaling: combatScalingSchema.optional(),
      resourceCostScaling: z.record(id, combatScalingSchema).optional(),
      ...label,
      apCost: z.number().int().positive().max(100),
      cooldown: amount.optional(),
      damage: z
        .object({ min: amount, max: amount })
        .refine((range) => range.min <= range.max, 'Minimum damage must not exceed maximum damage'),
    }),
    z.object({
      type: z.literal('guard'),
      ...moveCategories,
      scaling: combatScalingSchema.optional(),
      resourceCosts,
      apCostScaling: combatScalingSchema.optional(),
      resourceCostScaling: z.record(id, combatScalingSchema).optional(),
      ...label,
      apCost: z.number().int().positive().max(100),
      guard: amount,
      cooldown: amount.optional(),
    }),
    z.object({
      type: z.literal('ability'),
      ...moveCategories,
      resourceCosts,
      apCostScaling: combatScalingSchema.optional(),
      resourceCostScaling: z.record(id, combatScalingSchema).optional(),
      ...label,
      apCost: z.number().int().positive().max(100),
      cooldown: amount.optional(),
      target: z.enum(['self', 'enemy']),
      effects: z
        .array(abilityEffectSchema)
        .min(1)
        .max(20)
        .refine(
          (effects) => new Set(effects.map((effect) => effect.id)).size === effects.length,
          'Effect IDs must be unique',
        ),
    }),
  ])
  .refine((move) => Boolean(move.label || move.labelKey), 'A move label or translation is required')

export const combatActorSchema = z
  .object({
    id,
    ...label,
    portrait: id.optional(),
    equipmentOwner: id.optional(),
    damageDefenses: combatDamageDefensesSchema.optional(),
    ...combatRestrictionFields,
    leveling: id.optional(),
    moveLevels: z.record(id, z.number().int().positive().safe()).optional(),
    health: combatHealthSchema,
    maximumHealth: z.union([z.number().int().nonnegative().safe(), gameBindingSchema]),
    ap: z.number().int().positive().max(100).default(3),
    moves: z
      .array(id)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length),
    rotation: z.array(id).default([]),
    ai: combatEnemyAISchema.optional(),
  })
  .refine(
    (actor) => Boolean(actor.label || actor.labelKey),
    'An actor label or translation is required',
  )
  .refine(
    (actor) =>
      typeof actor.maximumHealth !== 'number' ||
      actor.maximumHealth > 0 ||
      Boolean(actor.equipmentOwner),
    'Maximum health must be positive without an equipment profile',
  )

export const combatTextSchema = z.object({
  statusImmune: z.string().default('{target} is immune to {status}.'),
  moveRestricted: z.string().default('{actor}: {move} is blocked ({category}).'),
  statusImmunities: z.string().default('Status immunities: {statuses}'),
  blockedMoveCategories: z.string().default('Blocked move categories: {categories}'),
  reaction: z.string().default('Reaction'),
  typedAttack: z
    .string()
    .default(
      '{actor} attacks {target}: {damage} {damageType} damage ({resisted} resisted, {amplified} extra, {defended} defense, {blocked} Guard).',
    ),
  typedPeriodicDamage: z
    .string()
    .default(
      '{target}: {status} deals {amount} {damageType} damage ({resisted} resisted, {amplified} extra).',
    ),
  damageImmunity: z.string().default('Immune to {damageType}.'),
  damageResistance: z.string().default('{damageType}: resistance {resistance}%'),
  damageVulnerability: z.string().default('{damageType}: vulnerability {vulnerability}%'),
  typedDamagePreview: z.string().default('{amount} {damageType}'),
  statDamage: z.string().default('Damage'),
  statHealing: z.string().default('Healing'),
  statAp: z.string().default('AP budget'),
  statApCost: z.string().default('Action AP cost'),
  statusStrength: z.string().default('Stacks: {stacks} · Intensity: {intensity}'),
  removeStacks: z.string().default('Remove {stacks} stacks of {status}'),
  statusReduced: z.string().default('{target}: {status} reduced to {stacks} stacks.'),
  apUnavailable: z.string().default('{actor}: {move} needs {cost} AP ({remaining} available).'),
  resourceChanged: z.string().default('{resource}: {amount}'),
  phaseChanged: z.string().default('Phase: {phase}'),
  resourceUnavailable: z.string().default('{actor}: requires more {resource}.'),
  resourceEffect: z.string().default('{resource}: {amount}'),
  resourceCost: z.string().default('{resource}: costs {amount}'),
  itemUsed: z.string().default('{actor} uses {item}.'),
  itemSkipped: z.string().default('{actor}: {item} had no effect.'),
  statAttack: z.string().default('Attack bonus'),
  statDefense: z.string().default('Defense'),
  statGuard: z.string().default('Guard bonus'),
  healed: z.string().default('{actor} restores {amount} health to {target}.'),
  statusApplied: z.string().default('{target}: {status} applied ({duration} turns).'),
  statusRefreshed: z.string().default('{target}: {status} refreshed ({duration} turns).'),
  statusRemoved: z.string().default('{target}: {status} removed.'),
  statusExpired: z.string().default('{target}: {status} expired.'),
  periodicDamage: z.string().default('{target}: {status} deals {amount} damage.'),
  regenerated: z.string().default('{target}: {status} restores {amount} health.'),
  stunned: z.string().default('{actor} is stunned and skips this turn.'),
  cooldown: z.string().default('Cooldown: {rounds} rounds'),
  reserved: z.string().default('Already queued'),
  conditionalEffect: z.string().default('Conditional effect'),
  conditional: z
    .string()
    .default('Previews use current effects; earlier moves may change the result.'),
  enemyConditional: z
    .string()
    .default('Enemy plans are previews. Conditional enemies choose again before each action.'),
  turnsRemaining: z.string().default('{turns} turns remaining'),
  healing: z.string().default('Heal {amount}'),
  mitigated: z
    .string()
    .default(
      '{actor} attacks {target}: {damage} damage, {defended} prevented by defense, {blocked} absorbed by Guard.',
    ),
  requiresLevel: z.string().default('Requires level {level}'),
  planning: z.string().default('Planning'),
  target: z.string().default('Target'),
  round: z.string().default('Round'),
  health: z.string().default('Health'),
  guard: z.string().default('Guard'),
  ap: z.string().default('AP'),
  empty: z.string().default('No moves selected.'),
  escape: z.string().default('Escape'),
  victory: z.string().default('Victory'),
  defeat: z.string().default('Defeat'),
  escaped: z.string().default('Escaped'),
  attack: z.string().default('{actor} attacks {target}: {damage} damage, {blocked} blocked.'),
  guarded: z.string().default('{actor} gains {guard} guard.'),
  skipped: z.string().default('{actor}: target {target} is already defeated.'),
  unavailable: z
    .string()
    .default('Combat is unavailable: check health, state access, or progression.'),
  invalid: z.string().default('The command is no longer available.'),
  rewardsPending: z.string().default('Rewards pending: {reason}'),
  rewardsDelivered: z.string().default('Victory rewards received.'),
  rewardAmount: z.string().default('{label}: +{amount}'),
  lootRemaining: z.string().default('Loot remaining: {count}'),
  lootTaken: z.string().default('Collected: {items}'),
  rewardUnavailable: z.string().default('Reward delivery is unavailable.'),
  rewardInvalidAmount: z.string().default('A reward field is invalid or would overflow.'),
  rewardInventory: z.string().default('Loot could not be created or transferred.'),
})

export const combatFieldsSchema = z.object({
  'schema-version': z.literal('1.0.0'),
  id,
  ...label,
  player: combatActorSchema,
  enemies: z.array(combatActorSchema).min(1).max(32),
  moves: z.record(id, combatMoveSchema),
  mechanics: combatMechanicsSchema.optional(),
  statuses: z
    .record(id, combatStatusSchema)
    .refine((statuses) => Object.keys(statuses).length <= 100, 'At most 100 statuses are supported')
    .optional(),
  seed: z.number().int().min(1).max(0xffffffff).default(1),
  allowEscape: z.boolean().default(false),
  roundTimeMs: amount.default(0),
  rewards: victoryRewardsSchema.optional(),
  itemUse: combatItemUseSchema.optional(),
  logCapacity: z.number().int().positive().max(1000).default(100),
  outcomes: z
    .object({ victory: id.optional(), defeat: id.optional(), escaped: id.optional() })
    .default({}),
  messages: combatTextSchema.prefault({}),
  messageKeys: z
    .partialRecord(z.enum(combatTextSchema.keyof().options), translationKeySchema)
    .default({}),
})

export const combatDefinitionSchema = combatFieldsSchema.superRefine((combat, context) => {
  for (const issue of combatMechanicsIssues(combat)) context.addIssue({ code: 'custom', ...issue })

  if (!combat.label && !combat.labelKey)
    context.addIssue({
      code: 'custom',
      path: ['label'],
      message: 'An encounter label or translation is required',
    })
  const actors = [combat.player, ...combat.enemies]

  for (const [index, actor] of actors.entries())
    for (const issue of combatStatusImmunityIssues(
      actor,
      combat.statuses ?? {},
      index === 0 ? ['player'] : ['enemies', index - 1],
    ))
      context.addIssue({ code: 'custom', ...issue })

  for (const [id, status] of Object.entries(combat.statuses ?? {}))
    for (const issue of combatStatusImmunityIssues(status, combat.statuses ?? {}, ['statuses', id]))
      context.addIssue({ code: 'custom', ...issue })

  for (const [moveId, move] of Object.entries(combat.moves))
    if (move.type === 'ability')
      for (const [index, effect] of move.effects.entries()) {
        if (effect.type === 'apply-status' || effect.type === 'remove-status') {
          const status = combat.statuses?.[effect.status]

          if (status)
            for (const issue of combatStatusApplicationIssues(effect, status))
              context.addIssue({
                code: 'custom',
                path: ['moves', moveId, 'effects', index, ...issue.path],
                message: issue.message,
              })
        }

        if (
          (effect.type === 'apply-status' || effect.type === 'remove-status') &&
          !Object.hasOwn(combat.statuses ?? {}, effect.status)
        )
          context.addIssue({
            code: 'custom',
            path: ['moves', moveId, 'effects', index, 'status'],
            message: 'Unknown combat status',
          })
      }

  if (new Set(actors.map((actor) => actor.id)).size !== actors.length)
    context.addIssue({
      code: 'custom',
      path: ['enemies'],
      message: 'Combat actor IDs must be unique',
    })

  if (new Set(actors.map((actor) => JSON.stringify(actor.health.path))).size !== actors.length)
    context.addIssue({
      code: 'custom',
      path: ['enemies'],
      message: 'Combat health fields must be distinct',
    })

  for (const actor of actors) {
    if (actor.ai && actor === combat.player)
      context.addIssue({
        code: 'custom',
        path: ['player', 'ai'],
        message: 'AI is only supported for enemies',
      })

    for (const [index, rule] of (actor.ai?.rules ?? []).entries()) {
      const path = ['enemies', combat.enemies.indexOf(actor), 'ai', 'rules', index]

      if (!actor.moves.includes(rule.move))
        context.addIssue({
          code: 'custom',
          path: [...path, 'move'],
          message: 'Enemy rules must use that actor’s available moves',
        })

      for (const [index, condition] of rule.conditions.entries())
        for (const issue of combatConditionIssues(
          condition,
          {
            actors: actors.map((actor) => actor.id),
            resources: combat.mechanics?.resources ?? {},
            statuses: combat.statuses ?? {},
            phases: combat.mechanics?.phases ?? {},
          },
          [...path, 'conditions', index],
        ))
          context.addIssue({ code: 'custom', ...issue })
    }

    for (const move of actor.moves)
      if (!Object.hasOwn(combat.moves, move))
        context.addIssue({
          code: 'custom',
          path: ['moves'],
          message: `Unknown combat move: ${move}`,
        })

    if (
      actor !== combat.player &&
      ((!actor.rotation.length && actor.ai?.fallback !== 'wait') ||
        actor.rotation.some((move) => !actor.moves.includes(move)))
    )
      context.addIssue({
        code: 'custom',
        path: ['enemies'],
        message: 'Enemy rotations must use that actor’s available moves',
      })
  }
})

export type CombatDefinition = z.infer<typeof combatDefinitionSchema>

export type CombatActorDefinition = z.infer<typeof combatActorSchema>

export type CombatMoveDefinition = z.infer<typeof combatMoveSchema>

export const combatCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queue-move'), move: id }),
  z.object({ type: z.literal('queue-item'), item: id, inventory: id.optional() }),
  ...(
    [
      'previous-target',
      'next-target',
      'undo',
      'clear',
      'end-turn',
      'escape',
      'continue',
      'take-loot',
      'take-all-loot',
      'retry-rewards',
    ] as const
  ).map((type) => z.object({ type: z.literal(type) })),
])

export type CombatCommand = z.infer<typeof combatCommandSchema>

export function combatFile(id: string): string {
  return `combat/${id}.json`
}

export function combatIssues(
  combat: CombatDefinition,
  rules: GameRulesDefinition | undefined,
  scenes: ReadonlySet<string>,
  assets?: AssetCatalog,
  inventory?: InventoryDefinition,
): { path: (string | number)[]; message: string }[] {
  const issues: ReturnType<typeof combatIssues> = []

  for (const [id, status] of Object.entries(combat.statuses ?? {}))
    if (status.icon)
      try {
        if (!assets) throw new Error('Status icons require an asset catalogue')
        assertGraphicReference(assets, status.icon, graphicAppearanceSchema.parse({}))
      } catch (error) {
        issues.push({
          path: ['statuses', id, 'icon'],
          message: error instanceof Error ? error.message : String(error),
        })
      }

  for (const actor of [combat.player, ...combat.enemies]) {
    for (const binding of [
      actor.health,
      ...(typeof actor.maximumHealth === 'object' ? [actor.maximumHealth] : []),
    ]) {
      if (
        binding.source === 'game.state' &&
        !rules?.state.some(
          (field) =>
            typeof field.value === 'number' &&
            JSON.stringify(field.path) === JSON.stringify(binding.path),
        )
      )
        issues.push({
          path: ['health'],
          message: `Combat requires declared numeric fields: ${binding.path.join('.')}`,
        })
    }

    if (actor.portrait)
      try {
        if (!assets) throw new Error('Combat portraits require an asset catalogue')
        assertGraphicReference(assets, actor.portrait, graphicAppearanceSchema.parse({}))
      } catch (error) {
        issues.push({
          path: ['portrait'],
          message: error instanceof Error ? error.message : String(error),
        })
      }
  }

  for (const destination of Object.values(combat.outcomes))
    if (destination && !scenes.has(destination))
      issues.push({ path: ['outcomes'], message: `Unknown combat destination: ${destination}` })

  return [
    ...issues,
    ...combatItemUseIssues(combat, inventory),
    ...combatRewardIssues(combat, rules, inventory, assets),
  ]
}

export function localizeCombat(
  combat: CombatDefinition,
  translation?: GameTranslation,
): CombatDefinition {
  const text = (key: string | undefined, literal: string) => {
    if (!key) return literal

    if (!translation || !Object.hasOwn(translation.fallback, key))
      throw new Error(`Missing combat translation: ${key}`)
    const value = translation.messages[key] ?? translation.fallback[key]!

    return value
  }

  const presentation = (entry: {
    label: string
    labelKey?: string | undefined
    description: string
    descriptionKey?: string | undefined
  }) => ({
    label: text(entry.labelKey, entry.label),
    description: text(entry.descriptionKey, entry.description),
  })

  return combatDefinitionSchema.parse({
    ...combat,
    ...presentation(combat),
    ...(combat.mechanics && {
      mechanics: {
        ...combat.mechanics,
        resources: Object.fromEntries(
          Object.entries(combat.mechanics.resources).map(([id, entry]) => [
            id,
            { ...entry, ...presentation(entry) },
          ]),
        ),
        phases: Object.fromEntries(
          Object.entries(combat.mechanics.phases).map(([id, entry]) => [
            id,
            { ...entry, ...presentation(entry) },
          ]),
        ),
      },
    }),
    ...(combat.statuses && {
      statuses: Object.fromEntries(
        Object.entries(combat.statuses).map(([id, status]) => [
          id,
          {
            ...status,
            label: text(status.labelKey, status.label),
            description: text(status.descriptionKey, status.description),
          },
        ]),
      ),
    }),
    ...(combat.rewards && {
      rewards: {
        ...combat.rewards,
        numeric: combat.rewards.numeric.map((entry) => ({
          ...entry,
          label: text(entry.labelKey, entry.label),
        })),
      },
    }),
    player: { ...combat.player, ...presentation(combat.player) },
    enemies: combat.enemies.map((actor) => ({ ...actor, ...presentation(actor) })),
    moves: Object.fromEntries(
      Object.entries(combat.moves).map(([id, move]) => [id, { ...move, ...presentation(move) }]),
    ),
    messages: Object.fromEntries(
      combatTextSchema
        .keyof()
        .options.map((key) => [key, text(combat.messageKeys[key], combat.messages[key])]),
    ),
  })
}
