import {
  inventoryFile,
  inventorySchema,
  inventoryItemTypeSchema,
  inventoryOwnerSchema,
  inventoryStartingItemSchema,
  itemPropertySchema,
  itemUseSchema,
  combatStatsProfileSchema,
  combatBonusesSchema,
  gameBindingSchema,
  inventoryItemActionSchema,
  itemUseTextSchema,
  combatStatsTextSchema,
  combatStatNames,
  type GameDefinition,
} from '@ancadeba/schemas'
import { EditorError, object } from './project.js'
import type { EditorCommand } from './commands.js'
import { mergeEquipmentCombatEffects } from './equipmentCombatEditing.js'

// null denotes an ID dictionary: removed entries must not be restored as extensions.
const fields = new Map<string, readonly string[] | null>([
  ['', inventorySchema.keyof().options],
  ['itemTypes', null],
  ['owners', null],
  ['items', null],
  ['itemTypes.*', inventoryItemTypeSchema.keyof().options],
  ['owners.*', inventoryOwnerSchema.keyof().options],
  ['items.*', inventoryStartingItemSchema.keyof().options],
  ['owners.*.equipmentSlots', null],
  ['owners.*.equipmentSlotKeys', null],
  ['items.*.colors', null],
  ['items.*.placement', ['type', 'owner', 'slot', 'container']],
  ['itemTypes.*.properties.*', itemPropertySchema.keyof().options],
  ['itemTypes.*.properties.*.value', gameBindingSchema.keyof().options],
  ['itemTypes.*.combatBonuses', combatBonusesSchema.keyof().options],
  ['itemTypes.*.use', itemUseSchema.keyof().options],
  ['itemTypes.*.use.ability', ['library', 'id']],
  ['itemTypes.*.use.enabledWhen', gameBindingSchema.keyof().options],
  ['itemTypes.*.use.messages', itemUseTextSchema.keyof().options],
  ['itemTypes.*.use.messageKeys', null],
  ['itemTypes.*.inspection', ['action', 'details', 'inline']],
  ['itemTypes.*.inspection.details', gameBindingSchema.keyof().options],
  ['itemTypes.*.actions', null],
  ['itemTypes.*.actions.*', inventoryItemActionSchema.keyof().options],
  ['itemTypes.*.actions.*.enabledWhen', gameBindingSchema.keyof().options],
  ['owners.*.combatStats', combatStatsProfileSchema.keyof().options],
  ['owners.*.combatStats.messages', combatStatsTextSchema.keyof().options],
  ['owners.*.combatStats.messageKeys', null],
])

for (const stat of ['health', ...combatStatNames])
  fields.set(`owners.*.combatStats.${stat}`, gameBindingSchema.keyof().options)

function location(path: readonly string[]) {
  return path
    .map((name, index) =>
      index === 1 ||
      (index === 3 &&
        path[0] === 'itemTypes' &&
        (path[2] === 'properties' || path[2] === 'actions'))
        ? '*'
        : name,
    )
    .join('.')
}

type InventoryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | InventoryValue[]
  | Record<string, unknown>

/** Keep extensions at stable entry/property IDs while dropping removed entries and optional fields. */
function merge(previous: unknown, next: unknown, path: string[] = []): InventoryValue {
  if (path.length === 3 && path[0] === 'itemTypes' && path[2] === 'combatEffects')
    return mergeEquipmentCombatEffects(
      previous,
      next && typeof next === 'object'
        ? inventoryItemTypeSchema.shape.combatEffects.unwrap().parse(next)
        : undefined,
    )

  if (Array.isArray(next)) {
    const before = Array.isArray(previous) ? previous : []

    return next.map((entry, index) =>
      merge(
        object(entry).id === undefined
          ? before[index]
          : before.find((value) => object(value).id === object(entry).id),
        entry,
        [...path, String(index)],
      ),
    )
  }

  if (
    next === null ||
    next === undefined ||
    typeof next === 'string' ||
    typeof next === 'number' ||
    typeof next === 'boolean'
  )
    return next

  if (typeof next !== 'object') return
  const before = object(previous)
  const known = fields.get(location(path))

  return {
    ...Object.fromEntries(
      Object.entries(before).filter(([name]) => known !== null && !known?.includes(name)),
    ),
    ...Object.fromEntries(
      Object.entries(next).map(([name, value]) => [
        name,
        merge(before[name], value, [...path, name]),
      ]),
    ),
  }
}

export function editInventory(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'game.upsertInventory' }>,
) {
  const file = inventoryFile(command.inventoryId)
  const exists = game.inventory?.includes(command.inventoryId) === true

  if (command.createOnly && exists)
    throw new EditorError(409, 'inventory_exists', 'Inventory ID already exists')

  if (
    !exists &&
    (game.inventory?.some((id) => id.toLowerCase() === command.inventoryId.toLowerCase()) ||
      Object.hasOwn(documents, file))
  )
    throw new EditorError(409, 'inventory_exists', 'Choose an unused inventory ID')
  documents[file] = merge(documents[file], command.inventory)

  if (exists) return { changedFiles: [file] }
  documents['game.json'] = {
    ...object(documents['game.json']),
    inventory: [...(game.inventory ?? []), command.inventoryId],
  }

  return { changedFiles: [file, 'game.json'], createdFiles: [file] }
}
