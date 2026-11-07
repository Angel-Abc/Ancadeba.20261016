import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import {
  dialogueSchema,
  questSchema,
  gameSchema,
  gameRulesSchema,
  sceneSchema,
  inputSchema,
  inventorySchema,
  levelingProfileSchema,
  questRewardItemId,
  localizeStory,
  type DialogueDefinition,
  type QuestDefinition,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLoader,
  assembleGameData,
  matchesConditions,
  MapStateTransactions,
  GameLifecycle,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus, JsonResourceLoader } from '@ancadeba/utilities'
import {
  applyCommand,
  inspectProject,
  validateProject,
  projectViewSchema,
  object,
} from '@ancadeba/editor-core'

const field = (id: string) => ({ source: 'game.state' as const, path: [id] })

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: {
    player: { label: 'Player', equipmentSlots: { hand: 'Hand' } },
    giver: { label: 'Giver' },
  },
  itemTypes: {
    bag: { label: 'Bag', container: true },
    letter: { label: 'Letter', equipmentSlots: ['hand'] },
    token: { label: 'Token' },
  },
  items: {
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    letter: { itemType: 'letter', placement: { type: 'inside', container: 'bag' } },
    otherLetter: { itemType: 'letter', placement: { type: 'carried', owner: 'player' } },
  },
})

const rules = gameRulesSchema.parse({
  state: [
    { path: ['done'], value: false },
    { path: ['name'], value: '<Traveller>' },
    { path: ['gold'], value: 2 },
    { path: ['xp'], value: 0 },
    { path: ['level'], value: 1 },
    { path: ['hp'], value: 10 },
  ],
  log: { path: ['log'], capacity: 4, initial: [] },
  actions: {
    visit: [{ when: [], effects: [{ type: 'set-state', path: ['done'], value: true }] }],
    accept: [{ when: [], effects: [{ type: 'start-quest', quest: 'delivery' }] }],
  },
})

const quest = questSchema.parse({
  'schema-version': '1.0.0',
  id: 'delivery',
  label: 'Deliver a letter',
  stages: [
    {
      id: 'deliver',
      label: 'Delivery',
      objectives: [
        {
          id: 'letter',
          label: 'Bring the letter',
          when: [{ type: 'item-owned-by', item: 'letter', owner: 'player' }],
        },
      ],
    },
  ],
  handIns: [{ item: 'letter', owner: 'player', operation: 'transfer', recipient: 'giver' }],
  rewards: {
    recipient: 'player',
    numeric: [
      { id: 'xp', label: 'XP', field: field('xp'), amount: 5 },
      { id: 'gold', label: 'Gold', field: field('gold'), amount: 3 },
    ],
    items: [{ id: 'token', itemType: 'token' }],
  },
})

const dialogue = dialogueSchema.parse({
  'schema-version': '1.0.0',
  id: 'giver',
  label: 'Giver conversation',
  entry: 'greeting',
  nodes: {
    greeting: {
      lines: [{ speaker: 'Giver', text: 'Hello {{name}}.', bindings: { name: field('name') } }],
      choices: [
        {
          id: 'accept',
          label: 'Accept',
          when: [{ type: 'quest-state', quest: 'delivery', status: 'not-started' }],
          effects: [{ type: 'start-quest', quest: 'delivery' }],
          next: 'delivery',
        },
        {
          id: 'hidden',
          label: 'Secret',
          visibleWhen: [{ type: 'state-is', path: ['done'], value: true }],
          end: true,
        },
        { id: 'leave', label: 'Leave', end: true },
      ],
    },
    delivery: {
      lines: [{ text: 'The delivery awaits.' }],
      choices: [
        {
          id: 'deliver',
          label: 'Here is the letter',
          when: [{ type: 'quest-state', quest: 'delivery', status: 'ready' }],
          effects: [
            { type: 'complete-quest', quest: 'delivery' },
            { type: 'set-state', path: ['done'], value: true },
            { type: 'set-state', path: ['name'], value: 'Hero' },
            { type: 'append-log', text: 'Delivery completed' },
          ],
          next: 'thanks',
        },
      ],
    },
    thanks: {
      terminal: true,
      lines: [
        {
          text: 'Thank you, {{name}}. Level {{level}}.',
          bindings: { name: field('name'), level: field('level') },
        },
      ],
    },
  },
})

const keys = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['talk', 'reply', 'end', 'next', 'previous'],
  keyboard: { KeyQ: 'talk', KeyW: 'reply', KeyE: 'end', KeyR: 'next', KeyT: 'previous' },
  contexts: {
    play: { talk: 'talk', reply: 'reply', end: 'end', next: 'next', previous: 'previous' },
  },
  'initial-context': 'play',
})

const scene = (id: string) =>
  sceneSchema.parse({
    'schema-version': '1.0.0',
    id,
    title: id,
    type: 'game',
    screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
    components: [
      { id: 'text', type: 'text', text: 'The village.', placement: { row: 1, column: 1 } },
      {
        id: 'nearby',
        type: 'nearby',
        descriptionTarget: 'text',
        entries: {
          giver: {
            kind: 'character',
            label: 'Giver',
            description: 'A friendly person.',
            dialogue: 'giver',
            conversationId: 'giver',
          },
          other: { kind: 'object', label: 'Rock' },
        },
        placement: { row: 1, column: 2 },
      },
      { id: 'journal', type: 'quest-log', textTarget: 'text', placement: { row: 2, column: 1 } },
      {
        id: 'bar',
        type: 'action-bar',
        placement: { row: 3, column: 1 },
        slots: {
          '1': {
            label: 'Talk',
            action: { type: 'dialogue-action', nearby: 'nearby', command: { type: 'start' } },
            inputBinding: { context: 'play', input: 'talk' },
          },
          '2': {
            label: 'Reply',
            action: {
              type: 'dialogue-action',
              nearby: 'nearby',
              command: { type: 'choose', position: 1 },
            },
            inputBinding: { context: 'play', input: 'reply' },
          },
          '3': {
            label: 'End',
            action: { type: 'dialogue-action', nearby: 'nearby', command: { type: 'end' } },
            inputBinding: { context: 'play', input: 'end' },
          },
          '4': {
            label: 'Next replies',
            action: { type: 'dialogue-action', nearby: 'nearby', command: { type: 'next-page' } },
            inputBinding: { context: 'play', input: 'next' },
          },
          '5': {
            label: 'Previous replies',
            action: {
              type: 'dialogue-action',
              nearby: 'nearby',
              command: { type: 'previous-page' },
            },
            inputBinding: { context: 'play', input: 'previous' },
          },
          '6': {
            label: 'Turn in',
            action: { type: 'quest-action', journal: 'journal', operation: 'turn-in' },
          },
        },
      },
    ],
  })

const scenes = new Map([
  ['home', scene('home')],
  ['away', scene('away')],
])

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'story',
  title: 'Story',
  version: '1',
  scenes: ['home', 'away'],
  input: 'keys',
  rules: ['state'],
  inventory: ['items'],
  dialogues: ['giver'],
  quests: ['delivery'],
  leveling: ['player'],
})

const leveling = levelingProfileSchema.parse({
  'schema-version': '1.0.0',
  id: 'player',
  label: 'Player',
  xp: field('xp'),
  level: field('level'),
  levels: [
    { xp: 0 },
    { xp: 5, gains: [{ id: 'health', label: 'Health', field: field('hp'), amount: 4 }] },
  ],
})

function data(questDefinition = quest, dialogueDefinition = dialogue) {
  return assembleGameData(
    manifest,
    scenes,
    keys,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['state', rules]]),
    new Map(),
    new Map([['player', leveling]]),
    new Map(),
    new Map([['giver', dialogueDefinition]]),
    new Map([['delivery', questDefinition]]),
  )
}

async function setup(
  options: { quest?: QuestDefinition; dialogue?: DialogueDefinition; host?: boolean } = {},
) {
  const gameData = data(options.quest, options.dialogue)
  const error = vi.fn(() => '')

  const engine = new Engine(
    { load: async () => gameData },
    { mount: () => () => {} },
    { info: () => '', debug: () => '', warn: () => '', error },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      ...(options.host
        ? {
            createGameRules: () => ({ handlers: new Map() }),
            createGameLifecycle: () =>
              new GameLifecycle(gameData, {
                createGameState: () =>
                  new Map(rules.state.map((entry) => [entry.path[0]!, entry.value])),
                createSceneState: () => undefined,
              }),
            createStateTransactions: (game) => {
              if (!(game.state instanceof Map)) throw new Error('Expected Map')

              return new MapStateTransactions(
                game.state,
                rules.state
                  .filter((entry) => typeof entry.value === 'number')
                  .map((entry) => entry.path),
              )
            },
          }
        : {}),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  lifecycle.startGame()
  lifecycle.enterScene('home')
  const game = () => lifecycle.currentGame!
  const active = () => lifecycle.activeScene!

  const flush = () => {
    for (let i = 0; i < 6; i++) engine.flushMessages()
  }

  const select = (entry = 'giver') => game().nearby!.select(active(), 'nearby', entry)

  const command = (
    type: 'start' | 'end' | 'next-page' | 'previous-page' | 'choose',
    position = 1,
  ) => {
    game().dialogue!.request(active(), 'nearby', type === 'choose' ? { type, position } : { type })
    flush()
  }

  const value = (id: string) => game().bindings!.read(field(id))

  const set = (id: string, value: string | number | boolean) => {
    const state = game().state

    if (!(state instanceof Map)) throw new Error('Expected Map')
    state.set(id, value)
  }

  flush()

  return { engine, lifecycle, game, active, flush, select, command, value, set, error }
}

describe('branching dialogue and quest transactions', () => {
  it('accepts a quest, hands over a nested exact instance, and commits rewards, levels, log, state and dialogue together once', async () => {
    const { game, active, flush, select, command, value } = await setup()
    select()
    command('start')
    expect(game().dialogue!.text(active(), 'nearby')).toContain('Hello <Traveller>.')
    command('choose')
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
    const observations: unknown[] = []
    game().inventory!.subscribeChanges(() =>
      observations.push([
        value('gold'),
        value('xp'),
        value('level'),
        value('done'),
        game().quests!.snapshot('delivery')?.status,
        game().dialogue!.text(active(), 'nearby'),
      ]),
    )
    command('choose')
    expect(game().inventory!.snapshot.find((item) => item.id === 'letter')?.placement).toEqual({
      type: 'carried',
      owner: 'giver',
    })
    expect(game().inventory!.snapshot.find((item) => item.id === 'otherLetter')?.placement).toEqual(
      { type: 'carried', owner: 'player' },
    )
    expect(
      game().inventory!.snapshot.filter(
        (item) => item.id === questRewardItemId('delivery', 'token'),
      ),
    ).toHaveLength(1)
    expect(value('gold')).toMatchObject({ value: 5 })
    expect(value('level')).toMatchObject({ value: 2 })
    expect(value('hp')).toMatchObject({ value: 14 })
    expect(value('log')).toMatchObject({ value: 'Delivery completed' })
    expect(observations).toEqual([
      [
        { status: 'resolved', value: 5 },
        { status: 'resolved', value: 5 },
        { status: 'resolved', value: 2 },
        { status: 'resolved', value: true },
        'completed',
        expect.stringContaining('Thank you, Hero.'),
      ],
    ])
    expect(game().dialogue!.text(active(), 'nearby')).toContain('Hello <Traveller>.')
    game().quests!.request(active(), 'delivery', 'turn-in')
    flush()
    expect(value('gold')).toMatchObject({ value: 5 })
    expect(game().actions?.progression).toMatchObject({ turn: 0, worldTimeMs: 0 })
  })
  it('keeps a completed result when observers fail and never repeats it', async () => {
    const { game, active, select, command, value } = await setup()
    select()
    command('start')
    command('choose')
    game().inventory!.subscribeChanges(() => {
      throw new Error('observer failure')
    })
    expect(() => command('choose')).toThrow(AggregateError)
    expect(game().quests!.snapshot('delivery')?.status).toBe('completed')
    expect(value('gold')).toMatchObject({ value: 5 })
    expect(game().dialogue!.text(active(), 'nearby')).toContain('Thank you, Hero.')
    command('choose')
    expect(value('gold')).toMatchObject({ value: 5 })
  })
  it.each(['equipped', 'reserved', 'nonempty', 'missing', 'overflow'] as const)(
    'rejects %s hand-ins or rewards without partial writes',
    async (mode) => {
      const source =
        mode === 'nonempty'
          ? questSchema.parse({
              ...quest,
              handIns: [{ item: 'bag', owner: 'player', operation: 'consume' }],
            })
          : quest

      const { game, active, select, command, value, set } = await setup({ quest: source })
      select()
      command('start')
      command('choose')

      if (mode === 'equipped') game().inventory!.equip('letter', 'player', 'hand')

      if (mode === 'reserved') game().inventory!.reserveItem?.('letter', { encounter: 'paused' })

      if (mode === 'missing') game().inventory!.move('letter', { type: 'carried', owner: 'giver' })

      if (mode === 'overflow') set('gold', Number.MAX_SAFE_INTEGER)
      const before = game().inventory!.snapshot
      command('choose')
      expect(game().inventory!.snapshot).toEqual(before)
      expect(value('xp')).toMatchObject({ value: 0 })
      expect(value('done')).toMatchObject({ value: false })
      expect(game().dialogue!.text(active(), 'nearby')).not.toContain('Thank you')
      expect(game().quests!.snapshot('delivery')?.status).not.toBe('completed')
    },
  )
  it('requires the scalar/log adapter for an atomic choice even when numeric transactions are supported', async () => {
    const { game, active, select, command, value } = await setup({ host: true })
    select()
    command('start')
    command('choose')
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
    expect(game().dialogue!.reply(active(), 'nearby', 1)?.enabled).toBe(false)
    command('choose')
    expect(value('gold')).toMatchObject({ value: 2 })
    expect(game().inventory!.snapshot.find((item) => item.id === 'letter')?.placement.type).toBe(
      'inside',
    )
  })
  it('keeps final readiness live and preserves direct-carried condition semantics', async () => {
    const { game, active, flush } = await setup()
    game().quests!.request(active(), 'delivery', 'start')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
    expect(
      matchesConditions([{ type: 'item-carried-by', item: 'letter', owner: 'player' }], {
        game: game(),
        scene: active(),
      }),
    ).toBe(false)
    expect(
      matchesConditions([{ type: 'item-owned-by', item: 'letter', owner: 'player' }], {
        game: game(),
        scene: active(),
      }),
    ).toBe(true)
    game().inventory!.move('letter', { type: 'carried', owner: 'giver' })
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('active')
    game().inventory!.move('letter', { type: 'inside', container: 'bag' })
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
  })
  it('advances intermediate stages at a queued boundary, handles pre-existing facts, and resets on New Game', async () => {
    const source = questSchema.parse({
      ...quest,
      stages: [
        {
          id: 'first',
          objectives: [
            {
              id: 'first',
              label: 'Already has 2 gold',
              progress: { binding: field('gold'), target: 2 },
            },
          ],
        },
        ...quest.stages,
      ],
    })

    const { game, lifecycle, active, flush } = await setup({ quest: source })
    game().actions!.request('accept')
    flush()
    expect(game().quests!.snapshot('delivery')).toMatchObject({ status: 'ready', stage: 'deliver' })
    game().quests!.select(active(), 'journal', 'delivery')
    game().quests!.request(active(), 'delivery', 'track')
    flush()
    expect(
      game().bindings!.read({ source: 'game.quests', path: ['delivery', 'tracked'] }),
    ).toMatchObject({ value: true })
    lifecycle.enterScene('away')
    flush()
    expect(game().quests!.snapshot('delivery')?.tracked).toBe(true)
    lifecycle.startGame()
    lifecycle.enterScene('home')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    expect(game().quests!.snapshot('delivery')?.tracked).toBe(false)
  })
  it('pauses on selection change, resumes the same node across shared identities, and restarts finished exchanges', async () => {
    const { game, lifecycle, active, select, command } = await setup()
    select()
    command('start')
    command('choose')
    select('other')
    expect(
      game().dialogue!.reason(active(), 'nearby', { type: 'choose', position: 1 }),
    ).toBeDefined()
    lifecycle.enterScene('away')
    select()
    command('start')
    expect(game().dialogue!.reply(active(), 'nearby', 1)?.label).toBe('Here is the letter')
    expect(game().dialogue!.text(active(), 'nearby')).toContain('Hello <Traveller>.')
    command('choose')
    command('start')
    expect(game().dialogue!.text(active(), 'nearby')).not.toContain('Thank you')
    expect(game().dialogue!.reply(active(), 'nearby', 1)?.enabled).toBe(false)
  })
  it('keeps hidden choice positions blank and pages by authored order', async () => {
    const { game, active, select, command } = await setup()
    select()
    command('start')
    command('next-page')
    expect(game().actionBar!.getSlot(active(), 'bar', '2')).toBeUndefined()
    command('next-page')
    expect(game().actionBar!.getSlot(active(), 'bar', '2')?.label).toBe('Leave')
    command('previous-page')
    expect(game().dialogue!.reply(active(), 'nearby', 1)).toBeUndefined()
  })
  it('discards queued reply input after participant, scene, page, state, or journal selection changes', async () => {
    const { game, active, select, command, engine, flush, lifecycle, set } = await setup()
    select()
    command('start')
    engine.input!.pressKey('KeyW')
    select('other')
    flush()
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    select()
    command('start')
    engine.input!.pressKey('KeyW')
    set('gold', 4)
    flush()
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    engine.input!.pressKey('KeyW')
    lifecycle.enterScene('away')
    select()
    command('start')
    flush()
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    game().actionBar!.activate(active(), 'bar', '2')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
    const captured = game().quests!.capture(active())
    game().quests!.request(active(), 'delivery', 'turn-in', captured)
    game().quests!.select(active(), 'journal', 'delivery')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
  })
  it('supports consumption, captured scalar safety, and localization without replaying effects', async () => {
    const source = questSchema.parse({
      ...quest,
      handIns: [{ item: 'letter', owner: 'player', operation: 'consume' }],
    })

    const translated = dialogueSchema.parse({
      ...dialogue,
      labelKey: 'title',
      nodes: {
        ...dialogue.nodes,
        greeting: {
          ...dialogue.nodes.greeting!,
          lines: [{ text: { textKey: 'hello' }, bindings: { name: field('name') } }],
        },
      },
    })

    const en = { title: 'English', hello: 'Hello {{name}}.' }
    const nl = { title: 'Nederlands', hello: 'Hallo {{name}}.' }
    const localized = localizeStory(translated, { fallback: en, messages: nl })
    expect(localized.label).toBe('Nederlands')
    expect(() => localizeStory(translated)).toThrow('translation keys')
    const { game, active, select, command } = await setup({ quest: source })
    select()
    command('start')
    command('choose')
    command('choose')
    expect(game().inventory!.snapshot.some((item) => item.id === 'letter')).toBe(false)
    expect(game().dialogue!.text(active(), 'nearby')).toContain('<Traveller>')
  })
})

describe('dialogue presentation and input ownership', () => {
  it('captures post-reward levels and keeps literal and unresolved text safe', async () => {
    const { game, active, select, command } = await setup()
    select()
    command('start')
    command('choose')
    command('choose')
    expect(game().dialogue!.text(active(), 'nearby')).toContain('Level 2.')

    const source = dialogueSchema.parse({
      ...dialogue,
      nodes: {
        ...dialogue.nodes,
        greeting: {
          terminal: true,
          lines: [
            { text: '<script> {{literal}}' },
            {
              text: 'Hello {{name}}.',
              bindings: { name: { ...field('name'), fallback: 'visitor' } },
            },
          ],
        },
      },
    })

    const second = await setup({ dialogue: source })
    second.set('name', Number.NaN)
    second.select()
    second.command('start')
    expect(second.game().dialogue!.text(second.active(), 'nearby')).toContain(
      '<script> {{literal}}',
    )
    expect(second.game().dialogue!.text(second.active(), 'nearby')).toContain('Hello visitor.')
    expect(second.game().dialogue!.text(second.active(), 'nearby')).toContain(
      'Some dialogue values are unavailable.',
    )
  })
  it('discards a reply queued behind paging and consumes its held terminal phase after a transition', async () => {
    const { game, active, select, command, engine, flush, lifecycle } = await setup()
    select()
    command('start')
    engine.input!.pressKey('KeyW')
    command('next-page')
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    expect(game().actionBar!.getSlot(active(), 'bar', '2')).toBeUndefined()
    engine.input!.pressKey('KeyW')
    flush()
    lifecycle.enterScene('away')
    select()
    command('start')
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('not-started')
    command('previous-page')
    engine.input!.pressKey('KeyW')
    engine.input!.releaseKey('KeyW')
    flush()
    expect(game().quests!.snapshot('delivery')?.status).toBe('ready')
  })
})

function project() {
  return {
    revision: 'one',
    documents: {
      'game.json': manifest,
      'input/keys.json': keys,
      'inventory/items.json': inventory,
      'rules/state.json': rules,
      'leveling/player.json': leveling,
      'dialogues/giver.json': {
        ...dialogue,
        extension: 'definition',
        nodes: {
          ...dialogue.nodes,
          greeting: {
            ...dialogue.nodes.greeting,
            extension: 'node',
            choices: dialogue.nodes.greeting!.choices.map((choice) => ({
              ...choice,
              extension: 'choice',
            })),
          },
        },
      },
      'quests/delivery.json': quest,
      'scenes/home.json': scene('home'),
      'scenes/away.json': scene('away'),
    },
  }
}

describe('story project integration', () => {
  it('inspects definitions and protects references, input reachability and declared fields', () => {
    const original = project()
    expect(validateProject(original.documents)).toEqual([])
    const view = projectViewSchema.parse(inspectProject(original))
    expect(view.dialogues?.giver?.entry).toBe('greeting')
    expect(view.quests?.delivery?.handIns[0]?.item).toBe('letter')
    expect(() =>
      applyCommand(original, { type: 'game.removeDialogue', dialogueId: 'giver' }),
    ).toThrow()
    expect(() =>
      applyCommand(original, { type: 'game.removeQuest', questId: 'delivery' }),
    ).toThrow()
    const changed = structuredClone(dialogue)
    delete changed.nodes.thanks
    expect(() =>
      applyCommand(original, { type: 'game.upsertDialogue', dialogue: changed }),
    ).toThrow()
    const state = { ...rules, state: rules.state.filter((entry) => entry.path[0] !== 'gold') }
    const documents = { ...original.documents, 'rules/state.json': state }
    expect(validateProject(documents).some((issue) => issue.code === 'invalid_story')).toBe(true)
    const home = scene('home')
    const bar = home.components.find((component) => component.type === 'action-bar')!

    if (bar.type === 'action-bar') delete bar.slots['4']
    expect(
      validateProject({ ...original.documents, 'scenes/home.json': home }).some((issue) =>
        issue.message.includes('previous and next'),
      ),
    ).toBe(true)
  })
  it('preserves extensions by stable IDs while removing authored optional fields', () => {
    const original = project()
    const draft = structuredClone(dialogue)
    draft.nodes.greeting!.choices[0]!.unavailableText = undefined
    const change = applyCommand(original, { type: 'game.upsertDialogue', dialogue: draft })
    const saved = object(change.project.documents['dialogues/giver.json'])
    expect(saved.extension).toBe('definition')
    const node = object(object(saved.nodes).greeting)
    expect(node.extension).toBe('node')
    expect(object(Array.isArray(node.choices) ? node.choices[0] : undefined).extension).toBe(
      'choice',
    )
    expect(original.documents['dialogues/giver.json'].nodes.greeting.extension).toBe('node')
  })
  it.each(['basic', 'graphics'])(
    'loads and validates the %s sample with story resources',
    async (sample) => {
      const texts = new Map<string, string>()
      const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

      const loaded = await new GameLoader(
        new JsonResourceLoader(
          {
            readText: async (path) => {
              const text = await readFile(
                new URL(`../sample-games/${sample}/${path}`, import.meta.url),
                'utf8',
              )

              texts.set(path, text)

              return text
            },
            readBytes: async () => new Uint8Array(),
          },
          logger,
        ),
      ).load()

      expect(loaded.quests?.size).toBe(1)

      const documents = Object.fromEntries(
        [...texts]
          .filter(([file]) => file.endsWith('.json'))
          .map(([file, text]) => [file, JSON.parse(text)]),
      )

      expect(validateProject(documents)).toEqual([])
    },
  )
})
