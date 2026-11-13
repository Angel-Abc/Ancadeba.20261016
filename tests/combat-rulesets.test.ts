import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  combatMechanicsOverridesSchema,
  resolveCombatSource,
  resolveCombatRuleset,
  applyCombatMechanicsOverrides,
  diffCombatMechanics,
  cloneCombatRules,
  localizeCombat,
  localizeCombatLibrary,
  combatLibraryIssues,
  type CombatSource,
} from '@ancadeba/schemas'
import {
  applyCommand,
  inspectProject,
  validateProject,
  object,
  projectViewSchema,
} from '@ancadeba/editor-core'
import { Engine, GameLoader, type EngineMessages, type GameSaveStore } from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'

function fixture() {
  const library = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'common',
    moves: {
      attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 3 } },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
    },
    statuses: { tired: { type: 'damage', label: 'Tired', amount: 1, duration: 2 } },
    rulesets: {
      tides: {
        label: 'Tides',
        actors: ['hero', 'boss'],
        mechanics: {
          resources: {
            stamina: { label: 'Stamina', actor: 'hero', initial: 10, maximum: 20 },
            gauge: { label: 'Gauge', initial: 0, maximum: 100 },
          },
          triggers: {
            pressure: {
              event: 'turn-start',
              actor: 'hero',
              effects: [{ type: 'change-resource', resource: 'gauge', amount: 5 }],
            },
            recover: {
              event: 'round-end',
              effects: [{ type: 'change-resource', resource: 'stamina', amount: 1 }],
            },
            fatigue: {
              event: 'resource-changed',
              resource: 'stamina',
              conditions: [{ type: 'resource', resource: 'stamina', operator: 'lte', value: 0 }],
              effects: [{ type: 'apply-status', actor: 'hero', status: 'tired' }],
            },
            burst: {
              event: 'resource-changed',
              resource: 'gauge',
              once: true,
              conditions: [
                { type: 'phase', phase: 'calm' },
                { type: 'health', actor: 'boss', operator: 'gt', value: 0 },
                { type: 'resource', resource: 'gauge', operator: 'gte', value: 100 },
              ],
              effects: [{ type: 'set-phase', phase: 'burst' }],
            },
          },
          initialPhase: 'calm',
          phases: {
            calm: { label: 'Calm', enemyRotations: { boss: ['guard'] } },
            burst: {
              label: 'Burst',
              onEnter: [{ type: 'apply-status', actor: 'hero', status: 'tired' }],
              enemyRotations: { boss: ['attack', 'guard'] },
            },
          },
        },
      },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'first',
    label: 'First',
    player: {
      id: 'knight',
      label: 'Knight',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 50,
      moves: ['charge', 'guard'],
    },
    enemies: [
      {
        id: 'crab',
        label: 'Crab',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 50,
        moves: ['attack', 'guard'],
        rotation: ['guard'],
      },
    ],
    moves: {
      charge: {
        type: 'ability',
        label: 'Charge',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'charge', type: 'change-resource', resource: 'gauge', amount: 25 }],
      },
    },
    ruleset: { library: 'common', id: 'tides', actors: { hero: 'knight', boss: 'crab' } },
  })

  return { library, source, libraries: new Map([['common', library]]) }
}

function documents(source: CombatSource, library: ReturnType<typeof fixture>['library']) {
  return {
    'game.json': {
      'schema-version': '1.0.0',
      id: 'rulesets',
      title: 'Rulesets',
      version: '1',
      scenes: ['first'],
      combat: ['first'],
      combatLibraries: ['common'],
      rules: ['state'],
    },
    'scenes/first.json': {
      'schema-version': '1.0.0',
      id: 'first',
      title: 'First',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
      components: [],
    },
    'rules/state.json': {
      state: [
        { path: ['hp'], value: 50 },
        { path: ['enemy'], value: 50 },
      ],
      actions: {},
    },
    'combat/first.json': source,
    'combat-libraries/common.json': library,
  }
}

describe('reusable combat rulesets', () => {
  it('keeps saves compatible with presentation-only sparse overrides while checking resolved mechanics', async () => {
    const { source, library } = fixture()
    const files = new Map<string, unknown>(Object.entries(documents(source, library)))
    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const load = () =>
      new GameLoader(
        new JsonResourceLoader(
          {
            readText: async (path) => {
              if (!files.has(path)) throw new Error(`Missing fixture: ${path}`)

              return JSON.stringify(files.get(path))
            },
            readBytes: async () => new Uint8Array(),
          },
          logger,
        ),
      ).load()

    const before = await load()
    source.mechanicsOverrides = {
      resources: { gauge: { label: 'Translated gauge' } },
      phases: { calm: { description: 'Translated phase description' } },
    }
    const translated = await load()
    expect(translated.saveCompatibility).toBe(before.saveCompatibility)
    expect(translated.combat!.get('first')!.mechanics!.resources.gauge!.label).toBe(
      'Translated gauge',
    )
    source.mechanicsOverrides.resources!.gauge!.maximum = 200
    expect((await load()).saveCompatibility).not.toBe(before.saveCompatibility)
  })

  it('keeps patches sparse and rejects ambiguous sources and missing rulesets', () => {
    expect(
      combatMechanicsOverridesSchema.parse({
        resources: { stamina: { maximum: 30 } },
        triggers: { pressure: { once: true } },
      }),
    ).toEqual({ resources: { stamina: { maximum: 30 } }, triggers: { pressure: { once: true } } })
    const { source, libraries, library } = fixture()
    expect(
      combatSourceSchema.safeParse({ ...source, mechanics: library.rulesets!.tides!.mechanics })
        .success,
    ).toBe(false)
    expect(
      combatSourceSchema.safeParse({ ...source, ruleset: undefined, mechanicsOverrides: {} })
        .success,
    ).toBe(false)
    expect(resolveCombatSource(source, new Map()).issues[0]?.message).toContain(
      'Missing combat ruleset',
    )
    expect(
      resolveCombatSource({ ...source, ruleset: { library: 'common', id: 'missing' } }, libraries)
        .definition,
    ).toBeUndefined()
  })

  it('binds roles in every actor-bearing field and imports implicit mechanics dependencies once', () => {
    const { source, libraries } = fixture()
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    expect(result.definition?.mechanics).toMatchObject({
      resources: { stamina: { actor: 'knight' } },
      triggers: {
        pressure: { actor: 'knight' },
        fatigue: { effects: [{ actor: 'knight' }] },
        burst: { conditions: [{ type: 'phase' }, { actor: 'crab' }, { type: 'resource' }] },
      },
      phases: {
        calm: { enemyRotations: { crab: ['guard'] } },
        burst: { onEnter: [{ actor: 'knight' }], enemyRotations: { crab: ['attack', 'guard'] } },
      },
    })
    expect(Object.keys(result.definition!.moves)).toEqual(['charge', 'guard', 'attack'])
    expect(Object.keys(result.definition!.statuses!)).toEqual(['tired'])
    expect(result.origins.mechanics?.resources.stamina).toMatchObject({
      file: 'combat-libraries/common.json',
      library: 'common',
      ruleset: 'tides',
    })
    expect(result.origins.statuses.tired?.library).toBe('common')
    expect(result.origins.moves.guard?.library).toBe('common')
    expect(Object.isFrozen(result.definition?.mechanics?.resources.stamina)).toBe(true)
  })

  it('inherits library updates while overriding only selected fields and never mutates authored rules', () => {
    const { source, libraries, library } = fixture()
    source.mechanicsOverrides = {
      resources: { stamina: { maximum: 30 } },
      triggers: {
        pressure: { effects: [{ type: 'change-resource', resource: 'gauge', amount: 10 }] },
      },
    }
    const before = JSON.stringify({ source, library })
    const first = resolveCombatSource(source, libraries)
    expect(first.definition?.mechanics?.resources.stamina).toMatchObject({
      label: 'Stamina',
      initial: 10,
      maximum: 30,
      actor: 'knight',
    })
    expect(first.origins.mechanics?.resources.stamina).toMatchObject({
      file: 'combat/first.json',
      path: ['mechanicsOverrides', 'resources', 'stamina'],
    })
    expect(JSON.stringify({ source, library })).toBe(before)
    library.rulesets!.tides!.mechanics.resources.stamina!.initial = 15
    library.rulesets!.tides!.mechanics.resources.stamina!.maximum = 40
    library.rulesets!.tides!.mechanics.resources.stamina!.label = 'Breath'
    const next = resolveCombatSource(source, libraries)
    expect(next.definition?.mechanics?.resources.stamina).toMatchObject({
      initial: 15,
      maximum: 30,
      label: 'Breath',
    })
    expect(first.definition?.mechanics?.resources.stamina?.label).toBe('Stamina')
  })

  it('supports exclusions, new entries, optional-field removal, array replacement and explicit trigger order', () => {
    const { source, libraries } = fixture()
    source.mechanicsOverrides = {
      triggers: {
        recover: null,
        pressure: {
          event: 'round-start',
          actor: null,
          effects: [{ type: 'change-resource', resource: 'gauge', amount: 2 }],
        },
        extra: {
          event: 'round-end',
          effects: [{ type: 'change-resource', resource: 'stamina', amount: 2 }],
        },
      },
      phases: { burst: { onEnter: [], enemyRotations: { crab: ['guard'] } } },
      resources: { counter: { label: 'Counter', initial: 0, maximum: 3 } },
      triggerOrder: ['extra', 'pressure'],
    }
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    expect(Object.keys(result.definition!.mechanics!.triggers)).toEqual([
      'extra',
      'pressure',
      'fatigue',
      'burst',
    ])
    expect(result.definition!.mechanics!.triggers.pressure?.actor).toBeUndefined()
    expect(result.definition!.mechanics!.phases.burst).toMatchObject({
      label: 'Burst',
      onEnter: [],
      enemyRotations: { crab: ['guard'] },
    })
    const base = resolveCombatRuleset(source, libraries).base!
    const edited = result.definition!.mechanics!
    expect(applyCombatMechanicsOverrides(base, diffCombatMechanics(base, edited))).toEqual(edited)
    expect(diffCombatMechanics(base, cloneCombatRules(base))).toEqual({})
    expect(
      combatMechanicsOverridesSchema.safeParse({ triggerOrder: ['extra', 'extra'] }).success,
    ).toBe(false)
    expect(() => applyCombatMechanicsOverrides(base, { triggerOrder: ['missing'] })).toThrow(
      'Unknown trigger',
    )
  })

  it('validates unused library rulesets, role bindings and references after exclusions', () => {
    const { source, library, libraries } = fixture()
    const badRole = cloneCombatRules(library)
    badRole.rulesets!.tides!.mechanics.resources.stamina!.actor = 'unknown'
    expect(combatLibrarySchema.safeParse(badRole).success).toBe(false)
    expect(
      resolveCombatSource(
        {
          ...source,
          ruleset: { library: 'common', id: 'tides', actors: { hero: 'missing', boss: 'crab' } },
        },
        libraries,
      ).issues.some((issue) => issue.message.includes('Bind actor role')),
    ).toBe(true)
    expect(
      resolveCombatSource(
        {
          ...source,
          ruleset: { library: 'common', id: 'tides', actors: { hero: 'knight', boss: 'knight' } },
        },
        libraries,
      ).issues.some((issue) => issue.message.includes('distinct actors')),
    ).toBe(true)
    expect(
      resolveCombatSource(
        {
          ...source,
          ruleset: {
            ...source.ruleset!,
            actors: { hero: 'knight', boss: 'crab', missing: 'crab' },
          },
        },
        libraries,
      ).issues.some((issue) => issue.message.includes('Unknown ruleset actor role')),
    ).toBe(true)
    expect(
      resolveCombatSource(
        { ...source, mechanicsOverrides: { resources: { gauge: null } } },
        libraries,
      ).definition,
    ).toBeUndefined()
    expect(
      resolveCombatSource(
        { ...source, mechanicsOverrides: { resources: { stamina: { maximum: 1 } } } },
        libraries,
      ).definition,
    ).toBeUndefined()
    const missingStatus = cloneCombatRules(library)
    missingStatus.statuses = {}
    expect(combatLibrarySchema.safeParse(missingStatus).success).toBe(false)
  })

  it('respects encounter move/status replacements and merges phase rotations by bound actor', () => {
    const { source, library } = fixture()

    const inherited = combatLibrarySchema.parse({
      ...library,
      moves: {
        ...library.moves,
        guard: {
          type: 'ability',
          label: 'Fatigue guard',
          apCost: 1,
          target: 'self',
          effects: [{ id: 'tired', type: 'apply-status', status: 'tired' }],
        },
      },
      rulesets: {
        tides: {
          ...library.rulesets!.tides,
          actors: ['hero', 'boss', 'helper'],
          mechanics: {
            ...library.rulesets!.tides!.mechanics,
            phases: {
              ...library.rulesets!.tides!.mechanics.phases,
              burst: {
                ...library.rulesets!.tides!.mechanics.phases.burst,
                enemyRotations: { boss: ['attack'], helper: ['guard'] },
              },
            },
          },
        },
      },
    })

    const linked = combatSourceSchema.parse({
      ...source,
      enemies: [
        ...source.enemies,
        {
          ...source.enemies[0],
          id: 'minion',
          health: { source: 'game.state', path: ['minion'] },
          moves: ['guard'],
        },
      ],
      ruleset: { ...source.ruleset, actors: { hero: 'knight', boss: 'crab', helper: 'minion' } },
      moves: {
        ...source.moves,
        attack: { type: 'attack', label: 'Local attack', apCost: 1, damage: { min: 9, max: 9 } },
      },
      statuses: { tired: { type: 'damage', label: 'Local fatigue', duration: 3, amount: 5 } },
      mechanicsOverrides: { phases: { burst: { enemyRotations: { crab: null } } } },
    })

    const result = resolveCombatSource(linked, new Map([['common', inherited]]))
    expect(result.issues).toEqual([])
    expect(result.definition?.statuses?.tired).toMatchObject({ label: 'Local fatigue', amount: 5 })
    expect(result.definition?.moves.attack).toMatchObject({ label: 'Local attack' })
    expect(result.definition?.mechanics?.phases.burst?.enemyRotations).toEqual({
      minion: ['guard'],
    })
    const base = resolveCombatRuleset(linked, new Map([['common', inherited]])).base!
    const patch = diffCombatMechanics(base, result.definition!.mechanics!)
    expect(patch).toEqual({ phases: { burst: { enemyRotations: { crab: null } } } })
    expect(applyCombatMechanicsOverrides(base, patch)).toEqual(result.definition!.mechanics)
  })

  it('localizes ruleset metadata and mechanics without changing the authored library', () => {
    const { source, library, libraries } = fixture()
    const ruleset = library.rulesets!.tides!
    ruleset.labelKey = 'ruleset'
    ruleset.mechanics.resources.stamina!.labelKey = 'stamina'
    ruleset.mechanics.phases.calm!.descriptionKey = 'calm'
    expect(combatLibraryIssues(library).map((issue) => issue.message)).toHaveLength(3)

    const translation = {
      fallback: { ruleset: 'Rules', stamina: 'Stamina', calm: 'Calm waters' },
      messages: { ruleset: 'Regels', stamina: 'Uithoudingsvermogen', calm: 'Rustig water' },
    }

    expect(combatLibraryIssues(library, undefined, translation)).toEqual([])
    const localizedLibrary = localizeCombatLibrary(library, translation)
    expect(localizedLibrary.rulesets?.tides?.label).toBe('Regels')
    expect(localizedLibrary.rulesets?.tides?.mechanics.resources.stamina?.label).toBe(
      'Uithoudingsvermogen',
    )

    const localized = localizeCombat(
      resolveCombatSource(source, libraries).definition!,
      translation,
    )

    expect(localized.mechanics?.phases.calm?.description).toBe('Rustig water')
    expect(library.rulesets!.tides!.mechanics.resources.stamina!.label).toBe('Stamina')
  })
})

describe('ruleset authoring persistence', () => {
  it('preserves references, sparse overrides and nested extensions without materializing inherited mechanics', () => {
    const { source, library } = fixture()
    source.mechanicsOverrides = { resources: { stamina: { maximum: 30 } } }

    const rawSource = {
      ...source,
      ruleset: { ...source.ruleset, extension: 'reference' },
      mechanicsOverrides: {
        extension: 'root',
        resources: { stamina: { maximum: 30, extension: 'patch' } },
      },
    }

    const rawLibrary = {
      ...library,
      rulesets: {
        tides: {
          ...library.rulesets!.tides,
          extension: 'ruleset',
          mechanics: { ...library.rulesets!.tides!.mechanics, extension: 'mechanics' },
        },
      },
    }

    const project = {
      revision: 'one',
      documents: {
        ...documents(source, library),
        'combat/first.json': rawSource,
        'combat-libraries/common.json': rawLibrary,
      },
    }

    expect(validateProject(project.documents)).toEqual([])
    const view = projectViewSchema.parse(inspectProject(project))

    const saved = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: view.combatSources!.first!,
    })

    const next = object(saved.project.documents['combat/first.json'])
    expect(next.mechanics).toBeUndefined()
    expect(next.ruleset).toMatchObject({
      library: 'common',
      id: 'tides',
      actors: { hero: 'knight', boss: 'crab' },
      extension: 'reference',
    })
    expect(next.mechanicsOverrides).toEqual(rawSource.mechanicsOverrides)

    const librarySave = applyCommand(saved.project, {
      type: 'game.upsertCombatLibrary',
      library: view.combatLibraries!.common!,
    })

    const savedRuleset = object(
      object(object(librarySave.project.documents['combat-libraries/common.json']).rulesets).tides,
    )

    expect(savedRuleset.extension).toBe('ruleset')
    expect(object(savedRuleset.mechanics).extension).toBe('mechanics')

    const reset = applyCommand(librarySave.project, {
      type: 'game.upsertCombat',
      encounter: { ...view.combatSources!.first!, mechanicsOverrides: {} },
    })

    expect(object(reset.project.documents['combat/first.json']).mechanicsOverrides).toEqual({
      extension: 'root',
    })
    expect(inspectProject(reset.project).combat!.first!.mechanics!.resources.stamina!.maximum).toBe(
      20,
    )
  })

  it('guards accidental flattening, library deletion and invalid shared edits, and permits explicit detachment', () => {
    const { source, library } = fixture()
    const project = { revision: 'one', documents: documents(source, library) }
    const view = inspectProject(project)
    expect(() =>
      applyCommand(project, { type: 'game.upsertCombat', encounter: view.combat!.first! }),
    ).toThrow('Include ruleset explicitly')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, rulesets: undefined },
      }),
    ).toThrow('Include rulesets explicitly')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, rulesets: {} },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(project, { type: 'game.removeCombatLibrary', libraryId: 'common' }),
    ).toThrow()
    const bad = cloneCombatRules(library)
    bad.rulesets!.tides!.actors.push('extra')
    expect(() =>
      applyCommand(project, { type: 'game.upsertCombatLibrary', library: bad }),
    ).toThrow()
    const mechanics = resolveCombatRuleset(source, new Map([['common', library]])).mechanics

    const detached = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: {
        ...source,
        ruleset: null,
        mechanics,
        sharedMoves: [
          { library: 'common', id: 'guard' },
          { library: 'common', id: 'attack' },
        ],
        sharedStatuses: [{ library: 'common', id: 'tired' }],
      },
    })

    expect(object(detached.project.documents['combat/first.json']).ruleset).toBeUndefined()
    expect(inspectProject(detached.project).combat!.first!.mechanics).toEqual(mechanics)
  })
})

class MemorySaves implements GameSaveStore {
  readonly values = new Map<string, string>()
  read(id: string) {
    return this.values.get(id)
  }
  write(id: string, value: string) {
    this.values.set(id, value)
  }
}

async function launch(store: GameSaveStore) {
  const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

  const engine = new Engine(
    new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) =>
            readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url), 'utf8'),
          readBytes: async (path) =>
            new Uint8Array(
              await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
            ),
        },
        logger,
      ),
    ),
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} }, saveStore: store },
  )

  await engine.start()
  onTestFinished(() => engine.stop())

  const enter = (id: string) => {
    if (!engine.lifecycle!.currentGame) engine.lifecycle!.startGame()

    return engine.lifecycle!.enterScene(id)
  }

  const snapshot = () =>
    engine.lifecycle!.currentGame!.combat!.snapshot(engine.lifecycle!.activeScene!, 'combat')!

  const end = () => {
    engine.lifecycle!.currentGame!.combat!.request(engine.lifecycle!.activeScene!, 'combat', {
      type: 'end-turn',
    })

    for (let index = 0; index < 8; index++) engine.flushMessages()
  }

  return { engine, enter, snapshot, end }
}

describe('shared ruleset runtime', () => {
  it('runs and saves independent encounters with inherited and overridden mechanics, including actor bindings', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.enter('shared-water')
    expect(first.snapshot().resources).toEqual({ exhaustion: 0, stamina: 100 })
    first.end()
    expect(first.snapshot().resources.exhaustion).toBe(10)
    first.enter('rough-water')
    expect(first.snapshot().resources).toEqual({ exhaustion: 0, stamina: 60 })
    first.end()
    expect(first.snapshot().resources).toEqual({ exhaustion: 20, stamina: 70 })
    expect(first.engine.saves!.save()).toBe(true)
    first.engine.stop()
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.snapshot().resources).toEqual({ exhaustion: 20, stamina: 70 })
    second.enter('shared-water')
    expect(second.snapshot().resources).toEqual({ exhaustion: 10, stamina: 100 })
    const source = second.engine.game!.combatLibraries!.get('environments')!.rulesets!.underwater!
    expect(source.mechanics.resources.stamina!.initial).toBe(100)
    expect(source.mechanics.resources.exhaustion!.actor).toBe('swimmer')
  })
})
