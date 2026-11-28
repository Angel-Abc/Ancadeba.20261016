import { describe, expect, it } from 'vite-plus/test'
import { inventorySchema, validateInventorySources } from '@ancadeba/schemas'
import { GameCrafting, GameInventory } from '@ancadeba/game-runtime'

const carried = (itemType: string, owner = 'player') => ({
  itemType,
  placement: { type: 'carried', owner },
})

const inventoryDefinition = () =>
  inventorySchema.parse({
    'schema-version': '1.0.0',
    itemTypes: {
      board: { label: 'Board', container: true, equipmentSlots: ['hand'] },
      crate: { label: 'Crate', recipe: { ingredients: { board: 2 } } },
    },
    owners: {
      player: { label: 'Player', equipmentSlots: { hand: 'Hand' } },
      shop: { label: 'Shop' },
    },
    items: {
      filled: carried('board'),
      inside: { itemType: 'board', placement: { type: 'inside', container: 'filled' } },
      equipped: {
        itemType: 'board',
        placement: { type: 'equipped', owner: 'player', slot: 'hand' },
      },
      stock: carried('board', 'shop'),
      reserved: carried('board'),
      spare: carried('board'),
      'crafted-crate-1': carried('board'),
    },
  })

describe('crafting recipes', () => {
  it('counts eligible instances and spends the full quantity in one inventory update', () => {
    const definition = inventoryDefinition()
    const inventory = new GameInventory(definition)
    const crafting = new GameCrafting(definition, inventory)
    const token = { encounter: 'fight' }
    inventory.reserveItem('reserved', token)
    inventory.reserveItem('spare', token)
    expect(crafting.recipes('player')).toEqual([
      {
        output: 'crate',
        ingredients: [{ itemType: 'board', required: 2, available: 1 }],
        available: false,
      },
    ])
    const before = inventory.snapshot
    expect(crafting.craft('player', 'crate')).toBe(false)
    expect(crafting.craft('shop', 'crate')).toBe(false)
    expect(crafting.craft('missing', 'crate')).toBe(false)
    expect(crafting.craft('player', 'board')).toBe(false)
    expect(inventory.snapshot).toEqual(before)
    inventory.releaseItems(token, 'spare')
    const observations: string[][] = []
    inventory.subscribeChanges(() => observations.push(inventory.snapshot.map((item) => item.id)))
    expect(crafting.craft('player', 'crate')).toBe(true)
    expect(observations).toEqual([
      ['filled', 'inside', 'equipped', 'stock', 'reserved', 'crafted-crate-2'],
    ])
    expect(crafting.craft('player', 'crate')).toBe(false)
    expect(observations).toHaveLength(1)
  })

  it('preserves output identities across consumption and save restoration', () => {
    const definition = inventoryDefinition()
    definition.items = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((id) => [id, definition.items.spare!]),
    )
    const inventory = new GameInventory(definition)
    const crafting = new GameCrafting(definition, inventory)
    expect(crafting.craft('player', 'crate')).toBe(true)
    const consume = inventory.prepareRemove(['crafted-crate-1'])!
    consume.commit()
    consume.notify()
    const restored = new GameInventory(definition)
    restored.restore(Object.fromEntries(inventory.snapshot.map(({ id, ...item }) => [id, item])))
    const next = new GameCrafting(definition, restored)
    next.restoreSequence(crafting.sequence)
    expect(next.craft('player', 'crate')).toBe(true)
    expect(restored.snapshot.map((item) => item.id)).toEqual(['crafted-crate-2'])
  })

  it('validates ingredient types across inventory files and reports the recipe source', () => {
    const materials = inventoryDefinition()
    const recipes = inventoryDefinition()
    delete materials.itemTypes.crate
    delete recipes.itemTypes.board
    recipes.items = {}
    recipes.owners = {}

    const sources = [
      { file: 'items', inventory: materials },
      { file: 'recipes', inventory: recipes },
    ]

    expect(validateInventorySources(sources).issues).toEqual([])
    recipes.itemTypes.crate!.recipe = { ingredients: { unknown: 2 } }
    expect(validateInventorySources(sources).issues).toEqual([
      expect.objectContaining({
        file: 'recipes',
        path: ['itemTypes', 'crate', 'recipe', 'ingredients', 'unknown'],
      }),
    ])
  })

  it.each([{}, { board: 0 }, { board: -2 }, { board: 0.5 }])(
    'rejects invalid quantities %j',
    (ingredients) => {
      expect(
        inventorySchema.shape.itemTypes.safeParse({
          crate: { label: 'Crate', recipe: { ingredients } },
        }).success,
      ).toBe(false)
    },
  )
})
