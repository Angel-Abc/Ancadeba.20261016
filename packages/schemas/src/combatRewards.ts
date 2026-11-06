import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { gameBindingSchema } from './bindings.js'
import { colorSchema, type AssetCatalog } from './assets.js'
import { translationKeySchema } from './languages.js'
import { inventoryIssues, type InventoryDefinition } from './inventory.js'
import type { CombatDefinition } from './combat.js'
import type { SceneDefinition } from './scene.js'
import type { GameRulesDefinition } from './rules.js'

const id = gameIdSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
)

export const numericRewardSchema = z
  .object({
    id,
    label: z.string().default(''),
    labelKey: translationKeySchema.optional(),
    field: gameBindingSchema.safeExtend({
      source: z.literal('game.state'),
      path: z.array(id).min(1),
    }),
    amount: z.number().int().nonnegative().safe(),
  })
  .refine(
    (entry) => Boolean(entry.label || entry.labelKey),
    'A reward label or translation is required',
  )

export const lootDropSchema = z.object({
  id,
  itemType: id,
  colors: z.record(id, colorSchema).default({}),
  chance: z.number().int().min(0).max(10000).default(10000),
})

export const victoryRewardsSchema = z
  .object({
    recipient: id.optional(),
    lootOwner: id.optional(),
    numeric: z.array(numericRewardSchema).max(100).default([]),
    drops: z.array(lootDropSchema).max(100).default([]),
  })
  .superRefine((rewards, context) => {
    for (const key of ['numeric', 'drops'] as const)
      if (new Set(rewards[key].map((entry) => entry.id)).size !== rewards[key].length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Reward entry IDs must be unique',
        })

    if (
      rewards.drops.length &&
      (!rewards.recipient || !rewards.lootOwner || rewards.lootOwner === rewards.recipient)
    )
      context.addIssue({
        code: 'custom',
        path: ['lootOwner'],
        message: 'Item drops require a distinct loot owner',
      })
  })

export type VictoryRewards = z.infer<typeof victoryRewardsSchema>

export type RewardOperation = 'take-loot' | 'take-all-loot' | 'retry-rewards'

export function isRewardOperation(value: string): value is RewardOperation {
  return ['take-loot', 'take-all-loot', 'retry-rewards'].includes(value)
}

export function rewardItemId(encounter: string, entry: string): string {
  return `combat-loot-${encounter.length}-${encounter}-${entry}`
}

export function combatRewardIssues(
  combat: CombatDefinition,
  rules: GameRulesDefinition | undefined,
  inventory: InventoryDefinition | undefined,
  assets?: AssetCatalog,
) {
  const issues: { path: (string | number)[]; message: string }[] = []
  const rewards = combat.rewards

  if (!rewards) return issues

  for (const owner of [
    ...(rewards.recipient ? [rewards.recipient] : []),
    ...(rewards.lootOwner ? [rewards.lootOwner] : []),
  ])
    if (!inventory || !Object.hasOwn(inventory.owners, owner))
      issues.push({ path: ['rewards'], message: `Unknown reward inventory owner: ${owner}` })

  if (
    inventory &&
    rewards.lootOwner &&
    Object.values(inventory.items).some(
      (item) => item.placement.type !== 'inside' && item.placement.owner === rewards.lootOwner,
    )
  )
    issues.push({ path: ['rewards', 'lootOwner'], message: 'Loot owner must start empty' })

  for (const [index, entry] of rewards.numeric.entries()) {
    if (
      !rules?.state.some(
        (field) =>
          typeof field.value === 'number' &&
          JSON.stringify(field.path) === JSON.stringify(entry.field.path),
      )
    )
      issues.push({
        path: ['rewards', 'numeric', index, 'field'],
        message: 'Reward requires a declared numeric state field',
      })

    if (
      [combat.player, ...combat.enemies].some(
        (actor) => JSON.stringify(actor.health.path) === JSON.stringify(entry.field.path),
      )
    )
      issues.push({
        path: ['rewards', 'numeric', index, 'field'],
        message: 'Combat health fields cannot receive numeric rewards',
      })
  }

  for (const [index, drop] of rewards.drops.entries()) {
    const itemId = rewardItemId(combat.id, drop.id)

    if (!inventory || !Object.hasOwn(inventory.itemTypes, drop.itemType)) {
      issues.push({
        path: ['rewards', 'drops', index, 'itemType'],
        message: `Unknown loot item type: ${drop.itemType}`,
      })
      continue
    }

    if (Object.hasOwn(inventory.items, itemId))
      issues.push({
        path: ['rewards', 'drops', index, 'id'],
        message: 'Generated loot ID collides with an authored item',
      })

    const candidate = {
      ...inventory,
      items: {
        [itemId]: {
          itemType: drop.itemType,
          colors: drop.colors,
          placement: { type: 'carried' as const, owner: rewards.recipient! },
        },
      },
    }

    for (const issue of inventoryIssues(candidate, assets).filter(
      (issue) => issue.path[0] === 'items',
    ))
      issues.push({
        path: ['rewards', 'drops', index, ...issue.path.slice(2)],
        message: issue.message,
      })
  }

  return issues
}

export function combatLootViewIssues(
  scene: SceneDefinition,
  combats: ReadonlyMap<string, CombatDefinition>,
) {
  const issues: { path: (string | number)[]; message: string }[] = []

  for (const [index, component] of scene.components.entries()) {
    if (component.type !== 'combat' || !component.lootInventory) continue
    const rewards = combats.get(component.encounter)?.rewards
    const panel = scene.components.find((entry) => entry.id === component.lootInventory)

    if (
      !rewards?.lootOwner ||
      panel?.type !== 'inventory' ||
      !panel.readOnly ||
      panel.owners.length !== 1 ||
      panel.owners[0] !== rewards.lootOwner
    )
      issues.push({
        path: ['components', index, 'lootInventory'],
        message: 'Link a read-only inventory showing exactly this encounter’s loot owner',
      })

    if (
      scene.components.some(
        (entry) =>
          entry.type === 'shop' &&
          [entry.playerInventory, entry.merchantInventory].includes(component.lootInventory!),
      )
    )
      issues.push({
        path: ['components', index, 'lootInventory'],
        message: 'Loot inventory cannot also be a shop participant',
      })
  }

  return issues
}
