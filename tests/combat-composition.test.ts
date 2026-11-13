import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  combatRulesetReferences,
  cloneCombatRules,
  resolveCombatRuleset,
  resolveCombatSource,
  type CombatSource,
} from '@ancadeba/schemas'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'
import { CombatSimulation, runCombatScenario, combatSimulationSetup } from '@ancadeba/game-runtime'

function fixture() {
  const water = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'ocean',
    moves: {
      rest: {
        type: 'ability',
        label: 'Rest',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'recover', type: 'change-resource', resource: 'exhaustion', amount: -30 }],
      },
    },
    statuses: { tired: { type: 'modifier', label: 'Tired', duration: 2, modifiers: { ap: -1 } } },
    rulesets: {
      water: {
        actors: ['swimmer'],
        mechanics: {
          resources: { exhaustion: { actor: 'swimmer', initial: 0, maximum: 100 } },
          triggers: {
            pressure: {
              event: 'turn-start',
              actor: 'swimmer',
              effects: [{ type: 'change-resource', resource: 'exhaustion', amount: 10 }],
            },
            fatigue: {
              event: 'resource-changed',
              resource: 'exhaustion',
              conditions: [
                { type: 'resource', resource: 'exhaustion', operator: 'gte', value: 60 },
              ],
              effects: [{ type: 'apply-status', actor: 'swimmer', status: 'tired' }],
            },
          },
        },
      },
    },
  })

  const boss = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'bosses',
    moves: {
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
      pulse: { type: 'attack', label: 'Pulse', apCost: 1, damage: { min: 1, max: 1 } },
    },
    statuses: {
      focus: { type: 'modifier', label: 'Focus', duration: 2, modifiers: { defense: 1 } },
    },
    rulesets: {
      seals: {
        actors: ['hero', 'boss'],
        mechanics: {
          victory: 'triggers',
          initialPhase: 'first',
          resources: { seal: { initial: 0, maximum: 100 } },
          phases: {
            first: {
              label: 'First seal',
              onEnter: [{ type: 'apply-status', actor: 'hero', status: 'focus' }],
              enemyRotations: { boss: ['pulse'] },
            },
          },
          triggers: {
            filled: {
              event: 'resource-changed',
              resource: 'seal',
              conditions: [{ type: 'resource', resource: 'seal', operator: 'gte', value: 100 }],
              effects: [{ type: 'finish', outcome: 'victory' }],
            },
          },
        },
      },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'drowned',
    label: 'Drowned guardian',
    player: {
      id: 'diver',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      moves: ['channel', 'rest', 'guard'],
    },
    enemies: [
      {
        id: 'guardian',
        label: 'Guardian',
        health: { source: 'game.state', path: ['foe'] },
        maximumHealth: 500,
        moves: ['pulse', 'guard'],
        rotation: ['guard'],
      },
    ],
    moves: {
      channel: {
        type: 'ability',
        label: 'Channel',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'seal', type: 'change-resource', resource: 'seal', amount: 25 }],
      },
    },
    rulesets: [
      { library: 'ocean', id: 'water', actors: { swimmer: 'diver' } },
      { library: 'bosses', id: 'seals', actors: { hero: 'diver', boss: 'guardian' } },
    ],
  })

  return {
    source,
    water,
    boss,
    libraries: new Map([
      ['ocean', water],
      ['bosses', boss],
    ]),
  }
}

function project(
  source: CombatSource,
  water: ReturnType<typeof fixture>['water'],
  boss: ReturnType<typeof fixture>['boss'],
) {
  return {
    revision: 'one',
    documents: {
      'game.json': {
        'schema-version': '1.0.0',
        id: 'layers',
        title: 'Layers',
        version: '1',
        scenes: ['fight'],
        combat: ['drowned'],
        combatLibraries: ['ocean', 'bosses'],
        rules: ['state'],
      },
      'scenes/fight.json': {
        'schema-version': '1.0.0',
        id: 'fight',
        title: 'Fight',
        type: 'game',
        screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
        components: [],
      },
      'rules/state.json': {
        state: [
          { path: ['hp'], value: 80 },
          { path: ['foe'], value: 500 },
        ],
        actions: {},
      },
      'combat/drowned.json': source,
      'combat-libraries/ocean.json': water,
      'combat-libraries/bosses.json': boss,
    },
  }
}

describe('ordered reusable ruleset composition', () => {
  it('rejects mixed modes, duplicate/excessive layers and orphan overrides while preserving legacy sources', () => {
    const { source } = fixture()
    expect(combatSourceSchema.safeParse({ ...source, ruleset: source.rulesets![0] }).success).toBe(
      false,
    )
    expect(combatSourceSchema.safeParse({ ...source, mechanics: {} }).success).toBe(false)
    expect(
      combatSourceSchema.safeParse({
        ...source,
        rulesets: [source.rulesets![0], source.rulesets![0]],
      }).success,
    ).toBe(false)
    expect(
      combatSourceSchema.safeParse({ ...source, rulesets: [], mechanicsOverrides: {} }).success,
    ).toBe(false)
    expect(
      combatSourceSchema.safeParse({
        ...source,
        rulesets: Array.from({ length: 17 }, (_, index) => ({
          library: 'ocean',
          id: `layer-${index}`,
        })),
      }).success,
    ).toBe(false)

    const legacy = combatSourceSchema.parse({
      ...source,
      rulesets: undefined,
      ruleset: source.rulesets![0],
    })

    expect(legacy.ruleset).toEqual(source.rulesets![0])
    expect(legacy.rulesets).toBeUndefined()
    expect(combatRulesetReferences(legacy)).toEqual([legacy.ruleset])
  })

  it('composes bound mechanics across libraries, imports dependencies from their owner and keeps objective victory in either order', () => {
    const { source, libraries } = fixture()
    const before = JSON.stringify({ source, libraries: [...libraries] })
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    expect(result.definition?.mechanics).toMatchObject({
      victory: 'triggers',
      initialPhase: 'first',
      resources: { exhaustion: { actor: 'diver' }, seal: {} },
      triggers: { pressure: { actor: 'diver' } },
      phases: { first: { enemyRotations: { guardian: ['pulse'] }, onEnter: [{ actor: 'diver' }] } },
    })
    expect(result.origins.statuses.tired?.library).toBe('ocean')
    expect(result.origins.statuses.focus?.library).toBe('bosses')
    expect(result.origins.moves.rest).toMatchObject({ library: 'ocean', ruleset: 'water' })
    expect(result.origins.moves.pulse).toMatchObject({ library: 'bosses', ruleset: 'seals' })
    expect(result.origins.mechanics?.resources.exhaustion).toMatchObject({
      library: 'ocean',
      ruleset: 'water',
    })
    expect(result.origins.mechanics?.resources.seal).toMatchObject({
      library: 'bosses',
      ruleset: 'seals',
    })

    const reversed = resolveCombatSource(
      { ...source, rulesets: [...source.rulesets!].reverse() },
      libraries,
    )

    expect(reversed.issues).toEqual([])
    expect(reversed.definition?.mechanics?.victory).toBe('triggers')
    expect(JSON.stringify({ source, libraries: [...libraries] })).toBe(before)
    expect(Object.isFrozen(result.definition?.mechanics)).toBe(true)
    expect(Object.hasOwn(result.definition!, 'rulesets')).toBe(false)
  })

  it('diagnoses collisions and explicitly replaces whole entries at the later execution position', () => {
    const { source, water, boss, libraries } = fixture()
    boss.rulesets!.seals!.mechanics.triggers.pressure = {
      event: 'turn-start',
      actor: 'hero',
      once: false,
      conditions: [],
      effects: [{ type: 'set-resource', resource: 'seal', amount: 50 }],
    }
    water.rulesets!.water!.mechanics.resources.seal = {
      label: 'Water seal',
      description: '',
      initial: 0,
      maximum: 100,
    }
    const conflict = resolveCombatRuleset(source, libraries)
    expect(conflict.mechanics).toBeUndefined()
    expect(
      conflict.issues
        .filter((issue) => issue.message.includes('Ruleset conflict'))
        .map((issue) => issue.path),
    ).toEqual([
      ['rulesets', 1],
      ['rulesets', 1],
    ])
    source.rulesets![1]!.collision = 'replace'
    const replaced = resolveCombatSource(source, libraries)
    expect(replaced.issues).toEqual([])
    expect(replaced.definition?.mechanics?.resources.seal?.label).toBe('')
    expect(Object.keys(replaced.definition!.mechanics!.triggers)).toEqual([
      'fatigue',
      'filled',
      'pressure',
    ])
    expect(replaced.definition?.mechanics?.triggers.pressure?.effects).toEqual([
      { type: 'set-resource', resource: 'seal', amount: 50 },
    ])
    expect(resolveCombatRuleset(source, libraries).conflicts.every((entry) => entry.replaced)).toBe(
      true,
    )

    const sim = new CombatSimulation(replaced.definition!, {
      health: { diver: 80, guardian: 500 },
      maximumHealth: { diver: 80, guardian: 500 },
    })

    sim.resolve()
    expect(sim.snapshot().mechanics?.resources).toEqual({ exhaustion: 0, seal: 50 })
  })

  it('requires an explicit choice when phase starting settings conflict, then applies encounter settings last', () => {
    const { source, water, libraries } = fixture()
    water.rulesets!.water!.mechanics.phases.calm = { label: 'Calm', description: '', onEnter: [] }
    water.rulesets!.water!.mechanics.initialPhase = 'calm'
    expect(resolveCombatRuleset(source, libraries).conflicts).toContainEqual({
      section: 'settings',
      id: 'initialPhase',
      previous: 'ocean/water',
      next: 'bosses/seals',
      replaced: false,
    })
    source.rulesets![1]!.collision = 'replace'
    source.mechanicsOverrides = { initialPhase: 'calm', victory: 'enemies-defeated' }
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    expect(result.definition?.mechanics).toMatchObject({
      initialPhase: 'calm',
      victory: 'enemies-defeated',
    })
  })

  it('applies sparse encounter overrides after composition and follows later library changes', () => {
    const { source, water, boss, libraries } = fixture()
    source.mechanicsOverrides = {
      resources: { exhaustion: { maximum: 120 } },
      triggers: {
        pressure: { effects: [{ type: 'change-resource', resource: 'exhaustion', amount: 5 }] },
      },
      phases: { first: { onEnter: [] } },
      triggerOrder: ['filled', 'pressure'],
    }
    const first = resolveCombatSource(source, libraries)
    expect(first.issues).toEqual([])
    expect(first.definition?.statuses?.focus).toBeUndefined()
    expect(first.origins.mechanics?.triggers.pressure).toMatchObject({
      file: 'combat/drowned.json',
      path: ['mechanicsOverrides', 'triggers', 'pressure'],
    })
    water.rulesets!.water!.mechanics.resources.exhaustion!.label = 'Updated pressure'
    boss.rulesets!.seals!.mechanics.resources.seal!.maximum = 200
    const next = resolveCombatSource(source, libraries)
    expect(next.issues).toEqual([])
    expect(next.definition?.mechanics?.resources.exhaustion).toMatchObject({
      label: 'Updated pressure',
      maximum: 120,
    })
    expect(next.definition?.mechanics?.resources.seal?.maximum).toBe(200)
    expect(Object.keys(next.definition!.mechanics!.triggers)).toEqual([
      'filled',
      'pressure',
      'fatigue',
    ])
    expect(first.definition?.mechanics?.resources.seal?.maximum).toBe(100)
  })

  it('reports missing libraries and invalid role bindings at their own layer and allows the same actor across layers', () => {
    const { source, libraries } = fixture()
    expect(resolveCombatSource(source, new Map()).issues).toEqual(
      expect.arrayContaining([
        {
          file: 'combat/drowned.json',
          path: ['rulesets', 0],
          message: 'Missing combat ruleset: ocean/water',
        },
        {
          file: 'combat/drowned.json',
          path: ['rulesets', 1],
          message: 'Missing combat ruleset: bosses/seals',
        },
      ]),
    )
    source.rulesets![1]!.actors = { hero: 'diver', boss: 'diver', absent: 'guardian' }
    const invalid = resolveCombatSource(source, libraries)
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['rulesets', 1, 'actors', 'boss'],
          message: 'Ruleset actor roles must bind to distinct actors',
        }),
        expect.objectContaining({
          path: ['rulesets', 1, 'actors', 'absent'],
          message: 'Unknown ruleset actor role: absent',
        }),
      ]),
    )
  })

  it('rejects ambiguous available moves across libraries unless explicitly imported and detects conflicting status providers', () => {
    const { source, water, boss, libraries } = fixture()
    water.moves.guard = cloneCombatRules(boss.moves.guard!)
    expect(
      resolveCombatSource(source, libraries).issues.some((issue) =>
        issue.message.includes('Ambiguous ruleset move guard'),
      ),
    ).toBe(true)
    source.sharedMoves = [{ library: 'bosses', id: 'guard' }]
    expect(resolveCombatSource(source, libraries).issues).toEqual([])
    boss.statuses.tired = {
      type: 'damage',
      label: 'Other tired',
      description: '',
      duration: 1,
      amount: 1,
    }
    boss.rulesets!.seals!.mechanics.phases.first!.onEnter.push({
      type: 'apply-status',
      actor: 'hero',
      status: 'tired',
    })
    expect(
      resolveCombatSource(source, libraries).issues.some((issue) =>
        issue.message.includes('Ruleset status tired conflicts'),
      ),
    ).toBe(true)
    source.statuses = { tired: cloneCombatRules(water.statuses.tired!) }
    expect(resolveCombatSource(source, libraries).issues).toEqual([])
  })

  it('saves composition without flattening, preserves layer extensions through reordering and protects referenced libraries', () => {
    const { source, water, boss } = fixture()
    const original = project(source, water, boss)
    original.documents['combat/drowned.json'] = {
      ...source,
      rulesets: source.rulesets!.map((layer, index) => ({ ...layer, extension: `layer-${index}` })),
    }
    expect(validateProject(original.documents)).toEqual([])
    const view = inspectProject(original)
    expect(() =>
      applyCommand(original, { type: 'game.upsertCombat', encounter: view.combat!.drowned! }),
    ).toThrow('Include rulesets explicitly')
    expect(() =>
      applyCommand(original, { type: 'game.removeCombatLibrary', libraryId: 'ocean' }),
    ).toThrow()
    expect(() =>
      applyCommand(original, { type: 'game.removeCombatLibrary', libraryId: 'bosses' }),
    ).toThrow()
    const edited = cloneCombatRules(view.combatSources!.drowned!)
    edited.rulesets!.reverse()
    edited.mechanicsOverrides = { resources: { exhaustion: { maximum: 120 } } }
    const saved = applyCommand(original, { type: 'game.upsertCombat', encounter: edited })
    const raw = object(saved.project.documents['combat/drowned.json'])
    expect(raw.mechanics).toBeUndefined()
    expect(raw.ruleset).toBeUndefined()
    expect(raw.rulesets).toMatchObject([
      { library: 'bosses', extension: 'layer-1' },
      { library: 'ocean', extension: 'layer-0' },
    ])
    expect(
      inspectProject(saved.project).combat!.drowned!.mechanics!.resources.exhaustion!.maximum,
    ).toBe(120)
    expect(() =>
      applyCommand(saved.project, {
        type: 'game.upsertCombat',
        encounter: { ...edited, mechanicsOverrides: undefined },
      }),
    ).toThrow('Include mechanicsOverrides explicitly')
  })

  it('keeps the resolved result identical when migrating a legacy single reference to one layer', () => {
    const { source, water, boss } = fixture()

    const merged = combatLibrarySchema.parse({
      ...water,
      moves: { ...water.moves, ...boss.moves },
      statuses: { ...water.statuses, ...boss.statuses },
      rulesets: {
        all: {
          actors: ['diver', 'guardian'],
          mechanics: resolveCombatRuleset(
            source,
            new Map([
              ['ocean', water],
              ['bosses', boss],
            ]),
          ).base,
        },
      },
    })

    const libraries = new Map([['ocean', merged]])

    const legacy = combatSourceSchema.parse({
      ...source,
      rulesets: undefined,
      ruleset: { library: 'ocean', id: 'all' },
    })

    const composed = combatSourceSchema.parse({
      ...legacy,
      ruleset: null,
      rulesets: [legacy.ruleset],
    })

    expect(resolveCombatSource(legacy, libraries).issues).toEqual([])
    expect(resolveCombatSource(composed, libraries).definition).toEqual(
      resolveCombatSource(legacy, libraries).definition,
    )
  })
})

describe('underwater boss composition example', () => {
  it('validates the playable project and replays all composed boss scenarios against current libraries', async () => {
    const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

    const paths = (await readdir(root, { recursive: true }))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replaceAll('\\', '/'))

    const documents = Object.fromEntries(
      await Promise.all(
        paths.map(async (file) => [file, JSON.parse(await readFile(new URL(file, root), 'utf8'))]),
      ),
    )

    expect(validateProject(documents)).toEqual([])
    const view = inspectProject({ revision: 'sample', documents })
    const definition = view.combat!['underwater-boss']!
    const source = view.combatSources!['underwater-boss']!
    expect(source.rulesets?.map((reference) => reference.id)).toEqual(['underwater', 'three-seals'])
    expect(definition.mechanics!.resources).toMatchObject({
      exhaustion: {},
      stamina: { initial: 60 },
      seal: {},
      breaks: {},
    })
    expect(definition.mechanics!.victory).toBe('triggers')
    expect(view.combatOrigins!['underwater-boss']!.moves.pulse).toMatchObject({
      library: 'environments',
      ruleset: 'three-seals',
    })

    const setup = combatSimulationSetup(
      definition,
      (binding) =>
        view.rules!.state.find(
          (field) => JSON.stringify(field.path) === JSON.stringify(binding.path),
        )?.value,
    )

    for (const scenario of Object.values(source.simulationScenarios!)) {
      const run = runCombatScenario(definition, setup, scenario)
      expect(run.error).toBeUndefined()
      expect(run.status).toBe('passed')
      expect(runCombatScenario(definition, setup, scenario, 2).simulation?.snapshot()).toEqual(
        run.simulation?.snapshot(),
      )
    }
  })
})
