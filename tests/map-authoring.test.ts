import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { imageAssetSchema, mapDefinitionSchema, getMapMovementCostMs } from '@ancadeba/schemas'
import { type EditorCommand, object } from '@ancadeba/editor-core'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { MapTileSelection } from '../apps/editor-ui/src/mapTileSelection.js'
import { MapDraft } from '../apps/editor-ui/src/mapDraft.js'

const garden = mapDefinitionSchema.parse({
  'schema-version': '1.0.0',
  type: 'square-grid',
  width: 2,
  height: 2,
  terrain: {
    grass: { color: '#608c4f' },
    wall: { color: '#4f5969', walkable: false, movementCostMs: 200 },
  },
  tiles: [
    ['grass', 'grass'],
    ['grass', 'wall'],
  ],
})

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

describe('map authoring persistence', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-map-authoring-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Map authoring' })
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

  it('persists tile triggers, preserves extensions by ID, protects action links and restores exact history', async () => {
    const rules = {
      state: [],
      actions: {
        travel: [{ when: [], effects: [{ type: 'enter-scene' as const, scene: 'adventure' }] }],
      },
    }

    await apply({ type: 'game.updateRules', ruleId: 'travel', rules })

    const map = {
      ...structuredClone(garden),
      entryTriggers: [{ id: 'exit', x: 1, y: 0, action: 'travel' }],
    }

    await apply({ type: 'game.upsertMap', mapId: 'garden', map })

    const extended = Buffer.from(
      JSON.stringify({ ...map, entryTriggers: [{ ...map.entryTriggers[0], extension: 'keep' }] }),
    )

    await workspace.write('game/maps/garden.json', extended)
    map.entryTriggers[0]!.x = 0
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const saved = await workspace.read('game/maps/garden.json')
    expect(JSON.parse(Buffer.from(saved).toString()).entryTriggers).toEqual([
      { id: 'exit', x: 0, y: 0, action: 'travel', extension: 'keep' },
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(extended)
    await restore('redo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(saved)
    await expect(
      apply({ type: 'game.updateRules', ruleId: 'travel', rules: { state: [], actions: {} } }),
    ).rejects.toThrow('Unlink action "travel" before deleting it')
    expect(await workspace.read('game/maps/garden.json')).toEqual(saved)
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    expect(
      JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString())
        .entryTriggers,
    ).toBeUndefined()
    await apply({ type: 'game.updateRules', ruleId: 'travel', rules: { state: [], actions: {} } })
  })

  it('persists, clears and restores exact scene-entrance coordinates through rule history', async () => {
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    await apply({
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: {
        id: 'entrance',
        type: 'map-view',
        label: 'Garden',
        map: 'garden',
        placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
        viewport: { columns: 2, rows: 2, x: 0, y: 0 },
        playerSpawn: { x: 0, y: 0 },
      },
    })

    const rules = {
      state: [],
      actions: {
        travel: [
          {
            when: [],
            effects: [{ type: 'enter-scene' as const, scene: 'adventure', mapView: 'entrance' }],
          },
        ],
      },
    }

    await apply({ type: 'game.updateRules', ruleId: 'travel', rules })
    const before = await workspace.read('game/rules/travel.json')

    const placed = {
      ...rules,
      actions: {
        travel: [
          {
            when: [],
            effects: [{ ...rules.actions.travel[0]!.effects[0]!, position: { x: 0, y: 1 } }],
          },
        ],
      },
    }

    await apply({ type: 'game.updateRules', ruleId: 'travel', rules: placed })
    const after = await workspace.read('game/rules/travel.json')
    expect((await service.inspect('game')).rules!.actions.travel![0]!.effects).toEqual(
      placed.actions.travel[0]!.effects,
    )
    await restore('undo')
    expect(await workspace.read('game/rules/travel.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/rules/travel.json')).toEqual(after)
    await apply({ type: 'game.updateRules', ruleId: 'travel', rules })
    expect((await service.inspect('game')).rules!.actions.travel![0]!.effects).toEqual(
      rules.actions.travel[0]!.effects,
    )
  })

  it('persists map objects and their extensions, protects action references and restores exact undo/redo bytes', async () => {
    const rules = { state: [], actions: { interact: [{ when: [], effects: [] }] } }
    await apply({ type: 'game.updateRules', ruleId: 'objects', rules })

    const map = {
      ...structuredClone(garden),
      objects: [
        {
          id: 'sign',
          label: 'Signpost',
          x: 1,
          y: 0,
          terrain: 'wall',
          action: 'interact',
          blocking: false,
        },
      ],
    }

    await apply({ type: 'game.upsertMap', mapId: 'garden', map })

    const before = Buffer.from(
      JSON.stringify({ ...map, objects: [{ ...map.objects[0], extension: { keep: true } }] }),
    )

    await workspace.write('game/maps/garden.json', before)
    map.objects[0]!.label = 'Changed sign'
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const after = await workspace.read('game/maps/garden.json')
    expect(JSON.parse(Buffer.from(after).toString()).objects).toEqual([
      { ...map.objects[0], extension: { keep: true } },
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(after)
    await expect(
      apply({ type: 'game.updateRules', ruleId: 'objects', rules: { state: [], actions: {} } }),
    ).rejects.toThrow('Unlink action "interact"')
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    expect(
      JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString()).objects,
    ).toBeUndefined()
    await apply({ type: 'game.updateRules', ruleId: 'objects', rules: { state: [], actions: {} } })
  })

  it('persists object states by ID, clears removed overrides, protects boolean flags and restores exact history', async () => {
    const rules = {
      state: [{ path: ['opened'], value: false }],
      actions: { interact: [{ when: [], effects: [] }] },
    }

    await apply({ type: 'game.updateRules', ruleId: 'objects', rules })

    const map = mapDefinitionSchema.parse({
      ...garden,
      objects: [
        {
          id: 'chest',
          label: 'Chest',
          x: 1,
          y: 0,
          terrain: 'wall',
          action: 'interact',
          states: [
            {
              id: 'open',
              when: { path: ['opened'], value: true },
              terrain: 'grass',
              label: 'Open chest',
              blocking: false,
            },
          ],
        },
      ],
    })

    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const object = map.objects![0]!
    const state = object.states![0]!

    const before = Buffer.from(
      JSON.stringify({
        ...map,
        objects: [
          {
            ...object,
            states: [
              { ...state, extension: 'keep', when: { ...state.when, extension: 'condition' } },
            ],
          },
        ],
      }),
    )

    await workspace.write('game/maps/garden.json', before)
    delete state.terrain
    delete state.label
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const after = await workspace.read('game/maps/garden.json')
    expect(JSON.parse(Buffer.from(after).toString()).objects[0].states).toEqual([
      {
        id: 'open',
        when: { path: ['opened'], value: true, extension: 'condition' },
        blocking: false,
        extension: 'keep',
      },
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(after)

    for (const state of [[], [{ path: ['opened'], value: 'false' }]]) {
      await expect(
        apply({ type: 'game.updateRules', ruleId: 'objects', rules: { ...rules, state } }),
      ).rejects.toThrow()
      expect(await workspace.read('game/maps/garden.json')).toEqual(after)
    }

    delete object.states
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    expect(
      JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString()).objects[0]
        .states,
    ).toBeUndefined()
    await apply({ type: 'game.updateRules', ruleId: 'objects', rules: { ...rules, state: [] } })
  })

  it('persists visibility-only states and clears inherited visibility without losing extensions or undo history', async () => {
    await apply({
      type: 'game.updateRules',
      ruleId: 'pickups',
      rules: {
        state: [{ path: ['collected'], value: false }],
        actions: { collect: [{ when: [], effects: [] }] },
      },
    })

    const map = mapDefinitionSchema.parse({
      ...garden,
      objects: [
        {
          id: 'pickup',
          label: 'Pickup',
          x: 1,
          y: 0,
          terrain: 'grass',
          action: 'collect',
          visible: false,
          states: [{ id: 'reveal', when: { path: ['collected'], value: true }, visible: true }],
        },
      ],
    })

    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const object = map.objects![0]!
    const state = object.states![0]!

    const before = Buffer.from(
      JSON.stringify({
        ...map,
        objects: [{ ...object, extension: 'object', states: [{ ...state, extension: 'state' }] }],
      }),
    )

    await workspace.write('game/maps/garden.json', before)
    delete object.visible
    delete state.visible
    state.blocking = false
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const after = await workspace.read('game/maps/garden.json')
    expect(JSON.parse(Buffer.from(after).toString()).objects).toEqual([
      { ...object, extension: 'object', states: [{ ...state, extension: 'state' }] },
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(after)
  })

  it('persists copied and moved building groups and restores exact bytes through undo and redo', async () => {
    const map = new MapDraft(garden)
    map.resize(6, 4, 'grass')
    map.addLayer('buildings')
    map.paint(1, 1, 'wall', 'buildings')
    map.paint(2, 1, 'wall', 'buildings')
    await apply({ type: 'game.upsertMap', mapId: 'city', map: map.data })
    const before = await workspace.read('game/maps/city.json')
    const selection = new MapTileSelection()
    selection.begin('buildings', { x: 1, y: 1 })
    selection.extend('buildings', { x: 2, y: 1 })
    selection.copy(map, 'buildings', true)
    selection.paste(map, 'buildings', { x: 3, y: 2 })
    await apply({ type: 'game.upsertMap', mapId: 'city', map: map.data })
    const moved = await workspace.read('game/maps/city.json')
    expect((await service.inspect('game')).maps!.city!.layers![0]!.tiles[1]![1]).toBeNull()
    expect((await service.inspect('game')).maps!.city!.layers![0]!.tiles[2]!.slice(3, 5)).toEqual([
      'wall',
      'wall',
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/city.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/maps/city.json')).toEqual(moved)
  })

  it('saves separate layers, preserves layer extensions, rejects blocked spawns, and restores exact layer history', async () => {
    const map = structuredClone(garden)
    map.tiles[1]![1] = 'grass'
    map.layers = [
      {
        id: 'objects',
        name: 'Trees',
        tiles: [
          [null, 'wall'],
          [null, null],
        ],
      },
    ]
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    await apply({
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: {
        id: 'map',
        type: 'map-view',
        label: 'Garden',
        map: 'garden',
        placement: { row: 2, column: 1, rowSpan: 2, columnSpan: 2 },
        viewport: { columns: 2, rows: 2, x: 0, y: 0 },
        playerSpawn: { x: 0, y: 0 },
      },
    })

    const extended = Buffer.from(
      JSON.stringify({ ...map, layers: [{ ...map.layers[0], extension: 'keep' }] }),
    )

    await workspace.write('game/maps/garden.json', extended)
    map.layers[0]!.tiles[1]![0] = 'wall'
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    const saved = JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString())
    expect(saved.layers[0].extension).toBe('keep')
    expect(saved.tiles).toEqual([
      ['grass', 'grass'],
      ['grass', 'grass'],
    ])
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(extended)
    await restore('redo')
    expect((await service.inspect('game')).maps!.garden!.layers![0]!.tiles[1]![0]).toBe('wall')
    const beforeRejected = await workspace.read('game/maps/garden.json')
    map.layers[0]!.tiles[0]![0] = 'wall'
    await expect(apply({ type: 'game.upsertMap', mapId: 'garden', map })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('blocked terrain') }),
      ]),
    })
    expect(await workspace.read('game/maps/garden.json')).toEqual(beforeRejected)
    delete map.layers
    await apply({ type: 'game.upsertMap', mapId: 'garden', map })
    expect(
      JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString()).layers,
    ).toBeUndefined()
  })

  it('persists tilesets and clears image or color selections with exact undo/redo recovery', async () => {
    await mkdir(join(root, 'game/assets'), { recursive: true })
    await workspace.write(
      'game/assets/tiles.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="32" height="32" fill="#336633"/><circle cx="48" cy="16" r="8" fill="#ffffff"/></svg>',
      ),
    )
    await apply({
      type: 'assets.upsertImage',
      id: 'tiles',
      image: imageAssetSchema.parse({
        format: 'svg',
        source: 'assets/tiles.svg',
        bounds: { x: 0, y: 0, width: 64, height: 32 },
      }),
    })
    const tiled = structuredClone(garden)
    tiled.tilesets = { nature: { image: 'tiles', tileWidth: 32, tileHeight: 32 } }
    tiled.terrain.grass!.tile = { tileset: 'nature', column: 1, row: 0 }
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: tiled })
    const original = await workspace.read('game/maps/garden.json')
    delete tiled.terrain.grass!.color
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: tiled })
    expect((await service.inspect('game')).maps!.garden!.terrain.grass!.color).toBeUndefined()
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(original)
    await restore('redo')
    expect((await service.inspect('game')).maps!.garden!.terrain.grass!.tile).toEqual({
      tileset: 'nature',
      column: 1,
      row: 0,
    })
    delete tiled.terrain.grass!.tile
    delete tiled.tilesets
    tiled.terrain.grass!.color = '#334455'
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: tiled })
    const saved = JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString())
    expect(saved.tilesets).toBeUndefined()
    expect(saved.terrain.grass.tile).toBeUndefined()
    expect(saved.terrain.grass.color).toBe('#334455')
  })

  it('creates a referenced map, edits terrain and tiles, and loads it through a scene map view', async () => {
    const created = await apply({
      type: 'game.upsertMap',
      mapId: 'garden',
      map: garden,
      createOnly: true,
    })

    expect(created.view.game!.maps).toEqual(['garden'])
    expect(created.createdFiles).toEqual(['maps/garden.json'])
    expect(created.view.maps!.garden).toEqual(garden)
    await apply({
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: {
        id: 'map',
        type: 'map-view',
        label: 'Garden',
        map: 'garden',
        placement: { row: 1, column: 1, rowSpan: 2, columnSpan: 2 },
        viewport: { rows: 2, columns: 2, x: 0, y: 0 },
        playerSpawn: { x: 0, y: 0 },
      },
    })
    const edited = structuredClone(garden)
    edited.terrain.grass!.movementCostMs = 250
    edited.tiles[0]![1] = 'wall'
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: edited })

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) => Buffer.from(await workspace.read(`game/${path}`)).toString(),
          readBytes: (path) => workspace.read(`game/${path}`),
        },
        logger,
      ),
    ).load()

    const view = game.scenes
      .get('adventure')!
      .components.find((component) => component.type === 'map-view')!

    expect(view.type).toBe('map-view')

    if (view.type !== 'map-view') throw new Error('Expected a map view')
    expect(view.map).toEqual(edited)
    expect(getMapMovementCostMs(view.map, { x: 1, y: 0 })).toBeUndefined()
    expect(getMapMovementCostMs(view.map, { x: 0, y: 0 })).toBe(250)
  })

  it('keeps source extensions and restores exact file contents for edits, creation and deletion', async () => {
    const beforeManifest = await workspace.read('game/game.json')
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    await restore('undo')
    await expect(workspace.read('game/maps/garden.json')).rejects.toHaveProperty('code', 'ENOENT')
    expect(await workspace.read('game/game.json')).toEqual(beforeManifest)
    await restore('redo')

    const original = Buffer.from(
      `${JSON.stringify({ ...garden, extension: 'map', terrain: { ...garden.terrain, grass: { ...garden.terrain.grass, extension: 'terrain' } } })}\n\n`,
    )

    await workspace.write('game/maps/garden.json', original)
    const edited = structuredClone(garden)
    delete edited.terrain.wall!.movementCostMs
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: edited })

    const saved = object(
      JSON.parse(Buffer.from(await workspace.read('game/maps/garden.json')).toString()),
    )

    expect(saved.extension).toBe('map')
    expect(object(object(saved.terrain).grass).extension).toBe('terrain')
    expect(object(object(saved.terrain).wall).movementCostMs).toBeUndefined()
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(original)
    await apply({ type: 'game.removeMap', mapId: 'garden' })
    await expect(workspace.read('game/maps/garden.json')).rejects.toHaveProperty('code', 'ENOENT')
    await restore('undo')
    expect(await workspace.read('game/maps/garden.json')).toEqual(original)
    await restore('redo')
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'garden', map: garden, createOnly: true }),
    ).resolves.toMatchObject({ diagnostics: [] })
  })

  it('rejects stale revisions, collisions and unreferenced files without overwriting them', async () => {
    const first = await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'Garden', map: garden }),
    ).rejects.toMatchObject({ code: 'map_exists' })
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'garden', map: garden, createOnly: true }),
    ).rejects.toMatchObject({ code: 'map_exists' })
    const external = Buffer.from(`${JSON.stringify(garden)}\n\n`)
    await workspace.write('game/maps/garden.json', external)
    await expect(
      service.apply({
        path: 'game',
        expectedRevision: first.view.revision,
        command: { type: 'game.upsertMap', mapId: 'garden', map: garden },
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(await workspace.read('game/maps/garden.json')).toEqual(external)
    await workspace.write('game/maps/orphan.json', Buffer.from('outside file'))
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'orphan', map: garden }),
    ).rejects.toMatchObject({ status: 409 })
    expect(Buffer.from(await workspace.read('game/maps/orphan.json')).toString()).toBe(
      'outside file',
    )
  })

  it('rejects changes that break scene viewports, player spawns, terrain references or map links', async () => {
    await apply({ type: 'game.upsertMap', mapId: 'garden', map: garden })
    await apply({
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: {
        id: 'map',
        type: 'map-view',
        label: 'Garden',
        map: 'garden',
        placement: { row: 1, column: 1, rowSpan: 2, columnSpan: 2 },
        viewport: { rows: 2, columns: 2, x: 0, y: 0 },
        playerSpawn: { x: 0, y: 0 },
      },
    })
    const original = await workspace.read('game/maps/garden.json')
    const blocked = structuredClone(garden)
    blocked.terrain.grass!.walkable = false
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'garden', map: blocked }),
    ).rejects.toMatchObject({ status: 422 })
    const cropped = { ...garden, width: 1, tiles: [['grass'], ['grass']] }
    await expect(
      apply({ type: 'game.upsertMap', mapId: 'garden', map: cropped }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(apply({ type: 'game.removeMap', mapId: 'garden' })).rejects.toMatchObject({
      status: 422,
    })
    const view = await service.inspect('game')

    const invalid = async () =>
      service.apply({
        path: 'game',
        expectedRevision: view.revision,
        command: {
          type: 'game.upsertMap',
          mapId: 'garden',
          map: { ...garden, tiles: [['missing']] },
        },
      })

    await expect(invalid()).rejects.toMatchObject({ status: 400 })
    expect(await workspace.read('game/maps/garden.json')).toEqual(original)
    expect((await service.inspect('game')).game!.maps).toEqual(['garden'])
  })

  it.each(['before-manifest', 'after-manifest', 'after-create'] as const)(
    'keeps new maps consistent after a failure: %s',
    async (failure) => {
      const before = await service.inspect('game')
      let failed = false

      const injected: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        create: async (path, bytes) => {
          await workspace.create(path, bytes)

          if (!failed && failure === 'after-create') {
            failed = true
            throw new Error('Injected map failure')
          }
        },
        write: async (path, bytes) => {
          if (!failed && path.endsWith('/game.json')) {
            failed = true

            if (failure === 'after-manifest') await workspace.write(path, bytes)
            throw new Error('Injected map failure')
          }

          return workspace.write(path, bytes)
        },
      }

      const failing = new EditorProjectService(
        new WorkspaceProjectRepository(injected),
        new EditorCoordinator(),
      )

      const saving = failing.apply({
        path: 'game',
        expectedRevision: before.revision,
        command: { type: 'game.upsertMap', mapId: 'garden', map: garden },
      })

      if (failure === 'after-manifest')
        await expect(saving).resolves.toMatchObject({ view: { game: { maps: ['garden'] } } })
      else {
        await expect(saving).rejects.toThrow('Injected map failure')
        expect((await service.inspect('game')).revision).toBe(before.revision)
        await expect(workspace.read('game/maps/garden.json')).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
        await expect(
          apply({ type: 'game.upsertMap', mapId: 'garden', map: garden }),
        ).resolves.toMatchObject({ diagnostics: [] })
      }
    },
  )
})
