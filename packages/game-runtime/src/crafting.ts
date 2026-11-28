import { inventoryEntry, type InventoryDefinition } from '@ancadeba/schemas'
import type { IGameInventory, InventoryItemSnapshot } from './inventory.js'

export interface CraftingRecipe {
  readonly output: string
  readonly ingredients: readonly { itemType: string; required: number; available: number }[]
  readonly available: boolean
}

export interface IGameCrafting {
  recipes(owner: string): readonly CraftingRecipe[]
  craft(owner: string, output: string): boolean
}

/** One recipe produces one new instance of its output item type. */
export class GameCrafting implements IGameCrafting {
  private lastInstance = 0

  constructor(
    private readonly definition: InventoryDefinition,
    private readonly inventory: IGameInventory,
  ) {}

  get sequence(): number {
    return this.lastInstance
  }

  restoreSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.lastInstance)
      throw new Error('Invalid saved crafting sequence')
    this.lastInstance = sequence
  }

  private materials(owner: string, items: readonly InventoryItemSnapshot[]) {
    const filled = new Set(
      items.flatMap(({ placement }) => (placement.type === 'inside' ? [placement.container] : [])),
    )

    const materials = new Map<string, string[]>()

    for (const { id, itemType, placement } of items) {
      if (
        placement.type !== 'carried' ||
        placement.owner !== owner ||
        filled.has(id) ||
        this.inventory.isReserved?.(id)
      )
        continue
      const ids = materials.get(itemType)

      if (ids) ids.push(id)
      else materials.set(itemType, [id])
    }

    return materials
  }

  recipes(owner: string): CraftingRecipe[] {
    if (!inventoryEntry(this.definition.owners, owner)) return []
    const materials = this.materials(owner, this.inventory.snapshot)

    return Object.entries(this.definition.itemTypes).flatMap(([output, { recipe }]) => {
      if (!recipe) return []

      const ingredients = Object.entries(recipe.ingredients).map(([itemType, required]) => ({
        itemType,
        required,
        available: materials.get(itemType)?.length ?? 0,
      }))

      return [
        {
          output,
          ingredients,
          available:
            typeof this.inventory.prepareTransaction === 'function' &&
            ingredients.every(({ required, available }) => available >= required),
        },
      ]
    })
  }

  craft(owner: string, output: string): boolean {
    const recipe = inventoryEntry(this.definition.itemTypes, output)?.recipe

    if (!recipe || !inventoryEntry(this.definition.owners, owner)) return false
    const items = this.inventory.snapshot
    const materials = this.materials(owner, items)
    const remove: string[] = []

    for (const [itemType, required] of Object.entries(recipe.ingredients)) {
      const candidates = materials.get(itemType)

      if (!candidates || candidates.length < required) return false

      for (const id of candidates.slice(0, required)) remove.push(id)
    }

    // Authored instance IDs can still be referenced by rules after their item was consumed.
    const occupied = new Set(items.map(({ id }) => id))
    let sequence = this.lastInstance
    let id: string

    do {
      if (sequence === Number.MAX_SAFE_INTEGER) return false
      id = `crafted-${output}-${++sequence}`
    } while (occupied.has(id) || Object.hasOwn(this.definition.items, id))

    const transaction = this.inventory.prepareTransaction?.({
      create: [{ id, itemType: output, placement: { type: 'carried', owner }, colors: {} }],
      remove,
      transfers: [],
    })

    if (!transaction?.isCurrent()) return false
    transaction.commit()
    this.lastInstance = sequence
    transaction.notify()

    return true
  }
}
