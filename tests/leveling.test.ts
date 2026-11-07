import { describe, it, expect, vi, onTestFinished } from 'vite-plus/test'
import {
  levelingProfileSchema,
  levelingIssues,
  localizeLeveling,
  combatDefinitionSchema,
  gameRulesSchema,
  gameSchema,
  sceneSchema,
  inputSchema,
  inventorySchema,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  GameLeveling,
  MapStateTransactions,
  assembleGameData,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, validateProject } from '@ancadeba/editor-core'

const field = (name: string) => ({ source: 'game.state' as const, path: [name] })

const rules = gameRulesSchema.parse({
  state: Object.entries({
    xp: 0,
    level: 1,
    health: 20,
    maximumHealth: 30,
    power: 4,
    gold: 0,
    enemy: 5,
  }).map(([name, value]) => ({ path: [name], value })),
  actions: {},
})

const profile = levelingProfileSchema.parse({
  'schema-version': '1.0.0',
  id: 'player',
  label: 'Player',
  xp: field('xp'),
  level: field('level'),
  health: { current: field('health'), maximum: field('maximumHealth') },
  levels: [
    { xp: 0 },
    {
      xp: 10,
      gains: [
        { id: 'health', label: '<b>Maximum health</b>', field: field('maximumHealth'), amount: 5 },
        { id: 'power', label: 'Power', field: field('power'), amount: 2 },
      ],
    },
    {
      xp: 25,
      gains: [
        { id: 'health', label: 'Maximum health', field: field('maximumHealth'), amount: 7 },
        { id: 'power', label: 'Power', field: field('power'), amount: 3 },
      ],
    },
  ],
})

const combat = combatDefinitionSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  label: 'Fight',
  player: {
    id: 'player',
    label: 'Player',
    health: field('health'),
    maximumHealth: field('maximumHealth'),
    moves: ['attack', 'heavy', 'guard'],
    leveling: 'player',
    moveLevels: { heavy: 2 },
  },
  enemies: [
    {
      id: 'enemy',
      label: 'Enemy',
      health: field('enemy'),
      maximumHealth: 5,
      ap: 1,
      moves: ['guard'],
      rotation: ['guard'],
    },
  ],
  moves: {
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 5, max: 5 } },
    heavy: { type: 'attack', label: 'Heavy', apCost: 2, damage: { min: 12, max: 12 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 2 },
  },
  rewards: {
    recipient: 'player',
    lootOwner: 'loot',
    numeric: [
      { id: 'xp', label: 'XP', field: field('xp'), amount: 10 },
      { id: 'gold', label: 'Gold', field: field('gold'), amount: 4 },
    ],
    drops: [{ id: 'token', itemType: 'token' }],
  },
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: { player: { label: 'Player' }, loot: { label: 'Loot' } },
  itemTypes: { token: { label: 'Token' } },
  items: {},
})

const commands = {
  '1': { type: 'queue-move', move: 'attack' },
  '2': { type: 'queue-move', move: 'heavy' },
  '3': { type: 'queue-move', move: 'guard' },
  '11': { type: 'retry-rewards' },
  '15': { type: 'end-turn' },
}

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  title: 'Fight',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
  components: [
    { id: 'combat', type: 'combat', encounter: 'fight', placement: { row: 1, column: 1 } },
    {
      id: 'summary',
      type: 'character-progression',
      profile: 'player',
      textTarget: 'text',
      placement: { row: 1, column: 2 },
    },
    { id: 'text', type: 'text', text: 'Story', placement: { row: 1, column: 3 } },
    {
      id: 'bar',
      type: 'action-bar',
      placement: { row: 10, column: 1 },
      slots: Object.fromEntries(
        Object.entries(commands).map(([id, command]) => [
          id,
          {
            label: id,
            action: { type: 'combat-action', combat: 'combat', command },
            inputBinding: { context: 'play', input: `slot-${id}` },
          },
        ]),
      ),
    },
  ],
})

const other = sceneSchema.parse({ ...scene, id: 'other', components: [] })

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': Object.keys(commands).map((id) => `slot-${id}`),
  keyboard: { KeyQ: 'slot-1', KeyW: 'slot-2', KeyE: 'slot-3', KeyZ: 'slot-11', KeyB: 'slot-15' },
  contexts: {
    play: Object.fromEntries(Object.keys(commands).map((id) => [`slot-${id}`, `slot-${id}`])),
  },
  'initial-context': 'play',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'levels',
  title: 'Levels',
  version: '1',
  leveling: ['player'],
  combat: ['fight'],
  rules: ['rules'],
  inventory: ['items'],
  scenes: ['fight', 'other'],
  'initial-scene': 'fight',
  input: 'keys',
})

async function setup(
  options: {
    policy?: 'preserve' | 'increase' | 'restore'
    adapter?: boolean
    startingXp?: number
    level?: number
  } = {},
) {
  const definition = levelingProfileSchema.parse({
    ...profile,
    health: { ...profile.health, policy: options.policy ?? 'preserve' },
  })

  const values = gameRulesSchema.parse({
    ...rules,
    state: rules.state.map((entry) =>
      entry.path[0] === 'xp'
        ? { ...entry, value: options.startingXp ?? 0 }
        : entry.path[0] === 'level'
          ? { ...entry, value: options.level ?? 1 }
          : entry,
    ),
  })

  const data = assembleGameData(
    manifest,
    new Map([
      ['fight', scene],
      ['other', other],
    ]),
    input,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['rules', values]]),
    new Map([['fight', combat]]),
    new Map([['player', definition]]),
  )

  const fallback = vi.fn(() => ({ status: 'applied' as const }))

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () =>
            new Map(values.state.map((entry) => [entry.path[0]!, entry.value])),
          createSceneState: () => undefined,
        }),
      createStateTransactions: (game) =>
        game.state instanceof Map && options.adapter !== false
          ? new MapStateTransactions(
              game.state,
              values.state.map((entry) => entry.path),
            )
          : undefined,
      createGameRules: () => ({
        handlers: new Map([['fallback', fallback]]),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
          context: 'play',
          input: 'slot-2',
          phase,
          action: 'fallback',
        })),
      }),
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const game = () => engine.lifecycle!.currentGame!
  const active = () => engine.lifecycle!.activeScene!

  const service = () => {
    const service = game().leveling

    if (!(service instanceof GameLeveling)) throw new Error('Expected leveling')

    return service
  }

  const state = () => {
    const state = game().state

    if (!(state instanceof Map)) throw new Error('Expected Map')

    return state
  }

  const snapshot = () => service().snapshot('player')!
  const grant = (amount: number) => service().grantXp('player', amount)

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const bar = (id: string) => {
    game().actionBar!.activate(active(), 'bar', id)
    flush()
  }

  return { engine, game, active, service, state, snapshot, grant, flush, bar, fallback }
}

describe('character leveling transactions', () => {
  it('handles exact thresholds, multiple crossed levels, capped XP and immutable read models', async () => {
    const t = await setup()
    expect(t.snapshot()).toMatchObject({
      level: 1,
      xp: 0,
      xpToNextLevel: 10,
      progressValue: 0,
      progressMaximum: 10,
    })
    t.grant(9)
    expect(t.snapshot().level).toBe(1)
    t.grant(1)
    expect(t.snapshot()).toMatchObject({ level: 2, xp: 10, xpIntoLevel: 0, xpToNextLevel: 15 })
    expect(t.state().get('maximumHealth')).toBe(35)
    t.grant(90)
    expect(t.snapshot()).toMatchObject({
      level: 3,
      xp: 100,
      capped: true,
      nextLevelXp: undefined,
      progressValue: 1,
      progressMaximum: 1,
    })
    expect(t.state().get('maximumHealth')).toBe(42)
    expect(t.state().get('power')).toBe(9)
    t.grant(100)
    t.grant(0)
    expect(t.snapshot().xp).toBe(200)
    expect(t.state().get('maximumHealth')).toBe(42)
    const multi = await setup()
    multi.grant(25)
    expect(multi.snapshot().receipt).toMatchObject({ from: 1, to: 3 })
    expect(Object.isFrozen(multi.snapshot().receipt!.gains)).toBe(true)
    expect(multi.service().text('player')).toContain('Unlocked: Heavy')
    expect(multi.service().text('player')).toContain('Power: +5')
  })
  it.each([
    ['preserve', 20],
    ['increase', 32],
    ['restore', 42],
  ] as const)(
    'applies %s health recovery across multiple levels without reviving defeated characters',
    async (policy, expected) => {
      const t = await setup({ policy })
      t.grant(25)
      expect(t.state().get('health')).toBe(expected)
      const defeated = await setup({ policy })
      defeated.state().set('health', 0)
      defeated.grant(25)
      expect(defeated.state().get('health')).toBe(0)
      expect(defeated.state().get('maximumHealth')).toBe(42)
    },
  )
  it('commits XP, gold, levels, stat gains, loot and the delivery flag before inventory observers run', async () => {
    const t = await setup()
    const seen: unknown[] = []
    t.game().inventory!.subscribeChanges(() =>
      seen.push([
        t.state().get('xp'),
        t.state().get('level'),
        t.state().get('maximumHealth'),
        t.state().get('power'),
        t.state().get('gold'),
        t.game().combatRewards!.snapshot(t.active(), 'combat')!.delivered,
      ]),
    )
    t.bar('1')
    t.bar('15')
    expect(seen).toEqual([[10, 2, 35, 6, 4, true]])
    expect(t.game().actions!.progression.turn).toBe(1)
  })
  it('keeps an overflowing level gain pending with no partial payout and retries once', async () => {
    const t = await setup()
    t.state().set('power', Number.MAX_SAFE_INTEGER)
    t.bar('1')
    t.bar('15')
    expect(t.game().combat!.snapshot(t.active(), 'combat')!.outcome).toBe('victory')
    expect(t.snapshot()).toMatchObject({ level: 1, xp: 0 })
    expect(t.state().get('maximumHealth')).toBe(30)
    expect(t.state().get('gold')).toBe(0)
    expect(t.game().inventory!.snapshot).toHaveLength(0)
    t.state().set('power', 4)
    t.bar('11')
    t.bar('11')
    expect(t.snapshot()).toMatchObject({ level: 2, xp: 10 })
    expect(t.state().get('power')).toBe(6)
    expect(t.game().inventory!.snapshot).toHaveLength(1)
  })
  it('retains committed gains after observer failure and never reapplies them for a zero grant', async () => {
    const t = await setup()

    const observer = t.service().subscribeChanges(() => {
      expect(t.state().get('maximumHealth')).toBe(35)
      throw new Error('observer')
    })

    expect(() => t.grant(10)).toThrow()
    observer()
    expect(t.snapshot().level).toBe(2)
    t.grant(0)
    expect(t.state().get('maximumHealth')).toBe(35)
  })
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid or overflowing XP grants %s atomically',
    async (amount) => {
      const t = await setup()

      if (amount === Number.MAX_SAFE_INTEGER) t.grant(1)
      const before = [...t.state()]

      if (amount === Number.MAX_SAFE_INTEGER) expect(t.grant(amount).status).toBe('rejected')
      else expect(t.grant(amount).status).toBe('rejected')
      expect([...t.state()]).toEqual(before)
    },
  )
  it('rejects XP loss, direct level writes, stale writes and replayed prepared commits', async () => {
    const t = await setup()
    t.grant(9)
    expect(t.service().prepare([{ path: ['xp'], expected: 9, value: 8 }])).toBeUndefined()
    expect(t.service().prepare([{ path: ['level'], expected: 1, value: 2 }])).toBeUndefined()
    expect(
      t.service().prepare([
        { path: ['xp'], expected: 9, value: 10 },
        { path: ['power'], expected: 3, value: 5 },
      ]),
    ).toBeUndefined()
    const stale = t.service().prepare([{ path: ['xp'], expected: 9, value: 10 }])!
    t.grant(1)
    expect(stale.isCurrent()).toBe(false)
    stale.commit()
    expect(t.state().get('power')).toBe(6)
    const prepared = t.service().prepare([{ path: ['xp'], expected: 10, value: 25 }])!
    prepared.commit()
    prepared.commit()
    expect(t.state().get('power')).toBe(9)
  })
  it('preserves authored starting stats at higher starting levels and reports unsupported state access', async () => {
    const t = await setup({ startingXp: 25, level: 3 })
    t.grant(0)
    expect(t.state().get('maximumHealth')).toBe(30)
    const unsupported = await setup({ adapter: false })
    expect(unsupported.snapshot().available).toBe(false)
    expect(unsupported.grant(10).status).toBe('rejected')
  })
  it('provides read-only leveling bindings and persists through scenes while New Game resets gains', async () => {
    const t = await setup()
    t.grant(12)
    expect(
      t.game().bindings!.read({ source: 'game.leveling', path: ['player', 'xpIntoLevel'] }),
    ).toMatchObject({ value: 2 })
    const before = t.snapshot()
    t.engine.lifecycle!.enterScene('other')
    t.engine.lifecycle!.enterScene('fight')
    expect(t.snapshot()).toEqual(before)
    const old = t.service()
    t.engine.lifecycle!.startGame()
    t.engine.lifecycle!.enterScene('fight')
    expect(old.grantXp('player', 100).status).toBe('rejected')
    expect(t.snapshot()).toMatchObject({ level: 1, xp: 0 })
    expect(t.state().get('maximumHealth')).toBe(30)
  })
})

describe('level-gated combat input', () => {
  it('consumes disabled presses and held phases after unlocking without activating the old press', async () => {
    const t = await setup()
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '2')).toBe(false)
    t.engine.input!.pressKey('KeyW')
    t.grant(10)
    t.flush()
    t.engine.input!.releaseKey('KeyW')
    t.flush()
    expect(t.game().combat!.snapshot(t.active(), 'combat')!.plan).toHaveLength(0)
    expect(t.fallback).not.toHaveBeenCalled()
    t.engine.input!.pressKey('KeyW')
    t.engine.input!.releaseKey('KeyW')
    t.flush()
    expect(t.game().combat!.snapshot(t.active(), 'combat')!.plan).toEqual([
      { move: 'heavy', target: 'enemy' },
    ])
  })
  it('keeps rapid guard, attack and End Turn commands ordered and preserves plans when granting XP', async () => {
    const t = await setup()

    for (const code of ['KeyE', 'KeyQ', 'KeyB']) {
      t.engine.input!.pressKey(code)
      t.engine.input!.releaseKey(code)
    }

    t.flush()
    expect(t.game().combat!.snapshot(t.active(), 'combat')!.outcome).toBe('victory')
    const second = await setup()
    second.bar('3')
    const before = second.game().combat!.snapshot(second.active(), 'combat')!
    second.grant(10)
    const after = second.game().combat!.snapshot(second.active(), 'combat')!
    expect(after.plan).toEqual(before.plan)
    expect(after.enemyPlans).toEqual(before.enemyPlans)
    expect(after.remainingAp).toBe(before.remainingAp)
    expect(after.round).toBe(1)
    expect(second.game().actions!.progression.turn).toBe(0)
  })
})

describe('leveling project configuration', () => {
  const project = () => ({
    revision: 'one',
    documents: {
      'game.json': manifest,
      'leveling/player.json': profile,
      'combat/fight.json': combat,
      'scenes/fight.json': scene,
      'scenes/other.json': other,
      'rules/rules.json': rules,
      'inventory/items.json': inventory,
      'input/keys.json': input,
    },
  })

  it('checks thresholds, starting state, protected fields, move requirements and view references', () => {
    const p = project()
    expect(validateProject(p.documents)).toEqual([])
    expect(() => levelingProfileSchema.parse({ ...profile, levels: [{ xp: 1 }] })).toThrow()
    expect(() =>
      levelingProfileSchema.parse({ ...profile, levels: [{ xp: 0 }, { xp: 0 }] }),
    ).toThrow()
    expect(
      levelingIssues(
        new Map([['player', { ...profile, levels: [{ xp: 0, gains: [] }] }]]),
        rules,
        new Map([['fight', combat]]),
        new Map(),
      ).some((issue) => issue.path.includes('moveLevels')),
    ).toBe(true)
    expect(() => applyCommand(p, { type: 'game.removeLeveling', profileId: 'player' })).toThrow()
    expect(() =>
      applyCommand(p, {
        type: 'game.updateRules',
        ruleId: 'rules',
        rules: {
          ...rules,
          actions: {
            corrupt: [{ when: [], effects: [{ type: 'set-state', path: ['xp'], value: 10 }] }],
          },
        },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(p, {
        type: 'game.upsertLeveling',
        profile: { ...profile, level: field('gold') },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(p, {
        type: 'scene.upsertLevelingView',
        sceneId: 'fight',
        component: {
          id: 'summary',
          type: 'character-progression',
          profile: 'missing',
          placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
        },
      }),
    ).toThrow()
  })
  it('protects derived binding references and rejects shared profile fields or invalid runtime state', async () => {
    const fields = [
      ...scene.components.filter(
        (component) => !['summary', 'combat', 'bar'].includes(component.id),
      ),
      {
        id: 'xp-view',
        type: 'status-panel',
        label: 'XP',
        placement: { row: 1, column: 1 },
        rows: [
          {
            id: 'xp',
            type: 'bar',
            label: 'XP',
            value: { source: 'game.leveling', path: ['player', 'progressValue'] },
            maximum: { source: 'game.leveling', path: ['player', 'progressMaximum'] },
          },
        ],
      },
    ]

    const p = project()

    const bound = {
      ...p,
      documents: {
        ...p.documents,
        'game.json': { ...manifest, combat: [] },
        'scenes/fight.json': sceneSchema.parse({ ...scene, components: fields }),
      },
    }

    expect(validateProject(bound.documents)).toEqual([])
    expect(() =>
      applyCommand(bound, { type: 'game.removeLeveling', profileId: 'player' }),
    ).toThrow()
    expect(
      levelingIssues(
        new Map([
          ['player', profile],
          ['other', { ...profile, id: 'other' }],
        ]),
        rules,
        new Map(),
        new Map(),
      ).some((issue) => issue.message.includes('share')),
    ).toBe(true)
    const t = await setup()
    t.state().set('xp', 10)
    expect(t.snapshot().available).toBe(false)
    expect(t.grant(1).status).toBe('rejected')
  })
  it('localizes labels and receipts and preserves extension properties through profile saves', () => {
    const localized = localizeLeveling(
      {
        ...profile,
        labelKey: 'player',
        messageKeys: { gained: 'gained' },
        levels: profile.levels.map((level) => ({
          ...level,
          gains: level.gains.map((gain) => ({ ...gain, labelKey: 'health' })),
        })),
      },
      {
        fallback: { player: 'Player', gained: 'Level {level}', health: 'Health' },
        messages: { player: 'Speler', gained: 'Niveau {level}', health: '<b>Gezondheid</b>' },
      },
    )

    expect(localized.label).toBe('Speler')
    expect(localized.levels[1]!.gains[0]!.label).toBe('<b>Gezondheid</b>')
    const p = project()

    const extended = {
      ...p,
      documents: {
        ...p.documents,
        'leveling/player.json': {
          ...profile,
          extension: 'profile',
          xp: { ...profile.xp, extension: 'field' },
          levels: profile.levels.map((level) => ({
            ...level,
            extension: 'level',
            gains: level.gains.map((gain) => ({ ...gain, extension: 'gain' })),
          })),
        },
      },
    }

    const result = applyCommand(extended, { type: 'game.upsertLeveling', profile })
    expect(result.project.documents['leveling/player.json']).toMatchObject({
      extension: 'profile',
      xp: { extension: 'field' },
      levels: [
        expect.objectContaining({ extension: 'level' }),
        expect.objectContaining({
          gains: [expect.objectContaining({ extension: 'gain' }), expect.anything()],
        }),
        expect.anything(),
      ],
    })
    expect(inspectProject(result.project).leveling!.player!.levels).toHaveLength(3)
  })
})
