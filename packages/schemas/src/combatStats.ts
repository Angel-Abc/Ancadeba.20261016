import { z } from 'zod'
import { bindingAliasSchema, gameBindingSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import type { InventoryDefinition } from './inventory.js'
import type { CombatDefinition } from './combat.js'
import type { GameRulesDefinition } from './rules.js'

export const combatStatNames = ['attack', 'defense', 'guard', 'maximumHealth'] as const

export type CombatStat = (typeof combatStatNames)[number]

const amount = z.number().int().nonnegative().safe()

export const statFieldSchema = gameBindingSchema.safeExtend({
  source: z.literal('game.state'),
  path: z
    .array(bindingAliasSchema.refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v)))
    .min(1),
})

const base = z.union([amount, statFieldSchema])

export const combatBonusesSchema = z.object({
  attack: amount.default(0),
  defense: amount.default(0),
  guard: amount.default(0),
  maximumHealth: amount.default(0),
})

export const combatStatsTextSchema = z.object({
  attack: z.string().default('Attack bonus'),
  defense: z.string().default('Defense'),
  guard: z.string().default('Guard bonus'),
  maximumHealth: z.string().default('Maximum health'),
  base: z.string().default('Base'),
  equipment: z.string().default('Equipment'),
  total: z.string().default('Total'),
  comparison: z.string().default('Equipment comparison'),
  currentHealth: z.string().default('Current health'),
  chooseSlot: z.string().default('Choose a destination slot to compare.'),
  locked: z.string().default('Loadout locked by {encounter}.'),
  unavailable: z
    .string()
    .default('Equipment stats are unavailable: check values and state access.'),
})

export const combatStatsProfileSchema = z.object({
  health: statFieldSchema,
  maximumHealth: base,
  attack: base.default(0),
  defense: base.default(0),
  guard: base.default(0),
  messages: combatStatsTextSchema.prefault({}),
  messageKeys: z
    .partialRecord(z.enum(combatStatsTextSchema.keyof().options), translationKeySchema)
    .default({}),
})

export type CombatStatsProfile = z.infer<typeof combatStatsProfileSchema>

export type CombatBonuses = z.infer<typeof combatBonusesSchema>

/** Owner IDs are profile IDs, shared by all encounters using that owner. */
export function combatStatsIssues(
  inventory: InventoryDefinition | undefined,
  rules: GameRulesDefinition | undefined,
  combats: ReadonlyMap<string, CombatDefinition>,
  references: readonly unknown[] = [],
) {
  const issues: { path: (string | number)[]; message: string }[] = []
  const health = new Set<string>()

  const healthKeys = new Set(
    Object.values(inventory?.owners ?? {}).flatMap((owner) =>
      owner.combatStats ? [JSON.stringify(owner.combatStats.health.path)] : [],
    ),
  )

  for (const [id, owner] of Object.entries(inventory?.owners ?? {})) {
    const profile = owner.combatStats

    if (!profile) continue
    const add = (message: string) => issues.push({ path: ['owners', id, 'combatStats'], message })
    const hpKey = JSON.stringify(profile.health.path)

    if (health.has(hpKey)) add('Stat profiles must have distinct current-health fields')
    health.add(hpKey)

    for (const source of [profile.health, ...combatStatNames.map((stat) => profile[stat])]) {
      if (typeof source === 'number') continue

      const declaration = rules?.state.find(
        (field) => JSON.stringify(field.path) === JSON.stringify(source.path),
      )

      if (
        typeof declaration?.value !== 'number' ||
        !Number.isSafeInteger(declaration.value) ||
        declaration.value < 0
      )
        add('Stat bindings require declared nonnegative safe integers')

      if (source !== profile.health && healthKeys.has(JSON.stringify(source.path)))
        add('Base stats cannot reference current health')
    }

    const value = (source: number | { path: string[] }) =>
      typeof source === 'number'
        ? source
        : rules?.state.find((f) => JSON.stringify(f.path) === JSON.stringify(source.path))?.value

    for (const stat of combatStatNames) {
      const total = Object.values(inventory?.items ?? {}).reduce(
        (sum, item) =>
          sum +
          (item.placement.type === 'equipped' && item.placement.owner === id
            ? (inventory?.itemTypes[item.itemType]?.combatBonuses?.[stat] ?? 0)
            : 0),
        Number(value(profile[stat])),
      )

      if (!Number.isSafeInteger(total) || total < (stat === 'maximumHealth' ? 1 : 0))
        add('Starting effective stats are invalid or overflow')

      if (stat === 'maximumHealth' && Number(value(profile.health)) > total)
        add('Starting health exceeds effective maximum health')
    }
  }

  for (const combat of combats.values()) {
    const owners = new Set<string>()

    for (const actor of [combat.player, ...combat.enemies]) {
      if (!actor.equipmentOwner) continue
      const profile = inventory?.owners[actor.equipmentOwner]?.combatStats

      if (!profile || owners.has(actor.equipmentOwner))
        issues.push({
          path: ['combat', combat.id, actor.id],
          message: 'Combatants require distinct valid equipment stat owners',
        })
      owners.add(actor.equipmentOwner)

      if (
        profile &&
        (JSON.stringify(profile.health.path) !== JSON.stringify(actor.health.path) ||
          JSON.stringify(profile.maximumHealth) !== JSON.stringify(actor.maximumHealth))
      )
        issues.push({
          path: ['combat', combat.id, actor.id],
          message: 'Combat health and base maximum must match the equipment profile',
        })
    }
  }

  const inspect = (value: unknown, path: (string | number)[] = []) => {
    if (!value || typeof value !== 'object') return

    if (value instanceof Map) {
      for (const [id, entry] of value) inspect(entry, [...path, String(id)])

      return
    }

    if ('source' in value && value.source === 'game.combatStats') {
      const parts = 'path' in value ? value.path : undefined

      if (
        !Array.isArray(parts) ||
        parts.length !== 2 ||
        !inventory?.owners[parts[0]]?.combatStats ||
        ![...combatStatNames, 'health', 'available', 'locked'].includes(parts[1])
      )
        issues.push({ path, message: 'Unknown equipment stat binding' })
    }

    for (const [key, entry] of Object.entries(value)) inspect(entry, [...path, key])
  }

  inspect([inventory, ...combats.values(), ...references])

  return issues
}
