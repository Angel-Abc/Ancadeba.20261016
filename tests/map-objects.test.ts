import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  gameSchema,
  inputSchema,
  sceneSchema,
  mapDefinitionSchema,
  gameRulesSchema,
  getMapMovementCostMs,
  resolveMapObject,
  type MapDefinition,
  type GameRulesDefinition,
} from '@ancadeba/schemas'
import {
  assembleGameData,
  canEnterScene,
  Engine,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { inspectProject } from '@ancadeba/editor-core'

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'objects',
  title: 'Objects',
  version: '1',
  scenes: ['first', 'second'],
  maps: ['world'],
  rules: ['objects'],
  input: 'keys',
  'initial-scene': 'first',
})

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['interact'],
  keyboard: { KeyE: 'interact' },
  contexts: { explore: { interact: 'interact' } },
  'initial-context': 'explore',
})

const map = mapDefinitionSchema.parse({
  'schema-version': '1.0.0',
  type: 'square-grid',
  width: 5,
  height: 4,
  terrain: {
    ground: { color: '#ffffff' },
    road: { color: '#aaaaaa', movementCostMs: 100 },
    wall: { color: '#000000', walkable: false },
  },
  tiles: [
    ['ground', 'ground', 'ground', 'ground', 'ground'],
    ['ground', 'ground', 'ground', 'ground', 'ground'],
    ['ground', 'road', 'ground', 'ground', 'ground'],
    ['ground', 'ground', 'ground', 'ground', 'ground'],
  ],
  objects: [
    { id: 'sign', label: 'Signpost', x: 2, y: 1, terrain: 'wall', action: 'read' },
    { id: 'chest', label: 'Chest', x: 4, y: 3, terrain: 'wall', action: 'travel' },
    { id: 'rug', label: 'Rug', x: 1, y: 3, terrain: 'wall', action: 'read', blocking: false },
  ],
})

const rules = gameRulesSchema.parse({
  state: [{ path: ['read'], value: false }],
  actions: {
    read: [
      {
        when: [{ type: 'payload-is-target', target: 'sign' }],
        effects: [{ type: 'set-state', path: ['read'], value: true }],
      },
    ],
    travel: [{ when: [], effects: [{ type: 'enter-scene', scene: 'second' }] }],
  },
})

const scenes = new Map(
  ['first', 'second'].map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      type: 'game',
      screen: { type: 'grid', grid: { rows: 2, columns: 1 } },
      components: [
        {
          id: 'map',
          type: 'map-view',
          label: 'World',
          map: 'world',
          viewport: { columns: 5, rows: 4 },
          playerSpawn: { x: 1, y: 1 },
          placement: { row: 1, column: 1 },
        },
        {
          id: 'other-map',
          type: 'map-view',
          label: 'Other',
          map: 'world',
          viewport: { columns: 5, rows: 4 },
          playerSpawn: { x: 0, y: 0 },
          placement: { row: 1, column: 1 },
        },
        {
          id: 'actions',
          type: 'action-bar',
          placement: { row: 2, column: 1 },
          slots: {
            '1': {
              label: 'Interact',
              action: { type: 'interact-map', mapView: 'map' },
              inputBinding: { context: 'explore', input: 'interact' },
            },
            '2': {
              label: 'Read sign',
              action: { type: 'interact-map', mapView: 'map', object: 'sign' },
            },
          },
        },
        {
          id: 'interact',
          type: 'button',
          label: 'Interact',
          action: { type: 'interact-map', mapView: 'map' },
          placement: { row: 2, column: 1 },
        },
      ],
    }),
  ]),
)

async function setup(candidate: MapDefinition = map, authoredRules: GameRulesDefinition = rules) {
  const data = assembleGameData(
    manifest,
    scenes,
    input,
    undefined,
    new Map([['world', candidate]]),
    undefined,
    undefined,
    new Map([['objects', authoredRules]]),
  )

  const tasks: (() => void)[] = []
  const messages = new MessageBus<EngineMessages>()
  const applied: string[] = []
  messages.subscribe('action.applied', ({ request }) => {
    applied.push(request.action)
  })

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => messages,
    {
      clock: { now: () => 0 },
      scheduler: {
        schedule(callback, delay) {
          if (delay) tasks.push(callback)

          return () => {}
        },
      },
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  const game = lifecycle.currentGame!
  const scene = lifecycle.activeScene!

  const flush = () => {
    for (let i = 0; i < 6; i++) engine.flushMessages()
  }

  flush()

  return {
    data,
    engine,
    lifecycle,
    game,
    scene,
    objects: game.mapObjects!,
    movement: game.mapMovement!,
    bar: game.actionBar!,
    tasks,
    applied,
    flush,
  }
}

describe('placeable map objects', () => {
  it('checks initial object overrides before a playthrough and live overrides during play', async () => {
    const candidate = structuredClone(map)
    candidate.objects![0]!.states = [
      { id: 'open', when: { path: ['read'], value: false }, blocking: false },
    ]
    const { data, game, movement, flush } = await setup(candidate)

    const action = {
      type: 'enter-scene' as const,
      scene: 'second',
      mapView: 'map',
      position: { x: 2, y: 1 },
    }

    expect(canEnterScene(data, action)).toBe(true)
    expect(canEnterScene(data, action, movement)).toBe(true)
    game.actions!.request('read', 'sign')
    flush()
    expect(canEnterScene(data, action, movement)).toBe(false)
    expect(canEnterScene(data, action)).toBe(true)
  })

  const statefulMap = () => {
    const candidate = structuredClone(map)
    candidate.objects![0]!.states = [
      {
        id: 'open',
        when: { path: ['read'], value: true },
        terrain: 'ground',
        label: 'Open sign',
        blocking: false,
      },
    ]

    return candidate
  }

  it('updates appearance, collision and entrances from authored state while preserving the interaction target', async () => {
    const { scene, objects, movement, lifecycle, flush } = await setup(statefulMap())
    const target = objects.getTarget(scene, 'map', 'sign')!
    expect(objects.getAppearance(scene, 'map', 'sign')).toBe(target)
    expect(movement.canMove(scene, 'map', 'east')).toBe(false)
    expect(() =>
      lifecycle.enterScene('second', { mapView: 'map', position: { x: 2, y: 1 } }),
    ).toThrow('Invalid destination')
    let updates = 0
    const unsubscribe = objects.subscribeChanges(() => updates++)
    objects.interact(scene, 'map', 'sign')
    flush()
    expect(updates).toBeGreaterThan(0)
    expect(objects.getAppearance(scene, 'map', 'sign')).toMatchObject({
      terrain: 'ground',
      label: 'Open sign',
      blocking: false,
    })
    expect(objects.getTarget(scene, 'map', 'sign')).toBe(target)
    expect(target.label).toBe('Signpost')
    expect(movement.canMove(scene, 'map', 'east')).toBe(true)
    expect(objects.interact(scene, 'map', 'sign')).toBe(true)
    flush()
    lifecycle.enterScene('second', { mapView: 'map', position: { x: 2, y: 1 } })
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 2, y: 1 })
    unsubscribe()
  })

  it('uses only the first matching state and inherits unspecified overrides from the base object', () => {
    const object = statefulMap().objects![0]!
    object.states!.unshift({
      id: 'label-only',
      when: { path: ['read'], value: true },
      label: 'First match',
    })
    expect(resolveMapObject(object, () => true)).toMatchObject({
      label: 'First match',
      terrain: 'wall',
      blocking: undefined,
    })
    expect(resolveMapObject(object, () => undefined)).toBe(object)
    expect(resolveMapObject(object, () => false)).toBe(object)
    expect(resolveMapObject(object)).toBe(object)
  })

  it('hides collected objects from explicit and automatic targets, drops queued repeats and removes blocking', async () => {
    const candidate = structuredClone(map)
    candidate.objects![0]!.states = [
      { id: 'collected', when: { path: ['read'], value: true }, visible: false },
    ]
    const { scene, objects, movement, bar, applied, flush, lifecycle } = await setup(candidate)
    expect(objects.getAppearance(scene, 'map', 'sign')?.visible).toBeUndefined()
    expect(movement.canMove(scene, 'map', 'east')).toBe(false)
    expect(objects.interact(scene, 'map', 'sign')).toBe(true)
    expect(objects.interact(scene, 'map', 'sign')).toBe(true)
    flush()
    expect(applied).toEqual(['read'])
    expect(objects.getAppearance(scene, 'map', 'sign')).toMatchObject({
      visible: false,
      terrain: 'wall',
    })
    expect(objects.getTarget(scene, 'map')).toBeUndefined()
    expect(objects.getTarget(scene, 'map', 'sign')).toBeUndefined()
    expect(objects.interact(scene, 'map', 'sign')).toBe(false)
    expect(bar.isEnabled(scene, 'actions', '1')).toBe(false)
    expect(bar.isEnabled(scene, 'actions', '2')).toBe(false)
    expect(movement.canMove(scene, 'map', 'east')).toBe(true)
    lifecycle.enterScene('second', { mapView: 'map', position: { x: 2, y: 1 } })
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 2, y: 1 })
  })

  it('ignores hidden neighbors when automatically targeting and supports revealing initially hidden objects', async () => {
    const candidate = structuredClone(map)
    candidate.objects!.push({
      id: 'north',
      label: 'Hidden neighbor',
      x: 1,
      y: 0,
      terrain: 'wall',
      action: 'travel',
      visible: false,
      states: [{ id: 'reveal', when: { path: ['read'], value: true }, visible: true }],
    })
    expect(getMapMovementCostMs(candidate, { x: 1, y: 0 })).toBe(0)
    const { scene, objects, movement, flush } = await setup(candidate)
    expect(objects.getTarget(scene, 'map')?.id).toBe('sign')
    expect(objects.interact(scene, 'map', 'north')).toBe(false)
    expect(movement.canMove(scene, 'map', 'north')).toBe(true)
    objects.interact(scene, 'map')
    flush()
    expect(objects.getAppearance(scene, 'map', 'north')?.visible).toBe(true)
    expect(objects.getTarget(scene, 'map')).toBeUndefined()
    expect(objects.getTarget(scene, 'map', 'north')?.id).toBe('north')
    expect(movement.canMove(scene, 'map', 'north')).toBe(false)
    candidate.tiles[0]![1] = 'wall'
    expect(getMapMovementCostMs(candidate, { x: 1, y: 0 })).toBeUndefined()
  })

  it('inherits base visibility and uses only the first matching visibility override, including false-valued flags', () => {
    const object = {
      ...map.objects![0]!,
      visible: false,
      states: [
        { id: 'first', when: { path: ['read'], value: false }, label: 'Still hidden' },
        { id: 'second', when: { path: ['read'], value: false }, visible: true },
      ],
    }

    expect(mapDefinitionSchema.safeParse({ ...map, objects: [object] }).success).toBe(true)
    expect(resolveMapObject(object, () => false)).toMatchObject({
      visible: false,
      label: 'Still hidden',
    })
    object.states.reverse()
    expect(resolveMapObject(object, () => false).visible).toBe(true)
    expect(resolveMapObject(object, () => undefined).visible).toBe(false)
  })

  it.each(['blocking', 'visibility'])(
    'cancels arrival onto a newly blocked tile via %s, without firing its entry trigger, and lets an occupant leave',
    async (mode) => {
      const candidate = statefulMap()

      if (mode === 'visibility') {
        delete candidate.objects![0]!.states![0]!.blocking
        candidate.objects![0]!.states![0]!.visible = false
      }

      candidate.tiles[1]![2] = 'road'
      candidate.entryTriggers = [{ id: 'entry', x: 2, y: 1, action: 'travel' }]
      const authoredRules = structuredClone(rules)
      authoredRules.actions.close = [
        { when: [], effects: [{ type: 'set-state', path: ['read'], value: false }] },
      ]

      const { scene, objects, movement, game, tasks, flush, lifecycle, applied } = await setup(
        candidate,
        authoredRules,
      )

      objects.interact(scene, 'map', 'sign')
      flush()
      expect(movement.move(scene, 'map', 'east')).toBe(true)
      game.actions!.request('close')
      flush()
      tasks[0]!()
      flush()
      expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
      expect(movement.isMoving(scene, 'map')).toBe(false)
      expect(game.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
      expect(lifecycle.activeScene).toBe(scene)
      expect(applied).not.toContain('travel')
      objects.interact(scene, 'map', 'sign')
      flush()
      movement.place(scene, 'map', { x: 2, y: 1 })
      game.actions!.request('close')
      flush()
      expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 1 })
      expect(movement.move(scene, 'map', 'west')).toBe(true)
      expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
      expect(game.actions!.progression).toEqual({ turn: 1, worldTimeMs: 0 })
    },
  )

  it('runs the authored action with its object ID from a cardinally adjacent tile', async () => {
    const { scene, objects, applied, flush, game, movement } = await setup()
    expect(objects.interact(scene, 'map')).toBe(true)
    flush()
    expect(applied).toEqual(['read'])
    expect(game.state).toEqual(new Map([['read', true]]))
    expect(movement.canMove(scene, 'map', 'east')).toBe(false)
    expect(objects.getTarget(scene, 'other-map', 'sign')).toBeUndefined()
  })

  it('routes mapped Interact keys and specific action-bar targets through the same adjacency checks', async () => {
    const { engine, scene, bar, movement, applied, flush } = await setup()
    expect(bar.isEnabled(scene, 'actions', '1')).toBe(true)
    engine.input!.pressKey('KeyE')
    engine.input!.releaseKey('KeyE')
    flush()
    bar.activate(scene, 'actions', '2')
    flush()
    expect(applied).toEqual(['read', 'read'])
    movement.place(scene, 'map', { x: 0, y: 0 })
    expect(bar.isEnabled(scene, 'actions', '1')).toBe(false)
    bar.activate(scene, 'actions', '2')
    flush()
    expect(applied).toEqual(['read', 'read'])
  })

  it('rejects diagonal, distant, same-tile, stale-scene and invalid-view targets', async () => {
    const { lifecycle, scene, objects, movement, applied, flush } = await setup()
    movement.place(scene, 'map', { x: 1, y: 0 })
    expect(objects.interact(scene, 'map', 'sign')).toBe(false)
    movement.place(scene, 'map', { x: 1, y: 3 })
    expect(objects.interact(scene, 'map', 'rug')).toBe(false)
    expect(objects.interact(scene, 'map', 'chest')).toBe(false)
    expect(objects.interact(scene, 'missing', 'sign')).toBe(false)
    lifecycle.enterScene('second')
    expect(objects.interact(scene, 'map', 'sign')).toBe(false)
    flush()
    expect(applied).toEqual([])
  })

  it('disables interaction during a timed step and drops actions queued before walking away', async () => {
    const { scene, objects, movement, tasks, applied, flush } = await setup()
    expect(objects.interact(scene, 'map', 'sign')).toBe(true)
    movement.move(scene, 'map', 'south')
    expect(objects.interact(scene, 'map', 'sign')).toBe(false)
    flush()
    expect(applied).toEqual([])
    tasks[0]!()
    flush()
    expect(objects.interact(scene, 'map', 'sign')).toBe(false)
  })

  it('does not deliver old interactions after leaving and returning to a scene or ending a game', async () => {
    const { lifecycle, scene, objects, applied, flush } = await setup()
    objects.interact(scene, 'map', 'sign')
    lifecycle.enterScene('second')
    lifecycle.enterScene('first')
    flush()
    expect(applied).toEqual([])
    objects.interact(lifecycle.activeScene!, 'map', 'sign')
    lifecycle.startGame()
    lifecycle.enterScene('first')
    flush()
    expect(applied).toEqual([])
    expect(objects.interact(lifecycle.activeScene!, 'map', 'sign')).toBe(false)
  })

  it('requires an explicit choice when multiple objects are adjacent', async () => {
    const candidate = structuredClone(map)
    candidate.objects!.push({
      id: 'north',
      label: 'North sign',
      x: 1,
      y: 0,
      terrain: 'ground',
      action: 'travel',
    })
    const { scene, objects, bar, applied, flush } = await setup(candidate)
    expect(objects.getTarget(scene, 'map')).toBeUndefined()
    expect(bar.isEnabled(scene, 'actions', '1')).toBe(false)
    expect(objects.interact(scene, 'map', 'sign')).toBe(true)
    flush()
    expect(applied).toEqual(['read'])
  })

  it('captures the original keyboard target rather than retargeting before queued delivery', async () => {
    const { engine, scene, lifecycle, movement, applied, flush } = await setup()
    engine.input!.pressKey('KeyE')
    engine.input!.releaseKey('KeyE')
    movement.place(scene, 'map', { x: 3, y: 3 })
    flush()
    expect(applied).toEqual([])
    expect(lifecycle.activeScene).toBe(scene)
  })

  it('allows passable object tiles while keeping blocking objects unavailable as entrances', async () => {
    expect(getMapMovementCostMs(map, { x: 1, y: 3 })).toBe(0)
    expect(getMapMovementCostMs(map, { x: 2, y: 1 })).toBeUndefined()
    const { lifecycle, scene } = await setup()
    expect(() =>
      lifecycle.enterScene('second', { mapView: 'map', position: { x: 2, y: 1 } }),
    ).toThrow('Invalid destination map position')
    expect(lifecycle.activeScene).toBe(scene)
  })
})

describe('map object validation', () => {
  it.each([['missing'], ['count']])(
    'rejects missing or nonboolean state fields in loading and editor diagnostics: %s',
    (path) => {
      const candidate = structuredClone(map)
      candidate.objects![0]!.states = [
        { id: 'open', when: { path: [path], value: true }, blocking: false },
      ]
      const authoredRules = { ...rules, state: [...rules.state, { path: ['count'], value: 0 }] }
      expect(() =>
        assembleGameData(
          manifest,
          scenes,
          input,
          undefined,
          new Map([['world', candidate]]),
          undefined,
          undefined,
          new Map([['objects', authoredRules]]),
        ),
      ).toThrow('existing boolean Rules state field')

      const view = inspectProject({
        revision: 'one',
        documents: {
          'game.json': manifest,
          'maps/world.json': candidate,
          'rules/objects.json': authoredRules,
          'input/keys.json': input,
          ...Object.fromEntries([...scenes].map(([id, value]) => [`scenes/${id}.json`, value])),
        },
      })

      expect(view.diagnostics).toContainEqual(
        expect.objectContaining({
          file: 'maps/world.json',
          message: 'Object states require an existing boolean Rules state field',
        }),
      )
    },
  )

  it('validates player spawns against initial state rather than the default appearance', () => {
    const candidate = structuredClone(map)
    candidate.objects![0]!.x = 1
    candidate.objects![0]!.states = [
      { id: 'open', when: { path: ['read'], value: true }, blocking: false },
    ]

    const assemble = (value: boolean) =>
      assembleGameData(
        manifest,
        scenes,
        input,
        undefined,
        new Map([['world', candidate]]),
        undefined,
        undefined,
        new Map([['objects', { ...rules, state: [{ path: ['read'], value }] }]]),
      )

    expect(() => assemble(true)).not.toThrow()
    expect(() => assemble(false)).toThrow('initial object state')
  })

  it('permits conditionally hidden objects on spawns while rejecting initial visibility that blocks them', () => {
    const candidate = structuredClone(map)
    candidate.objects![0]!.x = 1
    candidate.objects![0]!.states = [
      { id: 'hidden', when: { path: ['read'], value: true }, visible: false },
    ]

    const assemble = (value: boolean) =>
      assembleGameData(
        manifest,
        scenes,
        input,
        undefined,
        new Map([['world', candidate]]),
        undefined,
        undefined,
        new Map([['objects', { ...rules, state: [{ path: ['read'], value }] }]]),
      )

    expect(() => assemble(true)).not.toThrow()
    expect(() => assemble(false)).toThrow('initial object state')
  })

  it.each([
    [{ id: 'open', when: { path: ['read'], value: true } }],
    [{ id: 'open', when: { path: ['read'], value: 'true' }, blocking: false }],
    [{ id: 'hidden', when: { path: ['read'], value: true }, visible: 'false' }],
    [{ id: 'open', when: { path: ['read'], value: true }, terrain: 'missing' }],
    [
      { id: 'same', when: { path: ['read'], value: true }, blocking: false },
      { id: 'same', when: { path: ['read'], value: false }, blocking: true },
    ],
  ])('rejects malformed or duplicate object states %#', (...states) => {
    expect(
      mapDefinitionSchema.safeParse({ ...map, objects: [{ ...map.objects![0], states }] }).success,
    ).toBe(false)
  })

  it('rejects unknown explicit Interact targets and noninteractive map views', () => {
    const first = scenes.get('first')!
    const invalid = new Map(scenes)
    invalid.set(
      'first',
      sceneSchema.parse({
        ...first,
        components: first.components.map((component) =>
          component.type === 'button'
            ? { ...component, action: { type: 'interact-map', mapView: 'map', object: 'missing' } }
            : component,
        ),
      }),
    )
    expect(() =>
      assembleGameData(
        manifest,
        invalid,
        input,
        undefined,
        new Map([['world', map]]),
        undefined,
        undefined,
        new Map([['objects', rules]]),
      ),
    ).toThrow('Unknown map object: missing')
    expect(
      sceneSchema.safeParse({
        ...first,
        components: first.components.map((component) =>
          component.id === 'map' ? { ...component, interactive: false } : component,
        ),
      }).success,
    ).toBe(false)
    expect(() =>
      assembleGameData(
        manifest,
        scenes,
        input,
        undefined,
        new Map([
          [
            'world',
            {
              ...map,
              objects: [
                ...map.objects!,
                {
                  id: 'spawn',
                  label: 'Blocked spawn',
                  x: 1,
                  y: 1,
                  action: 'read',
                  terrain: 'wall',
                },
              ],
            },
          ],
        ]),
        undefined,
        undefined,
        new Map([['objects', rules]]),
      ),
    ).toThrow('blocked terrain')
  })

  it.each([
    [{ ...map.objects![0], x: 5 }],
    [{ ...map.objects![0], x: -1 }],
    [{ ...map.objects![0], y: 0.5 }],
    [{ ...map.objects![0], label: '' }],
    [{ ...map.objects![0], terrain: 'missing' }],
    [map.objects![0], { ...map.objects![0], x: 3 }],
    [map.objects![0], { ...map.objects![0], id: 'duplicate-tile' }],
  ])('rejects malformed or duplicate objects %#', (...objects) => {
    expect(mapDefinitionSchema.safeParse({ ...map, objects }).success).toBe(false)
  })

  it('rejects missing authored actions in both editor validation and runtime loading', () => {
    const candidate = { ...map, objects: [{ ...map.objects![0]!, action: 'missing' }] }
    expect(() =>
      assembleGameData(
        manifest,
        scenes,
        input,
        undefined,
        new Map([['world', candidate]]),
        undefined,
        undefined,
        new Map([['objects', rules]]),
      ),
    ).toThrow('Unknown map object action')

    const view = inspectProject({
      revision: 'one',
      documents: {
        'game.json': manifest,
        'maps/world.json': candidate,
        'rules/objects.json': rules,
        'input/keys.json': input,
        ...Object.fromEntries([...scenes].map(([id, value]) => [`scenes/${id}.json`, value])),
      },
    })

    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'maps/world.json',
          message: 'Unknown map object action: missing',
        }),
      ]),
    )
  })
})
