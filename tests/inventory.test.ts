import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vite-plus/test'
import { validateProject } from '@ancadeba/editor-core'
import { GameLifecycle, GameLoader, resolveGraphic } from '@ancadeba/game-runtime'
import {
  graphicAppearanceSchema,
  inventoryColors,
  inventoryIcon,
  inventorySchema,
  type InventoryPlacement,
} from '@ancadeba/schemas'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const carried: InventoryPlacement = { type: 'carried', owner: 'wayfarer' }
const worn: InventoryPlacement = { type: 'equipped', owner: 'wayfarer', slot: 'outerwear' }
const bag: InventoryPlacement = { type: 'inside', container: 'travel-pack' }

const paths = [
  'game.json',
  'rules/shop.json',
  'rules/combat.json',
  'combat-libraries/common.json',
  'combat/training.json',
  'combat/advanced-training.json',
  'leveling/player.json',
  'scenes/advanced-training.json',
  'scenes/training.json',
  'scenes/shop.json',
  'input/controls.json',
  'assets/wardrobe.json',
  'inventory/wardrobe.json',
  'scenes/gallery.json',
  'scenes/ember.json',
  'scenes/wardrobe.json',
]

function readSample(path: string) {
  return readFile(new URL(`../sample-games/graphics/${path}`, import.meta.url), 'utf8')
}

function loader(readText = readSample) {
  return new GameLoader(
    new JsonResourceLoader({ readText, readBytes: async () => new Uint8Array() }, logger),
  )
}

describe('wardrobe inventory', () => {
  it('moves a worn container with its nested contents and resets the playthrough on New Game', async () => {
    const game = await loader().load()

    const lifecycle = new GameLifecycle(game, {
      createGameState: () => undefined,
      createSceneState: () => undefined,
    })

    const inventory = lifecycle.startGame().inventory!
    const initial = inventory.snapshot
    const changed = vi.fn()
    inventory.subscribeChanges(changed)
    lifecycle.enterScene('wardrobe')

    const back: InventoryPlacement = { type: 'equipped', owner: 'wayfarer', slot: 'back' }
    expect(inventory.move('travel-pack', back)).toEqual({ status: 'applied', changed: true })
    expect(inventory.move('letter', bag).status).toBe('applied')
    expect(inventory.move('moss-cloak', worn).status).toBe('applied')
    expect(inventory.move('travel-pack', { type: 'carried', owner: 'ranger' }).status).toBe(
      'applied',
    )
    expect(inventory.move('moss-cloak', worn)).toEqual({ status: 'applied', changed: false })
    expect(changed).toHaveBeenCalledTimes(4)
    expect(inventory.snapshot.find(({ id }) => id === 'letter')?.placement).toEqual(bag)
    expect(inventory.snapshot.find(({ id }) => id === 'travel-pack')?.placement).toEqual({
      type: 'carried',
      owner: 'ranger',
    })
    expect(initial.find(({ id }) => id === 'travel-pack')?.placement).toEqual(carried)

    lifecycle.enterScene('gallery')
    const wardrobe = lifecycle.enterScene('wardrobe')

    if (wardrobe.type !== 'game') throw new Error('Expected game scene')
    expect(wardrobe.game.inventory).toBe(inventory)
    expect(lifecycle.startGame().inventory?.snapshot).toEqual(initial)
    expect(inventory.move('travel-pack', carried).status).toBe('rejected')
    lifecycle.dispose()
  })

  it('rejects invalid moves atomically, including containment cycles through another bag', async () => {
    const game = await loader(async (path) => {
      if (path !== 'inventory/wardrobe.json') return readSample(path)

      const definition = inventorySchema.parse(JSON.parse(await readSample(path)))
      definition.items.pouch = { itemType: 'backpack', placement: bag, colors: {} }

      return JSON.stringify(definition)
    }).load()

    const lifecycle = new GameLifecycle(game, {
      createGameState: () => undefined,
      createSceneState: () => undefined,
    })

    const inventory = lifecycle.startGame().inventory!
    inventory.move('moss-cloak', worn)
    const changed = vi.fn()
    inventory.subscribeChanges(changed)
    const before = inventory.snapshot

    const invalid: [string, InventoryPlacement, string][] = [
      ['absent', carried, 'Unknown item'],
      ['letter', { type: 'carried', owner: 'absent' }, 'Unknown inventory owner'],
      ['letter', { type: 'inside', container: 'absent' }, 'Unknown container'],
      ['letter', { ...worn, slot: 'unknown' }, 'Unknown equipment slot'],
      ['letter', worn, 'incompatible'],
      ['royal-cloak', worn, 'occupied'],
      ['travel-pack', bag, 'cycle'],
      ['travel-pack', { type: 'inside', container: 'pouch' }, 'cycle'],
      ['travel-pack', { type: 'inside', container: 'letter' }, 'cannot contain'],
    ]

    for (const [id, destination, message] of invalid) {
      expect(inventory.checkMove(id, destination)).toContain(message)
      expect(inventory.move(id, destination)).toEqual({
        status: 'rejected',
        reason: expect.stringContaining(message),
      })
    }

    expect(inventory.snapshot).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    lifecycle.dispose()
  })

  it('reports the same invalid data in the loader and editor, including asset changes', async () => {
    const files = new Map(
      await Promise.all(paths.map(async (path) => [path, await readSample(path)] as const)),
    )

    const documents = () =>
      Object.fromEntries([...files].map(([path, content]) => [path, JSON.parse(content)]))

    expect(validateProject(documents())).toEqual([])

    const definition = inventorySchema.parse(JSON.parse(files.get('inventory/wardrobe.json')!))
    definition.items['travel-pack']!.placement = bag
    definition.items['moss-cloak']!.colors.unknown = '#123456'
    definition.itemTypes.cloak!.icon = 'missing'
    files.set('inventory/wardrobe.json', JSON.stringify(definition))
    expect(validateProject(documents())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'inventory/wardrobe.json',
          path: ['items', 'travel-pack', 'placement'],
          message: expect.stringContaining('cycle'),
        }),
        expect.objectContaining({
          file: 'inventory/wardrobe.json',
          path: ['items', 'moss-cloak', 'colors', 'unknown'],
        }),
        expect.objectContaining({
          file: 'inventory/wardrobe.json',
          path: ['itemTypes', 'cloak', 'icon'],
        }),
      ]),
    )
    await expect(loader(async (path) => files.get(path)!).load()).rejects.toThrow(
      'Unknown image or part: missing',
    )

    files.set('inventory/wardrobe.json', await readSample('inventory/wardrobe.json'))
    files.set(
      'scenes/wardrobe.json',
      files.get('scenes/wardrobe.json')!.replace('"outerwear": "cloak"', '"outerwear": "body"'),
    )
    expect(validateProject(documents())).toEqual([
      expect.objectContaining({ code: 'invalid_inventory_panel', file: 'scenes/wardrobe.json' }),
    ])
    await expect(loader(async (path) => files.get(path)!).load()).rejects.toThrow(
      'Unknown equipment or composition slot',
    )
  })

  it('uses the instance dye for the icon and both-piece worn graphic without recoloring another copy', async () => {
    const { assets, inventory } = await loader().load()
    const moss = inventory!.items['moss-cloak']!
    const royal = inventory!.items['royal-cloak']!
    const part = inventoryIcon(assets, 'cloak')!
    const colors = inventoryColors(moss.colors, part)
    const icon = resolveGraphic(assets!, 'cloak', graphicAppearanceSchema.parse({ colors }))

    const wornGraphic = resolveGraphic(
      assets!,
      'paper-doll',
      graphicAppearanceSchema.parse({
        slots: { cloak: { part: 'cloak', colors } },
      }),
    )

    const otherIcon = resolveGraphic(
      assets!,
      'cloak',
      graphicAppearanceSchema.parse({
        colors: inventoryColors(royal.colors, part),
      }),
    )

    expect(icon.pieces.map(({ colors }) => colors)).toEqual([
      { fabric: '#397c73' },
      { metal: '#c99b50' },
    ])
    expect(wornGraphic.pieces.find(({ layer }) => layer === 'rear')?.colors).toEqual(
      icon.pieces[0]?.colors,
    )
    expect(wornGraphic.pieces.find(({ layer }) => layer === 'clasp')?.colors).toEqual(
      icon.pieces[1]?.colors,
    )
    expect(otherIcon.pieces[0]?.colors).toEqual({ fabric: '#665191' })
  })

  it('rejects duplicate inventory IDs and reports the file that introduced them', async () => {
    const files = new Map(
      await Promise.all(paths.map(async (path) => [path, await readSample(path)] as const)),
    )

    const game = JSON.parse(files.get('game.json')!)
    const duplicate = 'inventory/extra.json'
    files.set('game.json', JSON.stringify({ ...game, inventory: ['wardrobe', 'extra'] }))
    files.set(
      duplicate,
      JSON.stringify({
        'schema-version': '1.0.0',
        itemTypes: {},
        owners: { wayfarer: { label: 'Another wayfarer' } },
        items: {},
      }),
    )

    const message = 'Duplicate inventory ID: wayfarer'

    const documents = Object.fromEntries(
      [...files].map(([path, content]) => [path, JSON.parse(content)]),
    )

    expect(validateProject(documents)).toEqual([
      { code: 'invalid_inventory', file: duplicate, path: ['owners', 'wayfarer'], message },
    ])
    await expect(loader(async (path) => files.get(path)!).load()).rejects.toThrow(
      `${duplicate} (owners.wayfarer): ${message}`,
    )
  })
})
