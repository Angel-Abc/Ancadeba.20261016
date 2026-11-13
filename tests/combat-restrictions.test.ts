import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  savedCombatSchema,
  combatSimulationScenarioSchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  resolveCombatRound,
  CombatSimulation,
  combatRestrictionProfile,
  combatMoveRestriction,
  combatStatusImmune,
  planEnemies,
  runCombatScenario,
  type CombatDebugFrame,
} from '@ancadeba/game-runtime'
import { abilityCanMatter } from '../packages/game-runtime/src/itemUseEligibility.js'
import { mergeCombatEntries } from '../packages/editor-core/src/combatEntryEditing.js'
import { applyCommand, inspectProject, validateProject } from '@ancadeba/editor-core'

function fixture(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'restrictions',
    label: 'Restrictions',
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 4,
      moves: ['spell', 'weapon', 'mixed', 'hex', 'self-silence', 'cleanse', 'ward', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 2,
        moves: ['spell', 'weapon', 'guard'],
        rotation: ['spell', 'weapon'],
        ai: {
          rules: [
            { id: 'magic', move: 'spell' },
            { id: 'melee', move: 'weapon' },
          ],
        },
      },
    ],
    moves: {
      spell: {
        type: 'attack',
        label: 'Spell',
        categories: ['spell'],
        apCost: 1,
        cooldown: 2,
        resourceCosts: { mana: 5 },
        damage: { min: 10, max: 10 },
      },
      weapon: {
        type: 'attack',
        label: 'Weapon',
        categories: ['weapon'],
        apCost: 1,
        damage: { min: 10, max: 10 },
      },
      mixed: {
        type: 'attack',
        label: 'Magic blade',
        categories: ['spell', 'weapon'],
        apCost: 1,
        damage: { min: 10, max: 10 },
      },
      hex: {
        type: 'ability',
        label: 'Hex',
        categories: ['spell'],
        apCost: 1,
        cooldown: 1,
        target: 'enemy',
        effects: [{ id: 'hex', type: 'apply-status', status: 'silenced' }],
      },
      'self-silence': {
        type: 'ability',
        label: 'Self silence',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'silence', type: 'apply-status', status: 'silenced' }],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        categories: ['utility'],
        apCost: 1,
        target: 'self',
        effects: [{ id: 'clear', type: 'remove-status', status: 'silenced' }],
      },
      ward: {
        type: 'ability',
        label: 'Ward',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'ward', type: 'apply-status', status: 'ward' }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 5 },
    },
    statuses: {
      silenced: {
        type: 'composite',
        label: 'Silence',
        duration: 3,
        blockedMoveCategories: ['spell'],
        stacking: { maximum: 3 },
      },
      disarmed: {
        type: 'composite',
        label: 'Disarm',
        duration: 2,
        blockedMoveCategories: ['weapon'],
      },
      ward: {
        type: 'composite',
        label: 'Ward',
        duration: 2,
        statusImmunities: ['silenced', 'disarmed'],
        stacking: { maximum: 3 },
        intensity: { initial: 1, maximum: 3 },
      },
      venom: { type: 'damage', label: 'Venom', duration: 2, amount: 3, damageType: 'poison' },
    },
    mechanics: {
      resources: { mana: { initial: 20, maximum: 20 }, applications: { initial: 0, maximum: 20 } },
      triggers: {
        applied: {
          event: 'status-applied',
          actor: 'enemy',
          effects: [{ type: 'change-resource', resource: 'applications', amount: 1 }],
        },
      },
    },
  })
}

const active = (id: string, remaining = 2) => ({ id, source: 'player', remaining })

function resolve(
  definition: CombatDefinition,
  moves: string[],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
  enemyAI = false,
) {
  const frames: CombatDebugFrame[] = []

  const result = resolveCombatRound(
    {
      ...definition,
      enemies: definition.enemies.map((actor) => ({
        ...actor,
        ai: enemyAI ? actor.ai : undefined,
      })),
    },
    {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      guard: {},
      seed: 1024,
      escape: false,
      plan: moves.map((move) => ({
        move,
        target:
          definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self'
            ? 'player'
            : 'enemy',
      })),
      enemies: { enemy: { moves: [], cursor: 0 } },
      ...options,
    },
    (frame) => {
      frames.push(frame)
    },
  )

  return { result, frames }
}

describe('status immunities and move category restrictions', () => {
  it('validates bounded, unique identifiers and rejects missing immunity references', () => {
    for (const categories of [
      ['spell', 'spell'],
      ['__proto__'],
      [''],
      Array.from({ length: 21 }, (_, i) => `type-${i}`),
    ]) {
      const definition = fixture()
      definition.moves.spell!.categories = categories
      expect(combatDefinitionSchema.safeParse(definition).success).toBe(false)
    }

    const definition = fixture()
    definition.player.statusImmunities = ['missing']
    expect(() => combatDefinitionSchema.parse(definition)).toThrow('Unknown immune status')
    expect(
      combatDefinitionSchema.parse({
        ...fixture(),
        player: { ...fixture().player, blockedMoveCategories: ['custom'] },
      }).player.blockedMoveCategories,
    ).toEqual(['custom'])
  })

  it('blocks new application and application hooks while the accepted ability still spends AP/cooldown', () => {
    const definition = fixture()
    definition.enemies[0]!.statusImmunities = ['silenced']
    const { result, frames } = resolve(definition, ['hex'])
    expect(result.statuses.enemy ?? []).toHaveLength(0)
    expect(result.entries).toContainEqual({
      type: 'statusImmune',
      actor: 'player',
      target: 'enemy',
      status: 'silenced',
    })
    expect(result.mechanics?.resources.applications).toBe(0)
    expect(result.cooldowns.player?.hex).toBe(3)
    expect(frames.find((frame) => frame.kind === 'action')?.spentAp).toBe(1)
    expect(frames.some((frame) => frame.mechanicsEvent?.event === 'status-applied')).toBe(false)
  })

  it('prevents immune refresh/stack gains without cleansing an existing status', () => {
    const definition = fixture()
    definition.enemies[0]!.statusImmunities = ['silenced']

    const { result } = resolve(definition, ['hex'], {
      statuses: { enemy: [{ ...active('silenced', 2), stacks: 2 }] },
    })

    expect(result.statuses.enemy).toEqual([{ ...active('silenced', 1), stacks: 2 }])
    expect(result.entries.some((entry) => entry.type === 'statusRefreshed')).toBe(false)
  })

  it('keeps damage immunity separate from status immunity and applies independent ability effects', () => {
    const definition = fixture()
    definition.enemies[0]!.damageDefenses = { immunities: ['poison'] }
    const hex = definition.moves.hex!

    if (hex.type !== 'ability') throw new Error('Expected ability')
    hex.effects = [
      { id: 'poison', type: 'apply-status', status: 'venom' },
      { id: 'hurt', type: 'damage', damage: { min: 4, max: 4 } },
    ]
    expect(resolve(definition, ['hex']).result.statuses.enemy).toEqual([active('venom', 1)])
    definition.enemies[0]!.statusImmunities = ['venom']
    const { result } = resolve(definition, ['hex'])
    expect(result.statuses.enemy ?? []).toEqual([])
    expect(result.health.enemy).toBe(86)
  })

  it('unions permanent and temporary immunity/restrictions without scaling their categorical strength', () => {
    const definition = fixture()
    definition.player.statusImmunities = ['venom']
    definition.player.blockedMoveCategories = ['technique']

    const statuses = {
      player: [
        { ...active('ward'), stacks: 3, intensity: 3 },
        active('silenced'),
        active('disarmed'),
      ],
    }

    expect(combatRestrictionProfile(definition, 'player', statuses)).toEqual({
      statusImmunities: ['venom', 'silenced', 'disarmed'],
      blockedMoveCategories: ['technique', 'spell', 'weapon'],
    })
    expect(combatMoveRestriction(definition, 'player', definition.moves.mixed!, statuses)).toEqual({
      category: 'spell',
      status: 'silenced',
    })
    expect(
      Object.isFrozen(combatRestrictionProfile(definition, 'player', statuses).statusImmunities),
    ).toBe(true)
    expect(combatStatusImmune(definition, 'player', 'silenced', statuses)).toBe(true)
    expect(combatStatusImmune(definition, 'player', 'silenced')).toBe(false)
  })

  it('expires a temporary ward and allows subsequent application', () => {
    const definition = fixture()

    const simulation = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: { enemy: [active('ward', 1)] },
    })

    simulation.queue('hex', 'enemy')
    simulation.resolve()
    expect(
      combatStatusImmune(definition, 'enemy', 'silenced', simulation.snapshot().statuses),
    ).toBe(false)
    simulation.resolve()
    simulation.queue('hex', 'enemy')
    simulation.resolve()
    expect(simulation.snapshot().statuses.enemy?.some((entry) => entry.id === 'silenced')).toBe(
      true,
    )
  })

  it('blocks player planning for matching categories while leaving recovery and uncategorized moves available', () => {
    const definition = fixture()

    const simulation = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: { player: [active('silenced'), active('disarmed')] },
    })

    expect(simulation.queueIssue('spell', 'enemy')).toContain('blocked (spell)')
    expect(simulation.queueIssue('weapon', 'enemy')).toContain('blocked (weapon)')
    expect(simulation.queueIssue('mixed', 'enemy')).toContain('blocked')
    expect(simulation.queueIssue('cleanse')).toBeUndefined()
    expect(simulation.queueIssue('guard', 'enemy')).toBeUndefined()
  })

  it('skips a newly restricted queued item without spending its costs, cooldown or RNG', () => {
    const definition = fixture()

    const { result, frames } = resolve(definition, [], {
      plan: [
        { move: 'self-silence', target: 'player' },
        { move: 'spell', target: 'enemy', item: 'wand', itemType: 'wand', consume: true },
        { move: 'weapon', target: 'enemy' },
      ],
    })

    expect(result.entries).toContainEqual({
      type: 'moveRestricted',
      actor: 'player',
      move: 'spell',
      category: 'spell',
      status: 'silenced',
    })
    expect(result.usedItems).toEqual([])
    expect(result.cooldowns.player?.spell).toBeUndefined()
    expect(result.mechanics?.resources.mana).toBe(20)
    expect(result.seed).toBe(resolve(definition, ['weapon']).result.seed)
    expect(frames.filter((frame) => frame.kind === 'action').map((frame) => frame.spentAp)).toEqual(
      [1, 1, 2],
    )
  })

  it('rechecks restrictions after before-action hooks and can cleanse before a queued action executes', () => {
    const definition = fixture()
    definition.mechanics!.triggers.bind = {
      event: 'before-action',
      move: 'spell',
      once: false,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'player', status: 'silenced' }],
    }
    expect(resolve(definition, ['spell']).result.seed).toBe(1024)
    definition.mechanics!.triggers.bind!.effects = [
      { type: 'remove-status', actor: 'player', status: 'silenced' },
    ]
    expect(
      resolve(definition, ['spell'], { statuses: { player: [active('silenced')] } }).result.health
        .enemy,
    ).toBe(80)
  })

  it('reports dynamically restricted actions through scenario fail and skip policies', () => {
    const definition = fixture()
    definition.mechanics!.triggers.bind = {
      event: 'before-action',
      actor: 'player',
      move: 'spell',
      once: true,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'player', status: 'silenced' }],
    }

    const scenario = combatSimulationScenarioSchema.parse({
      steps: [{ id: 'bind', plan: [{ move: 'spell', target: 'enemy' }] }],
      expect: [{ type: 'resource', resource: 'mana', operator: 'eq', value: 20 }],
    })

    const setup = { health: { player: 80, enemy: 90 }, maximumHealth: { player: 80, enemy: 90 } }
    expect(runCombatScenario(definition, setup, scenario)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('moveRestricted'),
    })
    scenario.steps[0]!.unavailable = 'skip'
    // The enemy's independent spell still costs mana, so isolate that action from this assertion.
    definition.enemies[0]!.ai = undefined
    definition.enemies[0]!.rotation = ['guard']
    const result = runCombatScenario(definition, setup, scenario)
    expect(result.status).toBe('passed')
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ move: 'spell', reason: 'moveRestricted' }),
    )
  })

  it('explains restricted enemy rules and selects an available fallback', () => {
    const definition = fixture()
    const { result, frames } = resolve(definition, ['hex'], {}, true)
    expect(result.health.player).toBeLessThan(80)
    expect(result.mechanics?.resources.mana).toBe(20)

    const candidate = frames
      .flatMap((frame) => frame.decision?.candidates ?? [])
      .find((entry) => entry.move === 'spell')

    expect(candidate).toMatchObject({
      selected: false,
      blockers: ['restriction'],
      restriction: { category: 'spell', status: 'silenced' },
    })
    expect(
      planEnemies(definition, { player: 80, enemy: 90 }, {}, 1, {
        enemy: [active('silenced'), active('disarmed')],
      }).enemy!.moves.every((entry) => entry.move === 'guard'),
    ).toBe(true)
  })

  it('rechecks old rotation plans at execution and allows cleansing within a plan', () => {
    const definition = fixture()
    definition.enemies[0]!.ai = undefined

    const { result } = resolve(definition, ['hex'], {
      enemies: {
        enemy: {
          cursor: 0,
          moves: [
            { move: 'spell', target: 'player' },
            { move: 'weapon', target: 'player' },
          ],
        },
      },
    })

    expect(result.health.player).toBe(70)
    expect(
      result.entries.some((entry) => entry.type === 'moveRestricted' && entry.actor === 'enemy'),
    ).toBe(true)
    expect(
      resolve(definition, ['cleanse', 'spell'], { statuses: { player: [active('silenced')] } })
        .result.health.enemy,
    ).toBe(80)
  })

  it('does not offer no-effect status items against immunity while allowing mixed effects', () => {
    const definition = fixture()
    definition.enemies[0]!.statusImmunities = ['silenced']

    const snapshot = {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: {},
      guard: {},
      stats: {},
      resources: { mana: 20 },
    }

    expect(abilityCanMatter(definition.moves.hex!, definition, snapshot, 'enemy')).toBe(false)
    const hex = definition.moves.hex!

    if (hex.type !== 'ability') throw new Error('Expected ability')
    hex.effects.push({ id: 'damage', type: 'damage', damage: { min: 2, max: 2 } })
    expect(abilityCanMatter(hex, definition, snapshot, 'enemy')).toBe(true)
  })

  it('imports immunity dependencies transitively with cycles and rejects conflicting definitions', () => {
    const definition = fixture()

    const statuses = {
      ...definition.statuses!,
      ward: { ...definition.statuses!.ward!, statusImmunities: ['silenced'] },
      silenced: { ...definition.statuses!.silenced!, statusImmunities: ['ward'] },
    }

    const library = combatLibrarySchema.parse({ 'schema-version': '1.0.0', id: 'common', statuses })

    const source = combatSourceSchema.parse({
      ...definition,
      statuses: { venom: definition.statuses!.venom, disarmed: definition.statuses!.disarmed },
      moves: {
        ...definition.moves,
        ward: {
          type: 'ability',
          label: 'Ward',
          apCost: 1,
          target: 'self',
          effects: [{ id: 'ward', type: 'apply-status', status: 'ward' }],
        },
      },
      sharedStatuses: [{ library: 'common', id: 'ward' }],
    })

    const resolved = resolveCombatSource(source, new Map([['common', library]]))
    expect(resolved.issues).toEqual([])
    expect(resolved.origins.statuses.silenced?.library).toBe('common')
    expect(resolved.definition?.statuses?.silenced?.blockedMoveCategories).toEqual(['spell'])
    expect(
      combatLibrarySchema.safeParse({ ...library, statuses: { ward: library.statuses.ward } })
        .success,
    ).toBe(false)

    const conflicting = resolveCombatSource(
      { ...source, statuses: { ...source.statuses, silenced: definition.statuses!.silenced! } },
      new Map([['common', library]]),
    )

    expect(conflicting.issues.some((issue) => issue.message.includes('conflicts'))).toBe(true)
  })

  it('clears removed editor fields while preserving extensions and saves new log details', () => {
    const definition = fixture()

    const previous = {
      moves: { spell: { categories: ['spell'], extension: true } },
      statuses: {
        ward: {
          statusImmunities: ['silenced'],
          blockedMoveCategories: ['weapon'],
          extension: 'keep',
        },
      },
    }

    delete definition.moves.spell!.categories
    delete definition.statuses!.ward!.statusImmunities
    const merged = mergeCombatEntries(previous, definition)
    expect(merged.moves.spell).toMatchObject({ categories: undefined, extension: true })
    expect(merged.statuses!.ward).toMatchObject({
      statusImmunities: undefined,
      blockedMoveCategories: undefined,
      extension: 'keep',
    })
    const result = resolve(fixture(), ['self-silence', 'spell']).result

    const save = savedCombatSchema.parse({
      round: 1,
      seed: result.seed,
      started: true,
      guard: {},
      plan: [],
      enemies: {},
      statuses: {},
      cooldowns: {},
      escape: false,
      log: result.entries,
    })

    expect(save.log).toContainEqual(
      expect.objectContaining({ type: 'moveRestricted', category: 'spell', status: 'silenced' }),
    )
  })

  it('retains immunity dependencies when making a shared status local and protects their deletion', () => {
    const definition = fixture()

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'common',
      statuses: definition.statuses,
    })

    const source = combatSourceSchema.parse({
      ...definition,
      statuses: { venom: definition.statuses!.venom },
      sharedStatuses: [{ library: 'common', id: 'ward' }],
    })

    const project = {
      revision: 'one',
      documents: {
        'game.json': {
          'schema-version': '1.0.0',
          id: 'restrictions',
          title: 'Restrictions',
          version: '1',
          scenes: ['start'],
          combat: ['restrictions'],
          combatLibraries: ['common'],
          rules: ['state'],
        },
        'scenes/start.json': {
          'schema-version': '1.0.0',
          id: 'start',
          title: 'Start',
          type: 'game',
          screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
          components: [],
        },
        'rules/state.json': {
          state: [
            { path: ['hp'], value: 80 },
            { path: ['enemy'], value: 90 },
          ],
          actions: {},
        },
        'combat/restrictions.json': source,
        'combat-libraries/common.json': library,
      },
    }

    expect(validateProject(project.documents)).toEqual([])

    const copied = applyCommand(project, {
      type: 'combat.copySharedEntry',
      encounterId: 'restrictions',
      kind: 'statuses',
      reference: { library: 'common', id: 'ward' },
      localId: 'ward-local',
    })

    const draft = inspectProject(copied.project).combatSources!.restrictions!
    draft.sharedStatuses = draft.sharedStatuses!.filter((reference) => reference.id !== 'ward')
    const ward = draft.moves.ward!

    if (ward.type !== 'ability') throw new Error('Expected ability')
    ward.effects = [{ id: 'local', type: 'apply-status', status: 'ward-local' }]
    const saved = applyCommand(copied.project, { type: 'game.upsertCombat', encounter: draft })
    expect(validateProject(saved.project.documents)).toEqual([])
    const view = inspectProject(saved.project)
    expect(view.combat!.restrictions!.statuses?.['ward-local']?.statusImmunities).toEqual([
      'silenced',
      'disarmed',
    ])
    expect(view.combat!.restrictions!.statuses?.ward).toBeUndefined()
    const statuses = { ...library.statuses }
    delete statuses.disarmed
    expect(() =>
      applyCommand(saved.project, {
        type: 'game.upsertCombatLibrary',
        library: { ...library, statuses },
      }),
    ).toThrow()
  })
})
