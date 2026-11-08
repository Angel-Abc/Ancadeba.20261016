import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  createStarterProject,
  inspectProject,
  object,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import {
  inventorySchema,
  inventoryComponentSchema,
  equipmentComponentSchema,
} from '@ancadeba/schemas'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'

const inventory = () =>
  inventorySchema.parse({
    'schema-version': '1.0.0',
    itemTypes: {
      bag: { label: 'Bag', container: true },
      sword: { label: 'Sword', equipmentSlots: ['hand'] },
      potion: { label: 'Potion' },
    },
    owners: {
      player: { label: 'Player', equipmentSlots: { hand: 'Hand' } },
      merchant: { label: 'Merchant' },
    },
    items: {
      bag1: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
      sword1: { itemType: 'sword', placement: { type: 'equipped', owner: 'player', slot: 'hand' } },
      potion1: { itemType: 'potion', placement: { type: 'inside', container: 'bag1' } },
    },
  })

const project = (): ProjectSnapshot => ({
  revision: 'one',
  documents: createStarterProject({ path: 'game', title: 'Inventory authoring', description: '' }),
})

const upsert = (
  data = inventory(),
  inventoryId = 'items',
): Extract<EditorCommand, { type: 'game.upsertInventory' }> => ({
  type: 'game.upsertInventory',
  inventoryId,
  inventory: data,
})

describe('inventory authoring commands', () => {
  it('creates the first referenced inventory without mutating the source and edits all entry kinds together', () => {
    const initial = project()
    const before = JSON.stringify(initial)
    const result = applyCommand(initial, { ...upsert(), createOnly: true })
    expect(JSON.stringify(initial)).toBe(before)
    expect(result.createdFiles).toEqual(['inventory/items.json'])
    expect(result.changedFiles).toEqual(['inventory/items.json', 'game.json'])
    expect(inspectProject(result.project).inventory).toEqual(inventory())
    const next = inventory()
    next.itemTypes.sword!.label = 'Iron sword'
    next.owners.player!.label = 'Hero'
    next.items.potion1!.placement = { type: 'carried', owner: 'merchant' }
    const edited = applyCommand(result.project, upsert(next))
    expect(edited.changedFiles).toEqual(['inventory/items.json'])
    expect(inspectProject(edited.project).inventory).toEqual(next)
  })

  it.each([
    'unknown type',
    'unknown owner',
    'unknown container',
    'cycle',
    'occupied slot',
    'incompatible slot',
  ])('rejects %s without publishing a partial change', (problem) => {
    const data = inventory()

    if (problem === 'unknown type') data.items.potion1!.itemType = 'missing'

    if (problem === 'unknown owner')
      data.items.bag1!.placement = { type: 'carried', owner: 'missing' }

    if (problem === 'unknown container')
      data.items.potion1!.placement = { type: 'inside', container: 'missing' }

    if (problem === 'cycle') data.items.bag1!.placement = { type: 'inside', container: 'bag1' }

    if (problem === 'occupied slot') data.items.sword2 = { ...data.items.sword1! }

    if (problem === 'incompatible slot')
      data.items.potion1!.placement = { type: 'equipped', owner: 'player', slot: 'hand' }
    const source = project()
    expect(() => applyCommand(source, upsert(data))).toThrow('invalid project')
    expect(inspectProject(source).inventory).toBeUndefined()
  })

  it('validates deletions against starting items, panels and other files, and permits atomic cleanup', () => {
    const initial = applyCommand(project(), upsert()).project
    const deleted = inventory()
    delete deleted.itemTypes.bag
    expect(() => applyCommand(initial, upsert(deleted))).toThrow('invalid project')
    delete deleted.items.bag1
    expect(() => applyCommand(initial, upsert(deleted))).toThrow('invalid project')
    deleted.items.potion1!.placement = { type: 'carried', owner: 'player' }
    expect(
      inspectProject(applyCommand(initial, upsert(deleted)).project).inventory!.itemTypes.bag,
    ).toBeUndefined()

    const panel = inventoryComponentSchema.parse({
      id: 'inventory',
      type: 'inventory',
      owners: ['player'],
      placement: { row: 1, column: 1 },
    })

    const withPanel = applyCommand(initial, {
      type: 'scene.upsertItemView',
      sceneId: 'adventure',
      component: panel,
    }).project

    const noPlayer = inventory()
    noPlayer.owners = { merchant: noPlayer.owners.merchant! }
    noPlayer.items = {}
    expect(() => applyCommand(withPanel, upsert(noPlayer))).toThrow('invalid project')
  })

  it('merges cross-file references, rejects duplicate IDs, and protects existing and unlisted files', () => {
    const first = inventory()
    first.items = {}
    const source = applyCommand(project(), upsert(first)).project

    const second = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: {},
      owners: {},
      items: inventory().items,
    })

    const merged = applyCommand(source, upsert(second, 'starting')).project
    expect(inspectProject(merged).inventory).toEqual(inventory())
    second.owners.player = { label: 'Duplicate', equipmentSlots: {} }
    expect(() => applyCommand(merged, upsert(second, 'starting'))).toThrow('invalid project')
    expect(() => applyCommand(source, { ...upsert(first), createOnly: true })).toThrow(
      'already exists',
    )
    expect(() => applyCommand(source, upsert(first, 'Items'))).toThrow('unused inventory ID')

    const unlisted = {
      ...project(),
      documents: { ...project().documents, 'inventory/items.json': { protected: true } },
    }

    expect(() => applyCommand(unlisted, upsert())).toThrow('unused inventory ID')
  })

  it('preserves extension fields and property identities while clearing removed values and placement fields', () => {
    const data = inventory()
    data.itemTypes.sword!.properties = [
      { id: 'price', label: 'Price', value: 10 },
      { id: 'weight', label: 'Weight', value: 2 },
    ]
    const initial = applyCommand(project(), upsert(data)).project

    const raw = {
      ...data,
      extension: 'root',
      itemTypes: {
        ...data.itemTypes,
        sword: {
          ...data.itemTypes.sword,
          extension: 'type',
          properties: data.itemTypes.sword!.properties.map((value) => ({
            ...value,
            extension: value.id,
          })),
        },
      },
      owners: { ...data.owners, player: { ...data.owners.player, extension: 'owner' } },
      items: {
        ...data.items,
        sword1: {
          ...data.items.sword1,
          extension: 'item',
          placement: { ...data.items.sword1!.placement, extension: 'placement' },
        },
      },
    }

    const source = { ...initial, documents: { ...initial.documents, 'inventory/items.json': raw } }
    const changed = structuredClone(data)
    changed.itemTypes.sword!.properties.reverse()
    changed.items.sword1!.placement = { type: 'inside', container: 'bag1' }
    const result = applyCommand(source, upsert(changed)).project.documents['inventory/items.json']
    expect(result).toMatchObject({
      extension: 'root',
      owners: { player: { extension: 'owner' } },
      itemTypes: {
        sword: {
          extension: 'type',
          properties: [
            { id: 'weight', extension: 'weight' },
            { id: 'price', extension: 'price' },
          ],
        },
      },
      items: {
        sword1: {
          extension: 'item',
          placement: { type: 'inside', container: 'bag1', extension: 'placement' },
        },
      },
    })
    expect(object(object(object(result).items).sword1).placement).not.toHaveProperty('owner')
    expect(object(object(object(result).items).sword1).placement).not.toHaveProperty('slot')
  })

  it('handles IDs named after schema fields and preserves extensions specific to their location', () => {
    const data = inventory()
    data.itemTypes.colors = { ...data.itemTypes.potion! }
    data.owners.equipmentSlots = { label: 'Other', equipmentSlots: {} }
    const initial = applyCommand(project(), upsert(data)).project
    const raw = object(structuredClone(data))
    object(object(raw.itemTypes).colors).attack = 'custom type metadata'
    const source = { ...initial, documents: { ...initial.documents, 'inventory/items.json': raw } }
    const changed = structuredClone(data)
    changed.itemTypes.colors!.description = 'Edited'
    changed.owners.equipmentSlots!.label = 'Edited owner'
    const result = applyCommand(source, upsert(changed)).project
    expect(object(object(result.documents['inventory/items.json']).itemTypes).colors).toMatchObject(
      {
        label: 'Potion',
        description: 'Edited',
        attack: 'custom type metadata',
      },
    )
    expect(inspectProject(result).inventory!.owners.equipmentSlots!.label).toBe('Edited owner')
  })

  it('creates, edits and removes inventory panels while protecting equipment references', () => {
    let source = applyCommand(project(), upsert()).project

    const panel = inventoryComponentSchema.parse({
      id: 'items',
      type: 'inventory',
      owners: ['player'],
      placement: { row: 1, column: 1 },
      descriptionTarget: 'narrative',
    })

    source = applyCommand(source, {
      type: 'scene.upsertItemView',
      sceneId: 'adventure',
      component: panel,
    }).project

    const equipment = equipmentComponentSchema.parse({
      id: 'equipment',
      type: 'equipment',
      inventory: 'items',
      owner: 'player',
      placement: { row: 2, column: 1 },
    })

    source = applyCommand(source, {
      type: 'scene.upsertItemView',
      sceneId: 'adventure',
      component: equipment,
    }).project
    expect(() =>
      applyCommand(source, {
        type: 'scene.removeItemView',
        sceneId: 'adventure',
        componentId: 'items',
      }),
    ).toThrow('invalid project')
    source = applyCommand(source, {
      type: 'scene.removeItemView',
      sceneId: 'adventure',
      componentId: 'equipment',
    }).project
    source = applyCommand(source, {
      type: 'scene.upsertItemView',
      sceneId: 'adventure',
      component: { ...panel, descriptionTarget: undefined, readOnly: true },
    }).project
    expect(
      JSON.parse(
        JSON.stringify(
          inspectProject(source)
            .scenes.find((scene) => scene.id === 'adventure')!
            .components.find((component) => component.id === 'items'),
        ),
      ),
    ).not.toHaveProperty('descriptionTarget')
    source = applyCommand(source, {
      type: 'scene.removeItemView',
      sceneId: 'adventure',
      componentId: 'items',
    }).project
    expect(
      inspectProject(source)
        .scenes.find((scene) => scene.id === 'adventure')!
        .components.some((component) => component.id === 'items'),
    ).toBe(false)
  })
})

describe('inventory authoring persistence', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-inventory-authoring-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Inventory test' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (command: EditorCommand) =>
    service.apply({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      command,
    })

  const restore = async (direction: 'undo' | 'redo') =>
    service.restore({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      direction,
    })

  it('persists a new inventory and restores the exact manifest and file through shared undo/redo', async () => {
    const before = await workspace.read('game/game.json')
    await apply({ ...upsert(), createOnly: true })
    const saved = await workspace.read('game/inventory/items.json')
    expect((await service.inspect('game')).inventory).toEqual(inventory())
    await restore('undo')
    expect(await workspace.read('game/game.json')).toEqual(before)
    await expect(workspace.read('game/inventory/items.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await restore('redo')
    expect(await workspace.read('game/inventory/items.json')).toEqual(saved)
    const edited = inventory()
    edited.owners.player!.label = 'Hero'
    await apply(upsert(edited))
    await restore('undo')
    expect(await workspace.read('game/inventory/items.json')).toEqual(saved)
  })

  it('protects unlisted files and rejects stale edits and invalid placements without changing bytes', async () => {
    await workspace.write('game/inventory/orphan.json', Buffer.from('protected'))
    await expect(apply(upsert(inventory(), 'orphan'))).rejects.toMatchObject({ status: 409 })
    expect(Buffer.from(await workspace.read('game/inventory/orphan.json')).toString()).toBe(
      'protected',
    )
    await apply(upsert())
    const before = await workspace.read('game/inventory/items.json')
    const old = (await service.inspect('game')).revision
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    await expect(
      service.apply({ path: 'game', expectedRevision: old, command: upsert() }),
    ).rejects.toMatchObject({ status: 409 })
    const invalid = inventory()
    invalid.items.bag1!.placement = { type: 'inside', container: 'potion1' }
    await expect(apply(upsert(invalid))).rejects.toMatchObject({ status: 422 })
    expect(await workspace.read('game/inventory/items.json')).toEqual(before)
  })

  it('loads authored starting items and a scene inventory through the normal game data pipeline', async () => {
    await apply(upsert())
    await apply({
      type: 'scene.upsertItemView',
      sceneId: 'adventure',
      component: inventoryComponentSchema.parse({
        id: 'inventory',
        type: 'inventory',
        owners: ['player', 'merchant'],
        placement: { row: 1, column: 1 },
      }),
    })

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) => Buffer.from(await workspace.read(`game/${path}`)).toString(),
          readBytes: (path) => workspace.read(`game/${path}`),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    ).load()

    expect(game.inventory).toEqual(inventory())
    expect(
      game.scenes.get('adventure')!.components.some((component) => component.type === 'inventory'),
    ).toBe(true)
  })
})
