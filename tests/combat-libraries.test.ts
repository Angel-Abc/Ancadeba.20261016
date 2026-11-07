import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  combatLibraryIssues,
  resolveCombatSource,
  localizeCombat,
  gameSchema,
  gameRulesSchema,
  sceneSchema,
  inputSchema,
} from '@ancadeba/schemas'
import {
  applyCommand,
  inspectProject,
  validateProject,
  object,
  projectViewSchema,
} from '@ancadeba/editor-core'
import { Engine, GameLoader, assembleGameData, type EngineMessages } from '@ancadeba/game-runtime'
import { MessageBus, JsonResourceLoader } from '@ancadeba/utilities'

const field = (id: string) => ({ source: 'game.state' as const, path: [id] })

const library = combatLibrarySchema.parse({
  'schema-version': '1.0.0',
  id: 'common',
  moves: {
    poison: {
      type: 'ability',
      label: 'Poison',
      apCost: 1,
      cooldown: 2,
      target: 'enemy',
      effects: [{ id: 'apply', type: 'apply-status', status: 'poison' }],
    },
    cleanse: {
      type: 'ability',
      label: 'Cleanse',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'remove', type: 'remove-status', status: 'poison' }],
    },
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 1, max: 2 } },
  },
  statuses: { poison: { type: 'damage', label: 'Poisoned', duration: 3, amount: 2 } },
})

const libraries = new Map([['common', library]])

const source = combatSourceSchema.parse({
  'schema-version': '1.0.0',
  id: 'first',
  label: 'First',
  player: {
    id: 'player',
    label: 'Player',
    health: field('hp'),
    maximumHealth: 100,
    moves: ['attack', 'poison'],
  },
  enemies: [
    {
      id: 'enemy',
      label: 'Enemy',
      health: field('enemy'),
      maximumHealth: 100,
      moves: ['attack'],
      rotation: ['attack'],
    },
  ],
  sharedMoves: [
    { library: 'common', id: 'attack' },
    { library: 'common', id: 'poison' },
  ],
})

const second = combatSourceSchema.parse({
  ...source,
  id: 'second',
  enemies: [{ ...source.enemies[0], health: field('other') }],
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'test',
  title: 'Test',
  version: '1',
  'initial-scene': 'first',
  scenes: ['first', 'second'],
  combat: ['first', 'second'],
  combatLibraries: ['common'],
  rules: ['values'],
  input: 'keys',
})

const rules = gameRulesSchema.parse({
  state: ['hp', 'enemy', 'other'].map((id) => ({ path: [id], value: 100 })),
  actions: {},
})

const scenes = new Map(
  ['first', 'second'].map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      type: 'game',
      screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
      components: [
        { id: 'combat', type: 'combat', encounter: id, placement: { row: 1, column: 1 } },
        {
          id: 'bar',
          type: 'action-bar',
          placement: { row: 5, column: 1 },
          slots: {
            '1': {
              label: 'Poison',
              action: {
                type: 'combat-action',
                combat: 'combat',
                command: { type: 'queue-move', move: 'poison' },
              },
              inputBinding: { context: 'play', input: 'poison' },
            },
            '15': {
              label: 'End turn',
              action: { type: 'combat-action', combat: 'combat', command: { type: 'end-turn' } },
              inputBinding: { context: 'play', input: 'end' },
            },
          },
        },
      ],
    }),
  ]),
)

const keys = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['primary', 'end'],
  keyboard: { KeyQ: 'primary', KeyB: 'end' },
  contexts: { play: { primary: 'poison', end: 'end' } },
  'initial-context': 'play',
})

function documents() {
  return {
    'game.json': manifest,
    'rules/values.json': rules,
    'input/keys.json': keys,
    'combat/first.json': source,
    'combat/second.json': second,
    'combat-libraries/common.json': library,
    ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
  }
}

describe('shared combat definition resolution', () => {
  it('resolves dependencies once, preserves IDs and origins, and leaves authored data untouched', () => {
    const before = JSON.stringify({ source, library })

    const resolved = resolveCombatSource(
      {
        ...source,
        sharedMoves: [...source.sharedMoves!, { library: 'common', id: 'cleanse' }],
        sharedStatuses: [{ library: 'common', id: 'poison' }],
      },
      libraries,
    )

    expect(resolved.issues).toEqual([])
    expect(Object.keys(resolved.definition!.statuses!)).toEqual(['poison'])
    expect(resolved.definition!.player.moves).toEqual(['attack', 'poison'])
    expect(resolved.origins.statuses.poison).toEqual({
      library: 'common',
      file: 'combat-libraries/common.json',
      path: ['statuses', 'poison'],
    })
    expect(JSON.stringify({ source, library })).toBe(before)
    expect(resolved.definition!.moves.poison).not.toBe(library.moves.poison)
    expect(Object.isFrozen(resolved.definition!.moves.poison)).toBe(true)
  })

  it.each([
    'move',
    'status',
    'library',
    'duplicate',
    'local-move',
    'local-status',
    'other-move',
    'other-status',
  ])('rejects invalid imports: %s', (kind) => {
    const draft = structuredClone(source)
    const all = new Map(libraries)

    if (kind === 'move') draft.sharedMoves!.push({ library: 'common', id: 'missing' })

    if (kind === 'status') draft.sharedStatuses = [{ library: 'common', id: 'missing' }]

    if (kind === 'library') draft.sharedMoves![0]!.library = 'missing'

    if (kind === 'duplicate') draft.sharedMoves!.push({ ...draft.sharedMoves![0]! })

    if (kind === 'local-move') draft.moves.attack = library.moves.attack!

    if (kind === 'local-status') draft.statuses = { poison: library.statuses.poison! }

    if (kind.startsWith('other')) {
      all.set('other', { ...library, id: 'other' })

      if (kind === 'other-move') draft.sharedMoves!.push({ library: 'other', id: 'attack' })
      else draft.sharedStatuses = [{ library: 'other', id: 'poison' }]
    }

    const result = resolveCombatSource(draft, all)
    expect(result.definition).toBeUndefined()
    expect(
      result.issues.some(
        (issue) =>
          issue.file === 'combat/first.json' && issue.path[0]?.toString().startsWith('shared'),
      ),
    ).toBe(true)
  })

  it('rejects duplicate explicit statuses, missing library dependencies and invalid unused entries', () => {
    expect(
      resolveCombatSource(
        {
          ...source,
          sharedStatuses: [
            { library: 'common', id: 'poison' },
            { library: 'common', id: 'poison' },
          ],
        },
        libraries,
      ).issues.some((issue) => issue.message.includes('Duplicate')),
    ).toBe(true)
    expect(combatLibrarySchema.safeParse({ ...library, statuses: {} }).success).toBe(false)

    const invalid = {
      ...library,
      statuses: {
        ...library.statuses,
        unused: { ...library.statuses.poison, labelKey: 'missing', icon: 'missing' },
      },
    }

    expect(
      combatLibraryIssues(combatLibrarySchema.parse(invalid)).map((issue) => issue.path),
    ).toEqual([
      ['statuses', 'unused', 'labelKey'],
      ['statuses', 'unused', 'icon'],
    ])
    expect(
      validateProject({ ...documents(), 'combat-libraries/common.json': invalid }).some(
        (issue) => issue.file === 'combat-libraries/common.json',
      ),
    ).toBe(true)
  })

  it('localizes resolved definitions independently without mutating the library', () => {
    const localized = combatLibrarySchema.parse({
      ...library,
      statuses: { poison: { ...library.statuses.poison, labelKey: 'poison.name' } },
    })

    const result = resolveCombatSource(source, new Map([['common', localized]])).definition!
    expect(
      localizeCombat(result, {
        fallback: { 'poison.name': '<Poison>' },
        messages: { 'poison.name': 'Vergif' },
      }).statuses!.poison!.label,
    ).toBe('Vergif')
    expect(result.statuses!.poison!.label).toBe('Poisoned')
    expect(localized.statuses.poison!.label).toBe('Poisoned')
  })

  it('checks encounter constraints after imports and supports inline-only definitions', () => {
    const statuses = Object.fromEntries(
      Array.from({ length: 101 }, (_, n) => [`status-${n}`, library.statuses.poison!]),
    )

    const huge = combatLibrarySchema.parse({
      ...library,
      moves: { attack: library.moves.attack },
      statuses,
    })

    const result = resolveCombatSource(
      {
        ...source,
        sharedMoves: [{ library: 'common', id: 'attack' }],
        sharedStatuses: Object.keys(statuses).map((id) => ({ library: 'common', id })),
        player: { ...source.player, moves: ['attack'] },
      },
      new Map([['common', huge]]),
    )

    expect(result.issues.some((issue) => issue.message.includes('100 statuses'))).toBe(true)
    expect(
      resolveCombatSource(
        {
          ...source,
          moves: { attack: library.moves.attack! },
          player: { ...source.player, moves: ['attack'] },
          sharedMoves: [],
        },
        new Map(),
      ).definition,
    ).toBeDefined()
  })
})

describe('combat library editing', () => {
  it('exposes authored and resolved views without flattening imports on save', () => {
    const project = { revision: 'one', documents: documents() }
    const view = projectViewSchema.parse(inspectProject(project))
    expect(view.diagnostics).toEqual([])
    expect(view.combatSources!.first!.moves).toEqual({})
    expect(view.combat!.first!.moves.poison).toBeDefined()
    expect(view.combatOrigins!.first!.moves.poison!.library).toBe('common')

    const result = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: { ...view.combatSources!.first!, label: 'Renamed' },
    })

    expect(object(result.project.documents['combat/first.json']).moves).toEqual({})
    expect(object(result.project.documents['combat/first.json']).sharedMoves).toEqual(
      source.sharedMoves,
    )
    expect(() =>
      applyCommand(project, { type: 'game.upsertCombat', encounter: view.combat!.first! }),
    ).toThrow('Include sharedMoves explicitly')
  })

  it('protects referenced libraries, entries, and dependencies', () => {
    const project = { revision: 'one', documents: documents() }
    expect(() =>
      applyCommand(project, { type: 'game.removeCombatLibrary', libraryId: 'common' }),
    ).toThrow()
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, moves: { attack: library.moves.attack! } },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, statuses: {} },
      }),
    ).toThrow()

    const created = applyCommand(project, {
      type: 'game.upsertCombatLibrary',
      library: { 'schema-version': '1.0.0', id: 'unused', moves: {}, statuses: {} },
    })

    expect(created.changedFiles).toEqual(['combat-libraries/unused.json', 'game.json'])

    const removed = applyCommand(created.project, {
      type: 'game.removeCombatLibrary',
      libraryId: 'unused',
    })

    expect(object(removed.project.documents['game.json']).combatLibraries).toEqual(['common'])
  })

  it('copies an ability with explicit dependency imports and preserves raw extension properties', () => {
    const raw = {
      ...library,
      extension: 'library',
      moves: {
        ...library.moves,
        poison: {
          ...library.moves.poison,
          extension: 'move',
          effects: [{ id: 'apply', type: 'apply-status', status: 'poison', extension: 'effect' }],
        },
      },
    }

    const project = {
      revision: 'one',
      documents: { ...documents(), 'combat-libraries/common.json': raw },
    }

    const copied = applyCommand(project, {
      type: 'combat.copySharedEntry',
      encounterId: 'first',
      kind: 'moves',
      reference: { library: 'common', id: 'poison' },
      localId: 'local-poison',
    })

    const saved = object(copied.project.documents['combat/first.json'])
    expect(object(saved.moves)['local-poison']).toMatchObject({
      extension: 'move',
      effects: [{ extension: 'effect' }],
    })
    const draft = combatSourceSchema.parse(saved)
    expect(draft.sharedStatuses).toEqual([{ library: 'common', id: 'poison' }])
    expect(draft.player.moves).toEqual(source.player.moves)

    const without = {
      ...draft,
      sharedMoves: draft.sharedMoves!.filter((ref) => ref.id !== 'poison'),
      player: { ...draft.player, moves: ['attack', 'local-poison'] },
    }

    expect(resolveCombatSource(without, libraries).issues).toEqual([])
    const updated = applyCommand(copied.project, { type: 'game.upsertCombat', encounter: draft })
    expect(inspectProject(updated.project).diagnostics).toEqual([])
    expect(updated.project.documents['combat-libraries/common.json']).toBe(raw)
    expect(() =>
      applyCommand(project, {
        type: 'combat.copySharedEntry',
        encounterId: 'first',
        kind: 'moves',
        reference: { library: 'common', id: 'poison' },
        localId: 'poison',
      }),
    ).toThrow('distinct unused')
  })

  it('preserves nested extensions and clears obsolete fields when saving libraries', () => {
    const project = {
      revision: 'one',
      documents: {
        ...documents(),
        'combat-libraries/common.json': {
          ...library,
          extension: 'root',
          moves: {
            ...library.moves,
            attack: {
              ...library.moves.attack,
              extension: 'move',
              damage: { min: 1, max: 2, extension: 'range' },
            },
          },
          statuses: { poison: { ...library.statuses.poison, extension: 'status' } },
        },
      },
    }

    const result = applyCommand(project, { type: 'game.upsertCombatLibrary', library })
    expect(result.project.documents['combat-libraries/common.json']).toMatchObject({
      extension: 'root',
      moves: { attack: { extension: 'move', damage: { extension: 'range' } } },
      statuses: { poison: { extension: 'status' } },
    })

    const changed = applyCommand(result.project, {
      type: 'game.upsertCombatLibrary',
      library: {
        ...library,
        moves: {
          ...library.moves,
          attack: { type: 'guard', label: 'Guard', description: '', apCost: 1, guard: 2 },
        },
      },
    })

    expect(
      object(object(changed.project.documents['combat-libraries/common.json']).moves).attack,
    ).toMatchObject({ type: 'guard', extension: 'move', damage: undefined })
  })

  it('preserves reference extensions while copying moves and makes independent local statuses', () => {
    const project = {
      revision: 'one',
      documents: {
        ...documents(),
        'combat/first.json': {
          ...source,
          sharedMoves: source.sharedMoves!.map((ref) => ({ ...ref, extension: 'move reference' })),
          sharedStatuses: [{ library: 'common', id: 'poison', extension: 'status reference' }],
        },
      },
    }

    const copied = applyCommand(project, {
      type: 'combat.copySharedEntry',
      encounterId: 'first',
      kind: 'moves',
      reference: { library: 'common', id: 'poison' },
      localId: 'variant',
    })

    expect(object(copied.project.documents['combat/first.json']).sharedStatuses).toEqual([
      { library: 'common', id: 'poison', extension: 'status reference' },
    ])

    const status = applyCommand(copied.project, {
      type: 'combat.copySharedEntry',
      encounterId: 'first',
      kind: 'statuses',
      reference: { library: 'common', id: 'poison' },
      localId: 'weak-poison',
    })

    const draft = inspectProject(status.project).combatSources!.first!
    expect(
      object(object(status.project.documents['combat/first.json']).statuses)['weak-poison'],
    ).not.toBe(library.statuses.poison)
    draft.statuses!['weak-poison'] = {
      type: 'damage',
      label: 'Weaker',
      description: '',
      amount: 1,
      duration: 2,
    }
    const saved = applyCommand(status.project, { type: 'game.upsertCombat', encounter: draft })
    expect(object(saved.project.documents['combat/first.json']).sharedMoves).toEqual(
      source.sharedMoves!.map((ref) => ({ ...ref, extension: 'move reference' })),
    )
    expect(inspectProject(saved.project).combat!.first!.statuses!.poison).toMatchObject({
      amount: 2,
    })
    expect(library.statuses.poison).toMatchObject({ amount: 2 })
  })
})

describe('shared combat runtime integration', () => {
  it('isolates plans, effects and cooldowns across encounters, pause, held input and restart', async () => {
    const data = assembleGameData(
      manifest,
      scenes,
      keys,
      undefined,
      new Map(),
      new Map(),
      undefined,
      new Map([['values', rules]]),
      new Map([
        ['first', source],
        ['second', second],
      ]),
      new Map(),
      libraries,
    )

    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const engine = new Engine(
      { load: async () => data },
      { mount: () => () => {} },
      logger,
      () => new MessageBus<EngineMessages>(),
      { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } },
    )

    onTestFinished(() => engine.stop())
    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.startGame()
    lifecycle.enterScene('first')
    const first = lifecycle.activeScene!
    engine.input!.pressKey('KeyQ')
    lifecycle.enterScene('second')
    engine.input!.releaseKey('KeyQ')

    const flush = () => {
      for (let i = 0; i < 6; i++) engine.flushMessages()
    }

    flush()
    expect(game.combat!.snapshot(lifecycle.activeScene!, 'combat')!.plan).toEqual([])
    lifecycle.enterScene('first')
    const current = lifecycle.activeScene!
    game.combat!.selectTarget(current, 'combat', 'enemy')
    game.combat!.request(current, 'combat', { type: 'queue-move', move: 'poison' })
    flush()
    game.combat!.request(current, 'combat', { type: 'end-turn' })
    flush()
    const paused = game.combat!.snapshot(current, 'combat')!
    lifecycle.enterScene('second')
    const other = game.combat!.snapshot(lifecycle.activeScene!, 'combat')!
    expect(other.round).toBe(1)
    expect(other.cooldowns).toEqual({})
    expect(other.statuses).toEqual({})
    lifecycle.enterScene('first')
    expect(game.combat!.snapshot(lifecycle.activeScene!, 'combat')).toEqual(paused)
    expect(first.disposed).toBe(true)
    lifecycle.startGame()
    lifecycle.enterScene('first')
    expect(lifecycle.currentGame!.combat!.snapshot(lifecycle.activeScene!, 'combat')!.round).toBe(1)
    expect(library.statuses.poison!.duration).toBe(3)
  })

  it.each(['basic', 'graphics'])(
    'loads the shared samples and preserves independent resolved objects: %s',
    async (sample) => {
      const readText = (path: string) =>
        readFile(new URL(`../sample-games/${sample}/${path}`, import.meta.url), 'utf8')

      const game = await new GameLoader(
        new JsonResourceLoader(
          { readText, readBytes: async () => new Uint8Array() },
          { debug: () => '', info: () => '', warn: () => '', error: () => '' },
        ),
      ).load()

      const first = game.combat!.get('training')!,
        second = game.combat!.get('advanced-training')!

      expect(Object.isFrozen(first.moves['poison-strike'])).toBe(true)

      expect(first.moves.poison).toBeUndefined()
      expect(first.moves['poison-strike']).toEqual(second.moves['poison-strike'])
      expect(first.statuses!.poison).not.toBe(second.statuses!.poison)

      if (game.localization) {
        game.localization.select('nl')
        expect(game.combat!.get('training')!.statuses!.poison!.label).toBe('Vergif')
      }
    },
  )
})
