import { z } from 'zod'
import {
  assetIdSchema as gameIdSchema,
  colorSchema,
  type AssetCatalog,
  type ImageAsset,
  type GraphicPart,
} from './assets.js'

const labelSchema = z.string().trim().min(1)
const colorsSchema = z.record(gameIdSchema, colorSchema)

export const inventoryPlacementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('carried'), owner: gameIdSchema }),
  z.object({ type: z.literal('equipped'), owner: gameIdSchema, slot: gameIdSchema }),
  z.object({ type: z.literal('inside'), container: gameIdSchema }),
])

const itemTypeSchema = z.object({
  label: labelSchema,
  container: z.boolean().default(false),
  equipmentSlots: z.array(gameIdSchema).default([]),
  icon: gameIdSchema.optional(),
  wornPart: gameIdSchema.optional(),
})

export const inventorySchema = z.object({
  'schema-version': z.literal('1.0.0'),
  itemTypes: z.record(gameIdSchema, itemTypeSchema),
  owners: z.record(
    gameIdSchema,
    z.object({
      label: labelSchema,
      equipmentSlots: z.record(gameIdSchema, labelSchema).default({}),
    }),
  ),
  items: z.record(
    gameIdSchema,
    z.object({
      itemType: gameIdSchema,
      placement: inventoryPlacementSchema,
      colors: colorsSchema.default({}),
    }),
  ),
})

export const inventoryPreviewSchema = z.object({
  composition: gameIdSchema,
  slots: z.record(gameIdSchema, gameIdSchema),
})

export type InventoryDefinition = z.infer<typeof inventorySchema>

export type InventoryPlacement = Readonly<z.infer<typeof inventoryPlacementSchema>>

export type InventoryPreview = z.infer<typeof inventoryPreviewSchema>

export interface InventoryItem {
  readonly itemType: string
  readonly placement: InventoryPlacement
  readonly colors: Readonly<Record<string, string>>
}

/** Look up only IDs declared by the game. */
export function inventoryEntry<T>(entries: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(entries, id) ? entries[id] : undefined
}

export function inventoryPlacementIssue(
  definition: InventoryDefinition,
  items: ReadonlyMap<string, InventoryItem>,
  id: string,
  destination: InventoryPlacement,
): string | undefined {
  const item = items.get(id)

  if (!item) return `Unknown item: ${id}`
  const type = inventoryEntry(definition.itemTypes, item.itemType)

  if (!type) return `Unknown item type: ${item.itemType}`

  if (destination.type === 'inside') {
    const container = items.get(destination.container)

    if (!container) return `Unknown container: ${destination.container}`

    if (!inventoryEntry(definition.itemTypes, container.itemType)?.container)
      return `Item cannot contain other items: ${destination.container}`

    const visited = new Set([id])
    let next = destination

    for (;;) {
      if (visited.has(next.container)) return 'Items cannot form a containment cycle'
      visited.add(next.container)
      const parent = items.get(next.container)?.placement

      if (parent?.type !== 'inside') return
      next = parent
    }
  }

  const owner = inventoryEntry(definition.owners, destination.owner)

  if (!owner) return `Unknown inventory owner: ${destination.owner}`

  if (destination.type === 'carried') return

  if (!Object.hasOwn(owner.equipmentSlots, destination.slot))
    return `Unknown equipment slot: ${destination.slot}`

  if (!type.equipmentSlots.includes(destination.slot))
    return `Item is incompatible with equipment slot: ${destination.slot}`

  for (const [otherId, { placement }] of items) {
    if (
      otherId !== id &&
      placement.type === 'equipped' &&
      placement.owner === destination.owner &&
      placement.slot === destination.slot
    )
      return `Equipment slot is occupied: ${destination.slot}`
  }
}

export function inventoryIcon(
  assets: AssetCatalog | undefined,
  id: string,
): ImageAsset | GraphicPart | undefined {
  if (!assets) return

  return inventoryEntry(assets.images, id) ?? inventoryEntry(assets.parts, id)
}

export function inventoryColors(
  colors: Readonly<Record<string, string>>,
  asset: ImageAsset | GraphicPart,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(colors).filter(([name]) => Object.hasOwn(asset.colors, name)),
  )
}

export interface InventoryIssue {
  readonly path: string[]
  readonly message: string
}

export function inventoryIssues(
  definition: InventoryDefinition,
  assets: AssetCatalog | undefined,
): InventoryIssue[] {
  const issues: InventoryIssue[] = []

  const slots = new Set(
    Object.values(definition.owners).flatMap((owner) => Object.keys(owner.equipmentSlots)),
  )

  for (const [id, type] of Object.entries(definition.itemTypes)) {
    const path = ['itemTypes', id]

    for (const slot of type.equipmentSlots) {
      if (!slots.has(slot))
        issues.push({
          path: [...path, 'equipmentSlots'],
          message: `Unknown equipment slot: ${slot}`,
        })
    }

    if (type.icon && !inventoryIcon(assets, type.icon))
      issues.push({ path: [...path, 'icon'], message: `Unknown image or part: ${type.icon}` })

    if (type.wornPart && !(assets && inventoryEntry(assets.parts, type.wornPart)))
      issues.push({ path: [...path, 'wornPart'], message: `Unknown part: ${type.wornPart}` })
  }

  const items = new Map(Object.entries(definition.items))

  for (const [id, item] of items) {
    const issue = inventoryPlacementIssue(definition, items, id, item.placement)

    if (issue) issues.push({ path: ['items', id, 'placement'], message: issue })
    const type = inventoryEntry(definition.itemTypes, item.itemType)
    const icon = type?.icon && inventoryIcon(assets, type.icon)
    const part = assets && type?.wornPart && inventoryEntry(assets.parts, type.wornPart)

    for (const color of Object.keys(item.colors)) {
      if (
        !(icon && Object.hasOwn(icon.colors, color)) &&
        !(part && Object.hasOwn(part.colors, color))
      )
        issues.push({
          path: ['items', id, 'colors', color],
          message: `Unknown item color: ${color}`,
        })
    }
  }

  return issues
}

export function inventoryPanelIssues(
  owners: readonly string[],
  previews: Readonly<Record<string, InventoryPreview>>,
  definition: InventoryDefinition | undefined,
  assets: AssetCatalog | undefined,
): InventoryIssue[] {
  if (!definition)
    return [{ path: [], message: 'Inventory panel requires an inventory definition' }]
  const issues: InventoryIssue[] = []

  for (const owner of owners) {
    if (!Object.hasOwn(definition.owners, owner))
      issues.push({ path: ['owners'], message: `Unknown inventory owner: ${owner}` })
  }

  for (const [id, preview] of Object.entries(previews)) {
    const path = ['previews', id]
    const owner = inventoryEntry(definition.owners, id)

    if (!owner || !owners.includes(id)) {
      issues.push({ path, message: `Preview owner is not shown in this panel: ${id}` })
      continue
    }

    const composition = assets && inventoryEntry(assets.compositions, preview.composition)

    if (!composition) {
      issues.push({ path, message: `Unknown composition: ${preview.composition}` })
      continue
    }

    if (new Set(Object.values(preview.slots)).size !== Object.keys(preview.slots).length)
      issues.push({
        path: [...path, 'slots'],
        message: 'Composition slots may only be mapped once',
      })

    for (const [slot, target] of Object.entries(preview.slots)) {
      const mapped = inventoryEntry(composition.slots, target)
      const slotPath = [...path, 'slots', slot]

      if (!Object.hasOwn(owner.equipmentSlots, slot) || !mapped) {
        issues.push({
          path: slotPath,
          message: `Unknown equipment or composition slot: ${slot} → ${target}`,
        })
        continue
      }

      for (const type of Object.values(definition.itemTypes)) {
        if (
          type.wornPart &&
          type.equipmentSlots.includes(slot) &&
          !mapped.parts.includes(type.wornPart)
        )
          issues.push({
            path: slotPath,
            message: `Part ${type.wornPart} is not allowed in slot ${target}`,
          })
      }
    }
  }

  return issues
}
