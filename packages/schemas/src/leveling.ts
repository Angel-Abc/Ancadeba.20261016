import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { gameBindingSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import type { GameTranslation } from './localization.js'
import type { GameRulesDefinition } from './rules.js'
import type { CombatDefinition } from './combat.js'
import type { InventoryDefinition } from './inventory.js'
import type { AssetCatalog } from './assets.js'
import type { SceneDefinition } from './scene.js'

export const levelingFieldSchema = gameBindingSchema.safeExtend({
  source: z.literal('game.state'),
  path: z
    .array(
      gameIdSchema.refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
    )
    .min(1),
})

export const levelGainSchema = z
  .object({
    id: gameIdSchema,
    label: z.string().default(''),
    labelKey: translationKeySchema.optional(),
    field: levelingFieldSchema,
    amount: z.number().int().nonnegative().safe(),
  })
  .refine(
    (value) => Boolean(value.label || value.labelKey),
    'A stat label or translation is required',
  )

export const levelingTextSchema = z.object({
  level: z.string().default('Level'),
  xp: z.string().default('XP'),
  next: z.string().default('Next level'),
  capped: z.string().default('Maximum level'),
  unavailable: z
    .string()
    .default('Character progression is unavailable: check its fields and state adapter.'),
  gained: z.string().default('Reached level {level}.'),
  stat: z.string().default('{label}: +{amount}'),
  unlocked: z.string().default('Unlocked: {move}'),
})

export const levelingProfileSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    label: z.string().default(''),
    labelKey: translationKeySchema.optional(),
    xp: levelingFieldSchema,
    level: levelingFieldSchema,
    levels: z
      .array(
        z.object({
          xp: z.number().int().nonnegative().safe(),
          gains: z.array(levelGainSchema).max(100).default([]),
        }),
      )
      .min(1)
      .max(1000),
    health: z
      .object({
        current: levelingFieldSchema,
        maximum: levelingFieldSchema,
        policy: z.enum(['preserve', 'increase', 'restore']).default('preserve'),
      })
      .optional(),
    messages: levelingTextSchema.prefault({}),
    messageKeys: z
      .partialRecord(z.enum(levelingTextSchema.keyof().options), translationKeySchema)
      .default({}),
  })
  .superRefine((profile, context) => {
    if (!profile.label && !profile.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A profile label or translation is required',
      })

    if (JSON.stringify(profile.xp.path) === JSON.stringify(profile.level.path))
      context.addIssue({
        code: 'custom',
        path: ['level'],
        message: 'XP and level fields must be distinct',
      })
    profile.levels.forEach((level, index) => {
      if (
        index === 0
          ? level.xp !== 0 || level.gains.length > 0
          : level.xp <= profile.levels[index - 1]!.xp
      )
        context.addIssue({
          code: 'custom',
          path: ['levels', index],
          message: 'Level 1 starts at zero XP without gains; later thresholds strictly increase',
        })

      if (new Set(level.gains.map((gain) => gain.id)).size !== level.gains.length)
        context.addIssue({
          code: 'custom',
          path: ['levels', index, 'gains'],
          message: 'Stat gain IDs must be unique within a level',
        })
    })
  })

export type LevelingProfile = z.infer<typeof levelingProfileSchema>

export function levelingFile(id: string): string {
  return `leveling/${id}.json`
}

export function levelForXp(profile: LevelingProfile, xp: number): number {
  return profile.levels.reduce((result, level, index) => (xp >= level.xp ? index + 1 : result), 0)
}

export function localizeLeveling(
  profile: LevelingProfile,
  translation?: GameTranslation,
): LevelingProfile {
  const text = (key: string | undefined, literal: string) => {
    if (!key) return literal

    if (!translation || !Object.hasOwn(translation.fallback, key))
      throw new Error(`Missing leveling translation: ${key}`)

    return translation.messages[key] ?? translation.fallback[key]!
  }

  return levelingProfileSchema.parse({
    ...profile,
    label: text(profile.labelKey, profile.label),
    levels: profile.levels.map((level) => ({
      ...level,
      gains: level.gains.map((gain) => ({ ...gain, label: text(gain.labelKey, gain.label) })),
    })),
    messages: Object.fromEntries(
      levelingTextSchema
        .keyof()
        .options.map((key) => [key, text(profile.messageKeys[key], profile.messages[key])]),
    ),
  })
}

export const levelingBindingFields = {
  xp: 'number',
  level: 'number',
  maximumLevel: 'number',
  nextLevelXp: 'number',
  xpIntoLevel: 'number',
  xpToNextLevel: 'number',
  progressValue: 'number',
  progressMaximum: 'number',
  available: 'boolean',
  capped: 'boolean',
} as const

export function levelingIssues(
  profiles: ReadonlyMap<string, LevelingProfile>,
  rules: GameRulesDefinition | undefined,
  combats: ReadonlyMap<string, CombatDefinition>,
  scenes: ReadonlyMap<string, SceneDefinition>,
  inventory?: InventoryDefinition,
  assets?: AssetCatalog,
) {
  const issues: { file: string; path: (string | number)[]; message: string }[] = []
  const key = (field: { path: readonly string[] }) => JSON.stringify(field.path)

  const healthFields = new Set(
    [...combats.values()].flatMap((combat) =>
      [combat.player, ...combat.enemies].map((actor) => key(actor.health)),
    ),
  )

  const owners = new Map<string, string>()

  const controlled = new Set(
    [...profiles.values()].flatMap((profile) => [key(profile.xp), key(profile.level)]),
  )

  for (const [id, profile] of profiles) {
    const add = (message: string, path: (string | number)[] = []) =>
      issues.push({ file: levelingFile(id), path, message })

    if (profile.id !== id) add('Profile ID must match its manifest reference', ['id'])

    if (healthFields.has(key(profile.xp)) || healthFields.has(key(profile.level)))
      add('XP and level fields cannot also be combat health')

    const fields = [
      profile.xp,
      profile.level,
      ...profile.levels.flatMap((level) => level.gains.map((gain) => gain.field)),
      ...(profile.health ? [profile.health.current, profile.health.maximum] : []),
    ]

    for (const field of fields) {
      const declaration = rules?.state.find((value) => JSON.stringify(value.path) === key(field))

      if (
        !declaration ||
        typeof declaration.value !== 'number' ||
        !Number.isSafeInteger(declaration.value) ||
        declaration.value < 0
      )
        add(`Progression requires a declared nonnegative safe integer: ${field.path.join('.')}`)
      const owner = owners.get(key(field))

      if (owner && owner !== id) add('Progression profiles cannot share owned fields')
      owners.set(key(field), id)
    }

    const xp = rules?.state.find((value) => JSON.stringify(value.path) === key(profile.xp))?.value

    const level = rules?.state.find(
      (value) => JSON.stringify(value.path) === key(profile.level),
    )?.value

    if (typeof xp === 'number' && level !== levelForXp(profile, xp))
      add('Starting level must match the starting XP threshold', ['level'])

    for (const row of profile.levels)
      for (const gain of row.gains)
        if (
          controlled.has(key(gain.field)) ||
          healthFields.has(key(gain.field)) ||
          (profile.health && key(gain.field) === key(profile.health.current))
        )
          add('Stat gains cannot target XP, level or current health fields')

    if (profile.health) {
      const { current, maximum } = profile.health

      const equipment = Object.values(inventory?.owners ?? {}).find(
        (owner) => owner.combatStats && key(owner.combatStats.health) === key(current),
      )?.combatStats

      if (
        equipment &&
        (typeof equipment.maximumHealth !== 'object' ||
          key(equipment.maximumHealth) !== key(maximum))
      )
        add('Leveling health must match the equipment profile base maximum')

      if (
        key(current) === key(maximum) ||
        controlled.has(key(current)) ||
        controlled.has(key(maximum))
      )
        add('Health fields must be distinct from XP and level')
      const hp = rules?.state.find((value) => JSON.stringify(value.path) === key(current))?.value
      const max = rules?.state.find((value) => JSON.stringify(value.path) === key(maximum))?.value

      const owner = Object.entries(inventory?.owners ?? {}).find(
        ([, owner]) => owner.combatStats && key(owner.combatStats.health) === key(current),
      )?.[0]

      const bonus = owner
        ? Object.values(inventory?.items ?? {}).reduce(
            (sum, item) =>
              sum +
              (item.placement.type === 'equipped' && item.placement.owner === owner
                ? (inventory?.itemTypes[item.itemType]?.combatBonuses?.maximumHealth ?? 0)
                : 0),
            0,
          )
        : 0

      if (
        typeof hp === 'number' &&
        typeof max === 'number' &&
        (max + bonus <= 0 || hp > max + bonus)
      )
        add('Starting health must be within its positive maximum')
    }
  }

  for (const [id, combat] of combats) {
    const profile = combat.player.leveling && profiles.get(combat.player.leveling)

    if (combat.player.leveling && !profile)
      issues.push({
        file: `combat/${id}.json`,
        path: ['player', 'leveling'],
        message: 'Unknown leveling profile',
      })

    if (
      profile &&
      profile.health &&
      (key(profile.health.current) !== key(combat.player.health) ||
        typeof combat.player.maximumHealth !== 'object' ||
        combat.player.maximumHealth.source !== 'game.state' ||
        JSON.stringify(combat.player.maximumHealth.path) !== key(profile.health.maximum))
    )
      issues.push({
        file: `combat/${id}.json`,
        path: ['player', 'leveling'],
        message: 'Player health bindings must match the linked profile’s health fields',
      })

    for (const [move, level] of Object.entries(combat.player.moveLevels ?? {}))
      if (!combat.player.moves.includes(move) || !profile || level > profile.levels.length)
        issues.push({
          file: `combat/${id}.json`,
          path: ['player', 'moveLevels', move],
          message:
            'Move requirements must reference an available move and an authored profile level',
        })

    for (const actor of combat.enemies)
      if (actor.leveling || Object.keys(actor.moveLevels ?? {}).length)
        issues.push({
          file: `combat/${id}.json`,
          path: ['enemies'],
          message: 'V1 move progression applies to the player only',
        })

    for (const reward of combat.rewards?.numeric ?? [])
      if ([...profiles.values()].some((profile) => key(profile.level) === key(reward.field)))
        issues.push({
          file: `combat/${id}.json`,
          path: ['rewards'],
          message: 'Rewards must grant XP instead of writing a managed level',
        })
  }

  for (const [id, scene] of scenes)
    for (const [index, component] of scene.components.entries())
      if (component.type === 'character-progression' && !profiles.has(component.profile))
        issues.push({
          file: `scenes/${id}.json`,
          path: ['components', index, 'profile'],
          message: 'Unknown leveling profile',
        })

  for (const branches of Object.values(rules?.actions ?? {}))
    for (const branch of branches)
      for (const effect of branch.effects)
        if (effect.type === 'set-state' && controlled.has(JSON.stringify(effect.path)))
          issues.push({
            file: 'game.json',
            path: ['rules'],
            message: 'Managed XP and level fields must use the XP grant transaction path',
          })

  const inspect = (value: unknown, file: string, path: (string | number)[]) => {
    if (!value || typeof value !== 'object') return

    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, file, [...path, index]))

      return
    }

    if ('source' in value && value.source === 'game.leveling') {
      const binding = 'path' in value ? value.path : undefined

      if (
        !Array.isArray(binding) ||
        binding.length !== 2 ||
        typeof binding[0] !== 'string' ||
        !profiles.has(binding[0]) ||
        typeof binding[1] !== 'string' ||
        !Object.hasOwn(levelingBindingFields, binding[1])
      )
        issues.push({ file, path, message: 'Unknown character progression binding' })
    }

    for (const [key, entry] of Object.entries(value)) inspect(entry, file, [...path, key])
  }

  for (const [id, scene] of scenes) inspect(scene, `scenes/${id}.json`, [])

  for (const [id, combat] of combats) inspect(combat, `combat/${id}.json`, [])
  inspect(inventory, 'game.json', ['inventory'])
  inspect(assets, 'game.json', ['assets'])

  return issues
}
