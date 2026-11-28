import { expect, it, onTestFinished } from 'vite-plus/test'
import {
  gameSchema,
  sceneSchema,
  inventorySchema,
  gameRulesSchema,
  questSchema,
  dialogueSchema,
  levelingProfileSchema,
  questRewardItemId,
  type DialogueDefinition,
  type LevelingProfile,
  type StoryEffect,
  type WorldCondition,
} from '@ancadeba/schemas'
import { Engine, assembleGameData, type EngineMessages } from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'

function fixture(operation: 'consume' | 'transfer' | 'none', transient = false) {
  const manifest = gameSchema.parse({
    'schema-version': '1.0.0',
    id: 'quests',
    title: 'Quests',
    version: '1',
    scenes: ['home'],
    'initial-scene': 'home',
    inventory: ['items'],
    rules: ['state'],
    quests: ['a', 'b'],
  })

  const scene = sceneSchema.parse({
    'schema-version': '1.0.0',
    id: 'home',
    title: 'Home',
    type: 'game',
    screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
    components: [],
  })

  const inventory = inventorySchema.parse({
    'schema-version': '1.0.0',
    owners: { player: { label: 'Player' }, giver: { label: 'Giver' } },
    itemTypes: { letter: { label: 'Letter' } },
    items: { letter: { itemType: 'letter', placement: { type: 'carried', owner: 'player' } } },
  })

  const rules = gameRulesSchema.parse({
    state: [
      { path: ['ready'], value: !transient },
      { path: ['gold'], value: 0 },
    ],
    actions: {
      startA: [{ when: [], effects: [{ type: 'start-quest', quest: 'a' }] }],
      startB: [{ when: [], effects: [{ type: 'start-quest', quest: 'b' }] }],
      finishA: [{ when: [], effects: [{ type: 'complete-quest', quest: 'a' }] }],
      clearBefore: [
        {
          when: [],
          effects: [
            { type: 'set-state', path: ['ready'], value: true },
            { type: 'set-state', path: ['ready'], value: false },
            { type: 'start-quest', quest: 'a' },
          ],
        },
      ],
      clearAfter: [
        {
          when: [],
          effects: [
            { type: 'set-state', path: ['ready'], value: true },
            { type: 'start-quest', quest: 'a' },
            { type: 'set-state', path: ['ready'], value: false },
          ],
        },
      ],
      retain: [
        {
          when: [],
          effects: [
            { type: 'set-state', path: ['ready'], value: true },
            { type: 'start-quest', quest: 'a' },
          ],
        },
      ],
    },
  })

  const a = questSchema.parse({
    'schema-version': '1.0.0',
    id: 'a',
    label: 'A',
    stages: [
      {
        id: 'first',
        objectives: [
          {
            id: 'ready',
            label: 'Ready',
            when: [{ type: 'state-is', path: ['ready'], value: true }],
          },
        ],
      },
    ],
    handIns:
      operation === 'none'
        ? []
        : [
            {
              item: 'letter',
              owner: 'player',
              operation,
              ...(operation === 'transfer' ? { recipient: 'giver' } : {}),
            },
          ],
  })

  const b = questSchema.parse({
    'schema-version': '1.0.0',
    id: 'b',
    label: 'B',
    stages: [
      {
        id: 'possess-after-a',
        objectives: [
          {
            id: 'both',
            label: 'Own letter after A',
            when: transient
              ? [{ type: 'state-is', path: ['ready'], value: true }]
              : [
                  { type: 'quest-state', quest: 'a', status: 'completed' },
                  { type: 'item-owned-by', item: 'letter', owner: 'player' },
                ],
          },
        ],
      },
      {
        id: 'later',
        objectives: [
          {
            id: 'gold',
            label: 'Gold',
            progress: { binding: { source: 'game.state', path: ['gold'] }, target: 100 },
          },
        ],
      },
    ],
  })

  return {
    manifest,
    scene,
    inventory,
    rules,
    a,
    b,
    dialogues: new Map<string, DialogueDefinition>(),
    leveling: new Map<string, LevelingProfile>(),
  }
}

type Definitions = ReturnType<typeof fixture>

async function setup(
  operation: 'consume' | 'transfer' | 'none' = 'none',
  transient = false,
  configure?: (definitions: Definitions) => void,
) {
  const definitions = fixture(operation, transient)
  configure?.(definitions)
  const { manifest, scene, inventory, rules, a, b, dialogues, leveling } = definitions

  const data = assembleGameData(
    manifest,
    new Map([['home', scene]]),
    undefined,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['state', rules]]),
    new Map(),
    leveling,
    new Map(),
    dialogues,
    new Map([
      ['a', a],
      ['b', b],
    ]),
  )

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const game = engine.lifecycle!.currentGame!

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const action = (id: string) => {
    game.actions!.request(id)
    flush()
  }

  flush()
  const active = () => engine.lifecycle!.activeScene!

  const choose = () => {
    game.nearby!.select(active(), 'nearby', 'giver')
    game.dialogue!.request(active(), 'nearby', { type: 'start' })
    flush()
    game.dialogue!.request(active(), 'nearby', { type: 'choose', position: 1 })
    flush()
  }

  return { game, action, active, flush, choose }
}

function conditions(definitions: Definitions, when: WorldCondition[]) {
  const first = definitions.b.stages[0]!
  definitions.b = questSchema.parse({
    ...definitions.b,
    stages: [{ ...first, objectives: [{ ...first.objectives[0], when }] }, definitions.b.stages[1]],
  })
}

function custom(definitions: Definitions, effects: StoryEffect[]) {
  definitions.rules = gameRulesSchema.parse({
    ...definitions.rules,
    actions: { ...definitions.rules.actions, custom: [{ when: [], effects }] },
  })
}

function dialogue(definitions: Definitions, action: string) {
  definitions.manifest.dialogues = ['transaction']
  definitions.scene = sceneSchema.parse({
    ...definitions.scene,
    components: [
      { id: 'text', type: 'text', text: '', placement: { row: 1, column: 1 } },
      {
        id: 'nearby',
        type: 'nearby',
        descriptionTarget: 'text',
        placement: { row: 1, column: 1 },
        entries: { giver: { kind: 'character', label: 'Giver', dialogue: 'transaction' } },
      },
    ],
  })
  definitions.dialogues.set(
    'transaction',
    dialogueSchema.parse({
      'schema-version': '1.0.0',
      id: 'transaction',
      label: 'Transaction',
      entry: 'start',
      nodes: {
        start: {
          choices: [
            {
              id: 'apply',
              label: 'Apply',
              end: true,
              effects: definitions.rules.actions[action]![0]!.effects,
            },
          ],
        },
      },
    }),
  )
}

it.each(['consume', 'transfer', 'none'] as const)(
  'advances quests using completed inventory after %s hand-in',
  async (operation) => {
    const { game, action } = await setup(operation)
    action('startB')
    action('startA')
    expect(game.quests!.snapshot('a')?.status).toBe('ready')
    expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
    action('finishA')
    expect(game.quests!.snapshot('a')?.status).toBe('completed')
    expect(game.inventory!.snapshot.find((item) => item.id === 'letter')?.placement).toEqual(
      operation === 'consume'
        ? undefined
        : { type: 'carried', owner: operation === 'none' ? 'player' : 'giver' },
    )
    expect(game.quests!.snapshot('b')?.stage).toBe(
      operation === 'none' ? 'later' : 'possess-after-a',
    )
  },
)

it.each(['clearBefore', 'clearAfter', 'retain'] as const)(
  'advances an existing quest only from completed facts for %s',
  async (id) => {
    const { game, action } = await setup('none', true)
    action('startB')
    expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
    action(id)
    expect(game.bindings!.read({ source: 'game.state', path: ['ready'] })).toMatchObject({
      value: id === 'retain',
    })
    expect(game.quests!.snapshot('a')?.status).not.toBe('not-started')
    expect(game.quests!.snapshot('b')?.stage).toBe(id === 'retain' ? 'later' : 'possess-after-a')
  },
)

it.each([
  ['consume', 'item-owned-by', true],
  ['transfer', 'item-owned-by', true],
  ['consume', 'item-carried-by', false],
  ['transfer', 'item-carried-by', false],
  ['none', 'item-carried-by', true],
] as const)('uses committed %s inventory for %s, nested: %s', async (operation, type, nested) => {
  const { game, action, active, flush } = await setup(operation, false, (definitions) => {
    if (nested)
      definitions.inventory = inventorySchema.parse({
        ...definitions.inventory,
        itemTypes: { ...definitions.inventory.itemTypes, bag: { label: 'Bag', container: true } },
        items: {
          bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
          letter: { itemType: 'letter', placement: { type: 'inside', container: 'bag' } },
        },
      })
    conditions(definitions, [
      { type: 'quest-state', quest: 'a', status: 'completed' },
      { type, item: 'letter', owner: 'player' },
    ])
  })

  action('startB')
  action('startA')
  game.quests!.request(active(), 'a', 'turn-in')
  flush()
  expect(game.quests!.snapshot('a')?.status).toBe('completed')
  expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
})

it.each(['item-owned-by', 'item-carried-by'] as const)(
  'advances from transferred ownership using %s before observers run',
  async (type) => {
    const { game, action } = await setup('transfer', false, (definitions) => {
      conditions(definitions, [
        { type: 'quest-state', quest: 'a', status: 'completed' },
        { type, item: 'letter', owner: 'giver' },
      ])
    })

    action('startB')
    action('startA')
    const observed: unknown[] = []
    game.inventory!.subscribeChanges(() =>
      observed.push([
        game.inventory!.snapshot.find((item) => item.id === 'letter')?.placement,
        game.quests!.snapshot('b')?.stage,
      ]),
    )
    action('finishA')
    expect(observed).toEqual([[{ type: 'carried', owner: 'giver' }, 'later']])
  },
)

it('advances from a newly created reward before publishing inventory changes', async () => {
  const item = questRewardItemId('a', 'gift')

  const { game, action } = await setup('consume', false, (definitions) => {
    definitions.a = questSchema.parse({
      ...definitions.a,
      rewards: { recipient: 'player', items: [{ id: 'gift', itemType: 'letter' }] },
    })
    conditions(definitions, [
      { type: 'quest-state', quest: 'a', status: 'completed' },
      { type: 'item-owned-by', item, owner: 'player' },
    ])
  })

  action('startB')
  action('startA')
  const observed: unknown[] = []
  game.inventory!.subscribeChanges(() =>
    observed.push([
      game.inventory!.snapshot.map((item) => item.id),
      game.quests!.snapshot('b')?.stage,
    ]),
  )
  action('finishA')
  expect(observed).toEqual([[[item], 'later']])
})

it.each(['string', 'number'] as const)(
  'discards intermediate %s state when advancing active quests',
  async (kind) => {
    const value = kind === 'number' ? 1 : 'during'
    const original = kind === 'number' ? 0 : 'before'

    const { game, action } = await setup('none', true, (definitions) => {
      definitions.rules = gameRulesSchema.parse({
        ...definitions.rules,
        state: [...definitions.rules.state, { path: ['transient'], value: original }],
      })
      conditions(definitions, [{ type: 'state-is', path: ['transient'], value }])
      custom(definitions, [
        { type: 'set-state', path: ['transient'], value },
        { type: 'start-quest', quest: 'a' },
        { type: 'set-state', path: ['transient'], value: original },
      ])
    })

    action('startB')
    action('custom')
    expect(game.quests!.snapshot('a')?.status).toBe('active')
    expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
    expect(game.bindings!.read({ source: 'game.state', path: ['transient'] })).toMatchObject({
      value: original,
    })
  },
)

it('discards provisional cursors for multiple newly started quests', async () => {
  const { game, action } = await setup('none', true, (definitions) => {
    custom(definitions, [
      { type: 'set-state', path: ['ready'], value: true },
      { type: 'start-quest', quest: 'b' },
      { type: 'start-quest', quest: 'a' },
      { type: 'set-state', path: ['ready'], value: false },
    ])
  })

  action('custom')
  expect(game.quests!.snapshot('a')?.status).toBe('active')
  expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
})

it.each(['ready', 'completed'] as const)(
  'preserves staged acceptance depending on a newly started multi-stage quest being %s',
  async (status) => {
    const { game, action } = await setup('none', false, (definitions) => {
      definitions.a = questSchema.parse({
        ...definitions.a,
        stages: [
          definitions.a.stages[0],
          {
            ...definitions.a.stages[0],
            id: 'final',
            objectives: [{ ...definitions.a.stages[0]!.objectives[0], id: 'final-ready' }],
          },
        ],
      })
      definitions.b = questSchema.parse({
        ...definitions.b,
        when: [{ type: 'quest-state', quest: 'a', status }],
      })
      custom(definitions, [
        { type: 'start-quest', quest: 'a' },
        ...(status === 'completed' ? [{ type: 'complete-quest' as const, quest: 'a' }] : []),
        { type: 'start-quest', quest: 'b' },
      ])
    })

    action('custom')
    expect(game.quests!.snapshot('a')).toMatchObject({ status, stage: 'final' })
    expect(game.quests!.snapshot('b')?.status).not.toBe('not-started')
  },
)

it.each(['consume', 'transient'] as const)(
  'applies the %s fix through a dialogue choice',
  async (mode) => {
    const { game, action, choose, active } = await setup(
      mode === 'consume' ? 'consume' : 'none',
      mode === 'transient',
      (definitions) => {
        dialogue(definitions, mode === 'consume' ? 'finishA' : 'clearAfter')
      },
    )

    action('startB')

    if (mode === 'consume') action('startA')
    choose()
    expect(game.quests!.snapshot('a')?.status).toBe(mode === 'consume' ? 'completed' : 'active')
    expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
    expect(game.dialogue!.reply(active(), 'nearby', 1)).toBeUndefined()
  },
)

it.each(['missing', 'reserved', 'overflow'] as const)(
  'rejects a %s transaction without publishing provisional progress',
  async (mode) => {
    const { game, action } = await setup('consume', true, (definitions) => {
      if (mode === 'overflow') {
        definitions.rules.state.find((field) => field.path[0] === 'gold')!.value = 1
        definitions.a = questSchema.parse({
          ...definitions.a,
          rewards: {
            numeric: [
              {
                id: 'gold',
                label: 'Gold',
                field: { source: 'game.state', path: ['gold'] },
                amount: Number.MAX_SAFE_INTEGER,
              },
            ],
          },
        })
      }

      custom(definitions, [
        { type: 'set-state', path: ['ready'], value: true },
        { type: 'start-quest', quest: 'a' },
        { type: 'complete-quest', quest: 'a' },
        { type: 'set-state', path: ['ready'], value: false },
      ])
    })

    action('startB')

    if (mode === 'missing') game.inventory!.move('letter', { type: 'carried', owner: 'giver' })

    if (mode === 'reserved') game.inventory!.reserveItem!('letter', { encounter: 'fight' })

    const state = game.state

    if (!(state instanceof Map)) throw new Error('Expected Map state')

    const before = {
      inventory: game.inventory!.snapshot,
      a: game.quests!.snapshot('a'),
      b: game.quests!.snapshot('b'),
      state: [...state],
    }

    action('custom')
    expect({
      inventory: game.inventory!.snapshot,
      a: game.quests!.snapshot('a'),
      b: game.quests!.snapshot('b'),
      state: [...state],
    }).toEqual(before)
  },
)

it('keeps preparation pure and discards a batch after its inventory becomes stale', async () => {
  const { game, action, active } = await setup('consume')
  action('startB')
  action('startA')

  const before = {
    inventory: game.inventory!.snapshot,
    a: game.quests!.snapshot('a'),
    b: game.quests!.snapshot('b'),
  }

  const prepared = game.quests!.prepareEffects(active(), [{ type: 'complete-quest', quest: 'a' }])!
  expect(prepared.isCurrent()).toBe(true)
  expect({
    inventory: game.inventory!.snapshot,
    a: game.quests!.snapshot('a'),
    b: game.quests!.snapshot('b'),
  }).toEqual(before)
  game.inventory!.move('letter', { type: 'carried', owner: 'giver' })
  expect(prepared.isCurrent()).toBe(false)
  prepared.commit()
  prepared.notify()
  expect(game.quests!.snapshot('a')?.status).toBe('active')
  expect(game.quests!.snapshot('b')?.stage).toBe('possess-after-a')
})

it.each([1, 2])(
  'uses final derived level values for objectives requiring level %s',
  async (level) => {
    const { game, action } = await setup('consume', false, (definitions) => {
      definitions.manifest.leveling = ['player']
      definitions.rules.state.push({ path: ['xp'], value: 0 }, { path: ['level'], value: 1 })
      definitions.leveling.set(
        'player',
        levelingProfileSchema.parse({
          'schema-version': '1.0.0',
          id: 'player',
          label: 'Player',
          xp: { source: 'game.state', path: ['xp'] },
          level: { source: 'game.state', path: ['level'] },
          levels: [{ xp: 0 }, { xp: 5 }],
        }),
      )
      definitions.a = questSchema.parse({
        ...definitions.a,
        rewards: {
          numeric: [
            { id: 'xp', label: 'XP', field: { source: 'game.state', path: ['xp'] }, amount: 5 },
          ],
        },
      })
      conditions(definitions, [
        { type: 'quest-state', quest: 'a', status: 'completed' },
        { type: 'state-is', path: ['level'], value: level },
      ])
    })

    action('startB')
    action('startA')
    const observed: unknown[] = []
    game.inventory!.subscribeChanges(() =>
      observed.push([
        game.bindings!.read({ source: 'game.state', path: ['level'] }),
        game.quests!.snapshot('b')?.stage,
      ]),
    )
    action('finishA')
    expect(observed).toEqual([
      [{ status: 'resolved', value: 2 }, level === 2 ? 'later' : 'possess-after-a'],
    ])
  },
)

it('settles shared and chosen rewards atomically and exposes the provisional outcome to later effects', async () => {
  const { game, action, active, flush } = await setup('none', false, (definitions) => {
    const numeric = (amount: number) => [
      { id: 'gold', label: 'Gold', amount, field: { source: 'game.state', path: ['gold'] } },
    ]

    definitions.a = questSchema.parse({
      ...definitions.a,
      rewards: { numeric: numeric(3) },
      outcomes: [
        {
          id: 'delivered',
          label: 'Delivered',
          when: [{ type: 'state-is', path: ['ready'], value: true }],
          handIns: [{ item: 'letter', owner: 'player', operation: 'transfer', recipient: 'giver' }],
          rewards: {
            recipient: 'player',
            numeric: numeric(5),
            items: [{ id: 'receipt', itemType: 'letter' }],
          },
        },
        {
          id: 'kept',
          label: 'Kept',
          when: [{ type: 'state-is', path: ['ready'], value: false }],
          unavailableText: 'Wait for nightfall.',
        },
      ],
    })
    definitions.b.when = [{ type: 'quest-outcome', quest: 'a', outcome: 'delivered' }]
    definitions.rules.actions.finishA = [
      {
        when: [],
        effects: [
          { type: 'complete-quest', quest: 'a', outcome: 'delivered' },
          { type: 'start-quest', quest: 'b' },
        ],
      },
    ]
  })

  action('startA')
  expect(game.quests!.reason(active(), 'a', 'turn-in', 'kept')).toBe('Wait for nightfall.')
  const offered: string[] = []
  game.quests!.onChooseOutcome((_, quest) => offered.push(quest))
  game.quests!.request(active(), 'a', 'turn-in')
  flush()
  expect(offered).toEqual(['a'])
  expect(game.quests!.snapshot('a')?.status).toBe('ready')
  const before = game.inventory!.snapshot
  const reservation = { encounter: 'test' }
  game.inventory!.reserveItem!('letter', reservation)
  action('finishA')
  expect(game.inventory!.snapshot).toEqual(before)
  expect(game.quests!.snapshot('a')?.outcome).toBeUndefined()
  expect(game.quests!.snapshot('b')?.status).toBe('not-started')
  game.inventory!.releaseItems!(reservation)
  action('finishA')
  action('finishA')
  expect(game.quests!.snapshot('a')).toMatchObject({ status: 'completed', outcome: 'delivered' })
  expect(game.bindings!.read({ source: 'game.quests', path: ['a', 'outcome'] })).toMatchObject({
    value: 'delivered',
  })
  expect(game.quests!.snapshot('b')?.status).toBe('active')
  expect(game.bindings!.read({ source: 'game.state', path: ['gold'] })).toMatchObject({ value: 8 })
  expect(game.inventory!.snapshot).toEqual([
    expect.objectContaining({ id: 'letter', placement: { type: 'carried', owner: 'giver' } }),
    expect.objectContaining({
      id: questRewardItemId('a', 'receipt', 'delivered'),
      placement: { type: 'carried', owner: 'player' },
    }),
  ])
})
