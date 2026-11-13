import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  combatAIOverridesSchema,
  combatAIProfileSchema,
  resolveCombatSource,
  resolveCombatEnemyAI,
  bindCombatAIProfile,
  applyCombatAIOverrides,
  previewCombatAIOverrides,
  diffCombatAI,
  cloneCombatRules,
  combatLibraryIssues,
  localizeCombatLibrary,
} from '@ancadeba/schemas'
import { planEnemies, initialCombatMechanics, resolveCombatRound } from '@ancadeba/game-runtime'
import {
  mergeCombatAIProfiles,
  mergeCombatAIOverrides,
} from '../packages/editor-core/src/combatAIProfileEditing.js'
import { mergeCombatEnemyAI } from '../packages/editor-core/src/combatEnemyAIEditing.js'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

function fixture() {
  const library = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'behaviors',
    moves: {
      hit: { type: 'attack', label: 'Hit', apCost: 1, damage: { min: 2, max: 2 } },
      crush: { type: 'attack', label: 'Crush', apCost: 2, damage: { min: 5, max: 5 } },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
    },
    statuses: {
      focus: {
        type: 'modifier',
        label: 'Focus',
        duration: 3,
        stacking: { maximum: 3 },
        modifiers: { defense: 1 },
      },
    },
    aiProfiles: {
      hunter: {
        label: 'Hunter',
        actors: ['target'],
        ai: {
          fallback: 'rotation',
          rules: [
            {
              id: 'charged',
              move: 'crush',
              conditions: [{ type: 'resource', resource: 'charge', operator: 'gte', value: 5 }],
            },
            {
              id: 'focused',
              move: 'guard',
              conditions: [
                { type: 'status', actor: 'target', status: 'focus', operator: 'gte', value: 2 },
              ],
            },
            {
              id: 'wounded',
              move: 'guard',
              conditions: [{ type: 'health', actor: 'self', operator: 'lte', value: 10 }],
            },
            { id: 'rage', move: 'hit', conditions: [{ type: 'phase', phase: 'angry' }] },
          ],
        },
      },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'fight',
    label: 'Fight',
    player: {
      id: 'hero',
      label: 'Hero',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 100,
      moves: ['hit'],
    },
    enemies: ['first', 'second'].map((id) => ({
      id,
      label: id,
      health: { source: 'game.state', path: [id] },
      maximumHealth: 50,
      ap: 2,
      moves: ['hit', 'crush', 'guard'],
      rotation: ['hit'],
      aiProfile: { library: 'behaviors', id: 'hunter', actors: { target: 'hero' } },
    })),
    moves: { hit: library.moves.hit },
    mechanics: {
      resources: { charge: { label: 'Charge', initial: 5, maximum: 10 } },
      phases: { calm: { label: 'Calm' }, angry: { label: 'Angry' } },
      initialPhase: 'calm',
    },
  })

  return { library, source, libraries: new Map([['behaviors', library]]) }
}

describe('enemy AI profile resolution', () => {
  it('binds self independently for each enemy and imports effective move/status dependencies', () => {
    const { source, library, libraries } = fixture()
    const original = cloneCombatRules(source)
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    const first = result.definition!.enemies[0]!
    const second = result.definition!.enemies[1]!
    expect(first.ai?.rules[1]?.conditions[0]).toMatchObject({ actor: 'hero', measure: 'stacks' })
    expect(first.ai?.rules[2]?.conditions[0]).toMatchObject({ actor: 'first' })
    expect(second.ai?.rules[2]?.conditions[0]).toMatchObject({ actor: 'second' })
    expect(result.origins.moves.crush?.library).toBe('behaviors')
    expect(result.origins.statuses.focus?.library).toBe('behaviors')
    expect(first).not.toHaveProperty('aiProfile')
    expect(first).not.toHaveProperty('aiOverrides')
    expect(Object.isFrozen(first.ai?.rules[0]?.conditions)).toBe(true)
    expect(source).toEqual(original)
    expect(library.aiProfiles!.hunter!.ai.rules[2]!.conditions[0]).toMatchObject({ actor: 'self' })
  })

  it('inherits library changes while keeping only the fields overridden on one enemy', () => {
    const { source, library, libraries } = fixture()
    source.enemies[1]!.aiOverrides = { rules: { charged: { maxUses: 2 } } }
    const before = resolveCombatSource(source, libraries).definition!
    const changed = cloneCombatRules(library)
    changed.aiProfiles!.hunter!.ai.rules[0]!.maxUses = 3
    changed.aiProfiles!.hunter!.ai.rules[0]!.conditions = [
      { type: 'resource', resource: 'charge', operator: 'gte', value: 8 },
    ]
    const after = resolveCombatSource(source, new Map([['behaviors', changed]])).definition!
    expect(before.enemies[0]!.ai!.rules[0]!.maxUses).toBe(1)
    expect(after.enemies.map((enemy) => enemy.ai!.rules[0]!.maxUses)).toEqual([3, 2])
    expect(after.enemies.map((enemy) => enemy.ai!.rules[0]!.conditions[0])).toEqual([
      changed.aiProfiles!.hunter!.ai.rules[0]!.conditions[0],
      changed.aiProfiles!.hunter!.ai.rules[0]!.conditions[0],
    ])
    expect(source.enemies[1]!.aiOverrides).toEqual({ rules: { charged: { maxUses: 2 } } })
  })

  it('diffs additions, removals, changed fields and priority without materializing inherited rules', () => {
    const { library } = fixture()
    const base = bindCombatAIProfile(library.aiProfiles!.hunter!, 'first', { target: 'hero' })
    const edited = cloneCombatRules(base)
    edited.rules[0]!.maxUses = 2
    edited.rules = [
      edited.rules[1]!,
      { id: 'local', move: 'hit', maxUses: 3, conditions: [] },
      edited.rules[0]!,
      edited.rules[3]!,
    ]
    edited.fallback = 'wait'
    const overrides = diffCombatAI(base, edited)
    expect(overrides).toEqual({
      rules: {
        wounded: null,
        charged: { maxUses: 2 },
        local: { move: 'hit', maxUses: 3, conditions: [] },
      },
      fallback: 'wait',
      ruleOrder: ['focused', 'local', 'charged', 'rage'],
    })
    expect(applyCombatAIOverrides(base, overrides)).toEqual(edited)
    expect(diffCombatAI(base, applyCombatAIOverrides(base, {}))).toEqual({})
    expect(base.rules).toHaveLength(4)
  })

  it('collects dependencies after exclusions and accepts encounter-local move/status replacements', () => {
    const { source, libraries } = fixture()
    source.enemies = [source.enemies[0]!]
    source.enemies[0]!.aiOverrides = {
      rules: { charged: null, focused: null, wounded: null, rage: { move: 'local' } },
      fallback: 'wait',
    }
    source.enemies[0]!.moves.push('local')
    source.enemies[0]!.moves = ['hit', 'local']
    source.moves.local = { type: 'guard', label: 'Local', description: '', apCost: 1, guard: 9 }
    const result = resolveCombatSource(source, libraries)
    expect(result.issues).toEqual([])
    expect(result.definition?.moves).not.toHaveProperty('crush')
    expect(result.definition?.statuses).not.toHaveProperty('focus')
    source.enemies[0]!.aiOverrides = {}
    source.enemies[0]!.moves = ['hit', 'crush', 'guard', 'local']
    source.statuses = {
      focus: { type: 'stun', label: 'Local focus', description: '', duration: 2 },
    }
    source.moves.crush = {
      type: 'guard',
      label: 'Local crush',
      description: '',
      apCost: 2,
      guard: 10,
    }
    const local = resolveCombatSource(source, libraries)
    expect(local.issues).toEqual([])
    expect(local.definition?.moves.crush).toMatchObject({ guard: 10 })
    expect(local.definition?.statuses?.focus?.type).toBe('stun')
  })

  it('rejects ambiguous dependencies imported from different libraries', () => {
    const { source, library, libraries } = fixture()
    libraries.set('other', combatLibrarySchema.parse({ ...library, id: 'other' }))
    source.sharedMoves = [{ library: 'other', id: 'crush' }]
    expect(
      resolveCombatSource(source, libraries).issues.some((issue) =>
        issue.message.includes('conflicts'),
      ),
    ).toBe(true)
    source.sharedMoves = undefined
    source.sharedStatuses = [{ library: 'other', id: 'focus' }]
    expect(
      resolveCombatSource(source, libraries).issues.some((issue) =>
        issue.message.includes('status focus conflicts'),
      ),
    ).toBe(true)
    const changed = cloneCombatRules(library)
    changed.moves.crush = {
      type: 'ability',
      label: 'Apply focus',
      description: '',
      apCost: 2,
      target: 'enemy',
      effects: [{ id: 'focus', type: 'apply-status', status: 'focus' }],
    }
    changed.aiProfiles!.hunter!.ai.rules = changed.aiProfiles!.hunter!.ai.rules.filter(
      (rule) => rule.id !== 'focused',
    )
    libraries.set('behaviors', combatLibrarySchema.parse(changed))
    expect(
      resolveCombatSource(source, libraries).issues.some((issue) =>
        issue.message.includes('status focus conflicts'),
      ),
    ).toBe(true)
  })

  it.each(['profile', 'binding', 'role', 'resource', 'phase', 'move'])(
    'rejects invalid %s references against effective encounter data',
    (kind) => {
      const { source, libraries } = fixture()
      const enemy = source.enemies[0]!

      if (kind === 'profile') enemy.aiProfile!.id = 'missing'

      if (kind === 'binding') enemy.aiProfile!.actors!.target = 'missing'

      if (kind === 'role') enemy.aiProfile!.actors = { self: 'first', target: 'hero' }

      if (kind === 'resource') source.mechanics!.resources = {}

      if (kind === 'phase') {
        source.mechanics!.phases = {}
        source.mechanics!.initialPhase = undefined
      }

      if (kind === 'move') enemy.moves = ['hit']
      expect(resolveCombatSource(source, libraries).definition).toBeUndefined()
      expect(resolveCombatSource(source, libraries).issues.length).toBeGreaterThan(0)
    },
  )

  it('validates unused profiles and sparse overrides', () => {
    const { source, library, libraries } = fixture()
    const profile = library.aiProfiles!.hunter!
    expect(combatAIProfileSchema.safeParse({ ...profile, actors: ['self'] }).success).toBe(false)
    expect(
      combatAIProfileSchema.safeParse({ ...profile, actors: ['target', 'target'] }).success,
    ).toBe(false)

    for (const patch of [
      { move: 'missing' },
      { conditions: [{ type: 'health', actor: 'missing', operator: 'gte', value: 1 }] },
      {
        conditions: [
          { type: 'status', actor: 'target', status: 'missing', operator: 'gte', value: 1 },
        ],
      },
    ]) {
      expect(
        combatLibrarySchema.safeParse({
          ...library,
          aiProfiles: {
            unused: { ...profile, ai: { rules: [{ id: 'bad', move: 'hit', ...patch }] } },
          },
        }).success,
      ).toBe(false)
    }

    expect(combatAIOverridesSchema.safeParse({ ruleOrder: ['one', 'one'] }).success).toBe(false)
    const base = profile.ai
    expect(() => applyCombatAIOverrides(base, { ruleOrder: ['missing'] })).toThrow('Unknown rule')
    expect(() => applyCombatAIOverrides(base, { rules: { added: {} } })).toThrow()
    expect(previewCombatAIOverrides(base, { rules: { added: {} } }).rules.at(-1)?.move).toBe('')
    source.enemies[0]!.aiOverrides = { rules: { added: {} } }
    expect(
      resolveCombatEnemyAI(source.enemies[0]!, [source.player, ...source.enemies], libraries)
        .issues[0]?.path,
    ).toEqual(['aiOverrides'])
    expect(
      combatSourceSchema.safeParse({
        ...source,
        player: { ...source.player, aiProfile: source.enemies[0]!.aiProfile },
      }).success,
    ).toBe(false)
    expect(
      combatSourceSchema.safeParse({ ...source, enemies: [{ ...source.enemies[0], ai: base }] })
        .success,
    ).toBe(false)
    expect(
      combatSourceSchema.safeParse({
        ...source,
        enemies: [{ ...source.enemies[0], aiProfile: null }],
      }).success,
    ).toBe(false)
  })

  it('localizes and freezes profile metadata, with diagnostics for missing translations', () => {
    const { library } = fixture()
    library.aiProfiles!.hunter!.labelKey = 'hunter'
    library.aiProfiles!.hunter!.descriptionKey = 'description'
    expect(combatLibraryIssues(library)).toHaveLength(2)

    const translation = {
      fallback: { hunter: 'Hunter', description: 'Behavior' },
      messages: { hunter: 'Jager', description: 'Gedrag' },
    }

    expect(combatLibraryIssues(library, undefined, translation)).toEqual([])
    const localized = localizeCombatLibrary(library, translation)
    expect(localized.aiProfiles!.hunter).toMatchObject({ label: 'Jager', description: 'Gedrag' })
    expect(Object.isFrozen(localized.aiProfiles!.hunter!.ai.rules)).toBe(true)
    expect(library.aiProfiles!.hunter!.label).toBe('Hunter')
  })
})

describe('enemy AI profile authoring persistence', () => {
  it('round-trips linked sources and overrides, guards flattening and deletion, and supports explicit detachment', () => {
    const { library, source } = fixture()
    source.enemies[0]!.aiOverrides = { rules: { charged: { maxUses: 2 } } }

    const project = {
      revision: 'one',
      documents: {
        'game.json': {
          'schema-version': '1.0.0',
          id: 'profiles',
          title: 'Profiles',
          version: '1',
          scenes: ['fight'],
          combat: ['fight'],
          combatLibraries: ['behaviors'],
          rules: ['health'],
        },
        'scenes/fight.json': {
          'schema-version': '1.0.0',
          id: 'fight',
          title: 'Fight',
          type: 'game',
          screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
          components: [],
        },
        'rules/health.json': {
          state: [
            { path: ['hp'], value: 100 },
            { path: ['first'], value: 50 },
            { path: ['second'], value: 50 },
          ],
          actions: {},
        },
        'combat/fight.json': source,
        'combat-libraries/behaviors.json': library,
      },
    }

    expect(validateProject(project.documents)).toEqual([])
    const view = inspectProject(project)

    const saved = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: view.combatSources!.fight!,
    })

    const stored = object(saved.project.documents['combat/fight.json'])
    const storedEnemies = Array.isArray(stored.enemies) ? stored.enemies : []
    expect(object(storedEnemies[0]).ai).toBeUndefined()
    expect(object(storedEnemies[0]).aiOverrides).toEqual({
      rules: { charged: { maxUses: 2 } },
    })
    expect(() =>
      applyCommand(project, { type: 'game.upsertCombat', encounter: view.combat!.fight! }),
    ).toThrow('Include aiProfile explicitly')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombat',
        encounter: {
          ...source,
          enemies: [{ ...source.enemies[0]!, aiOverrides: undefined }, source.enemies[1]!],
        },
      }),
    ).toThrow('Include aiOverrides explicitly')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, aiProfiles: undefined },
      }),
    ).toThrow('Include aiProfiles explicitly')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, aiProfiles: {} },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(project, { type: 'game.removeCombatLibrary', libraryId: 'behaviors' }),
    ).toThrow()

    const reset = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: {
        ...source,
        enemies: [{ ...source.enemies[0]!, aiOverrides: {} }, source.enemies[1]!],
      },
    })

    expect(inspectProject(reset.project).combat!.fight!.enemies[0]!.ai!.rules[0]!.maxUses).toBe(1)

    const detached = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: {
        ...source,
        enemies: view.combat!.fight!.enemies.map((enemy) => ({ ...enemy, aiProfile: null })),
        sharedMoves: [
          { library: 'behaviors', id: 'crush' },
          { library: 'behaviors', id: 'guard' },
        ],
        sharedStatuses: [{ library: 'behaviors', id: 'focus' }],
      },
    })

    expect(
      inspectProject(detached.project).combatSources!.fight!.enemies[0]!.aiProfile,
    ).toBeUndefined()
    expect(inspectProject(detached.project).combat!.fight!.enemies[0]!.ai!.rules[0]!.maxUses).toBe(
      2,
    )
  })

  it('preserves extensions and clears removed profile fields and union fields', () => {
    const { library } = fixture()
    const profile = library.aiProfiles!.hunter!

    const raw = {
      ...profile,
      extension: 1,
      ai: {
        ...profile.ai,
        extension: 2,
        rules: profile.ai.rules.map((rule) => ({
          ...rule,
          extension: rule.id,
          conditions: rule.conditions.map((condition) => ({ ...condition, extension: 3 })),
        })),
      },
    }

    const changed = cloneCombatRules(profile)
    changed.ai.rules[2]!.conditions = [{ type: 'phase', phase: 'calm' }]
    const result = mergeCombatAIProfiles({ hunter: raw }, { hunter: changed })!.hunter!
    expect(result).toMatchObject({ extension: 1, ai: { extension: 2 } })
    expect(object(result.ai).rules).toHaveLength(4)
    const rules = object(result.ai).rules
    expect(object(Array.isArray(rules) ? rules[0] : undefined)).toMatchObject({
      extension: 'charged',
      conditions: [{ extension: 3 }],
    })
    expect(JSON.parse(JSON.stringify(result)).ai.rules[2].conditions[0]).toEqual({
      type: 'phase',
      phase: 'calm',
      extension: 3,
    })

    const old = {
      extension: 1,
      fallback: 'wait',
      ruleOrder: ['charged'],
      rules: {
        charged: {
          extension: 2,
          move: 'hit',
          maxUses: 3,
          conditions: [
            { type: 'resource', resource: 'charge', operator: 'gte', value: 5, extension: 3 },
          ],
        },
      },
    }

    expect(
      JSON.parse(
        JSON.stringify(
          mergeCombatAIOverrides(old, {
            rules: { charged: { conditions: [{ type: 'phase', phase: 'angry' }] } },
          }),
        ),
      ),
    ).toEqual({
      extension: 1,
      rules: {
        charged: { extension: 2, conditions: [{ type: 'phase', phase: 'angry', extension: 3 }] },
      },
    })
    expect(mergeCombatEnemyAI({}, undefined)).toBeUndefined()
    expect(mergeCombatAIProfiles({ hunter: raw }, {})).toEqual({})
  })
})

describe('shared AI runtime behavior', () => {
  it('shares the sample eel profile while applying the Deep water threshold override only there', async () => {
    const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

    const read = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, root), 'utf8'))

    const library = combatLibrarySchema.parse(await read('combat-libraries/environments.json'))

    for (const id of ['shared-water', 'rough-water']) {
      const source = combatSourceSchema.parse(await read(`combat/${id}.json`))
      expect(source.enemies[0]!.ai).toBeUndefined()
      const result = resolveCombatSource(source, new Map([['environments', library]]))
      expect(result.issues).toEqual([])
      const encounter = result.definition!
      const enemy = encounter.enemies[0]!.id
      const mechanics = initialCombatMechanics(encounter)!
      mechanics.resources.exhaustion = 50

      const plan = planEnemies(
        encounter,
        { [encounter.player.id]: 80, [enemy]: 90 },
        {},
        1,
        {},
        {},
        mechanics,
      )

      expect(plan[enemy]!.moves.map((move) => move.move)).toEqual(
        id === 'rough-water' ? ['ambush'] : ['guard', 'bite'],
      )
      expect(encounter.enemies[0]!.ai!.rules[2]!.conditions[0]).toMatchObject({ actor: enemy })
    }
  })

  it('runs independent decisions from a shared profile with a local threshold override', () => {
    const { source, libraries } = fixture()
    source.enemies[1]!.aiOverrides = {
      rules: {
        charged: {
          conditions: [{ type: 'resource', resource: 'charge', operator: 'gte', value: 8 }],
        },
      },
    }
    const encounter = resolveCombatSource(source, libraries).definition!
    const health = { hero: 100, first: 50, second: 50 }
    const enemies = planEnemies(encounter, health, {})
    expect(enemies.first!.moves.map((move) => move.move)).toEqual(['crush'])
    expect(enemies.second!.moves.map((move) => move.move)).toEqual(['hit', 'hit'])

    const result = resolveCombatRound(encounter, {
      health,
      guard: {},
      seed: 1024,
      escape: false,
      plan: [],
      enemies,
      mechanics: initialCombatMechanics(encounter),
    })

    expect(result.health.hero).toBe(91)
    expect(result).toEqual(
      resolveCombatRound(encounter, {
        health,
        guard: {},
        seed: 1024,
        escape: false,
        plan: [],
        enemies,
      }),
    )

    const next = planEnemies(
      encounter,
      { ...result.health, first: 5 },
      result.cursors,
      2,
      result.statuses,
      result.cooldowns,
      { ...result.mechanics!, resources: { charge: 0 } },
    )

    expect(next.first!.moves.map((move) => move.move)).toEqual(['guard', 'hit'])
    expect(next.second!.moves.map((move) => move.move)).toEqual(['hit', 'hit'])
  })
})
