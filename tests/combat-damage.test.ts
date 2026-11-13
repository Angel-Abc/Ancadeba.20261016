import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatDamageDefensesSchema,
  combatDamageTypeSchema,
  combatStatusSchema,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  combatDamageProfile,
  combatTypedDamage,
  resolveCombatRound,
  combatMoveValues,
  combatAbilityEffectValues,
  combatValueContext,
  CombatSimulation,
  statusContributions,
  type CombatDebugFrame,
  type CombatStatuses,
} from '@ancadeba/game-runtime'
import { abilityCanMatter } from '../packages/game-runtime/src/itemUseEligibility.js'
import { mergeCombatEntries } from '../packages/editor-core/src/combatEntryEditing.js'
import { mergeCombatDamageDefenses } from '../packages/editor-core/src/combatDamageEditing.js'

function fixture(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'types',
    label: 'Types',
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 5,
      moves: ['fire', 'lightning', 'poison', 'physical', 'shatter', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        moves: ['physical', 'guard'],
        rotation: ['guard'],
        damageDefenses: {
          resistances: { fire: 50 },
          vulnerabilities: { lightning: 50 },
          immunities: ['poison'],
        },
      },
    ],
    moves: {
      fire: {
        type: 'attack',
        label: 'Fire',
        apCost: 1,
        damage: { min: 10, max: 10 },
        damageType: 'fire',
      },
      lightning: {
        type: 'ability',
        label: 'Lightning',
        target: 'enemy',
        apCost: 1,
        effects: [
          { id: 'damage', type: 'damage', damage: { min: 10, max: 10 }, damageType: 'lightning' },
        ],
      },
      poison: {
        type: 'ability',
        label: 'Poison',
        target: 'enemy',
        apCost: 1,
        effects: [
          { id: 'damage', type: 'damage', damage: { min: 10, max: 10 }, damageType: 'poison' },
        ],
      },
      physical: { type: 'attack', label: 'Physical', apCost: 1, damage: { min: 10, max: 10 } },
      shatter: {
        type: 'ability',
        label: 'Shatter',
        target: 'enemy',
        apCost: 1,
        effects: [
          { id: 'remove', type: 'remove-status', status: 'ward' },
          { id: 'damage', type: 'damage', damage: { min: 10, max: 10 }, damageType: 'fire' },
        ],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 5 },
    },
    statuses: {
      ward: {
        type: 'composite',
        label: 'Ward',
        duration: 2,
        damageDefenses: { resistances: { lightning: 25 }, immunities: ['fire'] },
        stacking: { maximum: 3 },
        intensity: { initial: 1, maximum: 3 },
      },
      venom: {
        type: 'damage',
        label: 'Venom',
        duration: 2,
        amount: 3,
        damageType: 'poison',
        stacking: { maximum: 3 },
        intensity: { initial: 1, maximum: 3 },
      },
    },
    mechanics: {
      resources: { hits: { initial: 0, maximum: 100 } },
      triggers: {
        received: {
          event: 'damage-received',
          actor: 'enemy',
          effects: [{ type: 'change-resource', resource: 'hits', amount: 1 }],
        },
      },
    },
  })
}

function resolve(
  definition: CombatDefinition,
  moves: string[],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
  frames?: CombatDebugFrame[],
) {
  return resolveCombatRound(
    definition,
    {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      seed: 1024,
      guard: {},
      escape: false,
      plan: moves.map((move) => ({ move, target: 'enemy' })),
      enemies: { enemy: { moves: [], cursor: 0 } },
      ...options,
    },
    frames
      ? (frame) => {
          frames.push(frame)
        }
      : undefined,
  )
}

describe('damage types and defenses', () => {
  it('validates custom IDs, percentage precision/bounds and unique bounded immunity lists', () => {
    for (const type of ['', '__proto__', 'constructor', 'prototype'])
      expect(combatDamageTypeSchema.safeParse(type).success).toBe(false)
    expect(combatDamageTypeSchema.parse('void')).toBe('void')
    expect(
      combatDamageDefensesSchema.parse({
        resistances: { water: 12.5 },
        vulnerabilities: { lightning: 50 },
        immunities: ['poison'],
      }),
    ).toEqual({
      resistances: { water: 12.5 },
      vulnerabilities: { lightning: 50 },
      immunities: ['poison'],
    })

    for (const percent of [-1, 100.01, 0.001, NaN, Infinity])
      expect(
        combatDamageDefensesSchema.safeParse({ resistances: { water: percent } }).success,
      ).toBe(false)
    expect(
      combatDamageDefensesSchema.safeParse({ vulnerabilities: { lightning: 1000.01 } }).success,
    ).toBe(false)
    expect(combatDamageDefensesSchema.safeParse({ immunities: ['poison', 'poison'] }).success).toBe(
      false,
    )
    expect(
      combatDamageDefensesSchema.safeParse({
        immunities: Array.from({ length: 101 }, (_, index) => `type-${index}`),
      }).success,
    ).toBe(false)
    expect(
      combatStatusSchema.safeParse({
        type: 'composite',
        label: 'Bad',
        duration: 2,
        damageDefenses: {},
        damageType: 'fire',
      }).success,
    ).toBe(false)
    expect(
      combatStatusSchema.safeParse({
        type: 'composite',
        label: 'Ward',
        duration: 2,
        damageDefenses: { immunities: ['fire'] },
      }).success,
    ).toBe(true)
  })

  it('combines resistance/vulnerability additively, floors damage and lets immunity override everything', () => {
    const profile = {
      resistances: { fire: 50, lightning: 25 },
      vulnerabilities: { lightning: 50 },
      immunities: ['poison'],
    }

    expect(combatTypedDamage(10, 'fire', profile)).toMatchObject({
      amount: 5,
      resisted: 5,
      amplified: 0,
      resistance: 50,
      immune: false,
    })
    expect(combatTypedDamage(10, 'lightning', profile)).toMatchObject({
      amount: 12,
      amplified: 2,
      resistance: 25,
      vulnerability: 50,
    })
    expect(combatTypedDamage(1, 'fire', profile).amount).toBe(0)
    expect(combatTypedDamage(10, 'void', profile).amount).toBe(10)
    expect(
      combatTypedDamage(10, undefined, { ...profile, resistances: { physical: 100 } }).amount,
    ).toBe(0)
    expect(
      combatTypedDamage(Number.MAX_SAFE_INTEGER, 'poison', {
        ...profile,
        vulnerabilities: { poison: 1000 },
      }),
    ).toMatchObject({ amount: 0, immune: true })
    expect(() => combatTypedDamage(Number.MAX_SAFE_INTEGER, 'lightning', profile)).toThrow(
      'overflow',
    )
  })

  it('does not treat inherited object properties as damage responses', () => {
    expect(
      combatTypedDamage(10, 'toString', { resistances: {}, vulnerabilities: {}, immunities: [] })
        .amount,
    ).toBe(10)
    const definition = fixture()
    definition.player.damageDefenses = { resistances: { toString: 50 } }
    expect(
      combatTypedDamage(10, 'toString', combatDamageProfile(definition, 'player')).amount,
    ).toBe(5)
    expect(
      combatTypedDamage(10, 'hasOwnProperty', combatDamageProfile(definition, 'player')).amount,
    ).toBe(10)
  })

  it('scales status percentages by stacks and intensity while immunity remains active once', () => {
    const definition = fixture()

    const statuses: CombatStatuses = {
      enemy: [{ id: 'ward', source: 'enemy', remaining: 2, stacks: 2, intensity: 2 }],
    }

    const profile = combatDamageProfile(definition, 'enemy', statuses)
    expect(profile.resistances.lightning).toBe(100)
    expect(profile.vulnerabilities.lightning).toBe(50)
    expect(profile.immunities).toEqual(['poison', 'fire'])
    expect(combatTypedDamage(10, 'lightning', profile).amount).toBe(5)
    expect(Object.isFrozen(profile.resistances)).toBe(true)
    expect(definition.enemies[0]!.damageDefenses?.resistances).toEqual({ fire: 50 })
    expect(combatTypedDamage(10, 'fire', combatDamageProfile(definition, 'enemy')).amount).toBe(5)
  })

  it('applies flat defense before type adjustment and Guard afterward, with inspectable mitigation', () => {
    const definition = fixture()

    const result = resolve(definition, ['fire'], {
      stats: {
        player: { attack: 2, defense: 0, guard: 0, maximumHealth: 80 },
        enemy: { attack: 0, defense: 3, guard: 0, maximumHealth: 90 },
      },
      guard: { enemy: 1 },
    })

    expect(result.health.enemy).toBe(87)
    expect(result.entries.find((entry) => entry.type === 'attack')).toMatchObject({
      rawDamage: 12,
      defended: 3,
      damageType: 'fire',
      typeDamage: 4,
      resisted: 5,
      blocked: 1,
      damage: 3,
      resistance: 50,
      vulnerability: 0,
      immune: false,
    })
    expect(result.mechanics?.resources.hits).toBe(1)
    expect(
      combatMoveValues(
        definition.moves.fire!,
        { attack: 2, defense: 0, guard: 0, maximumHealth: 80 },
        3,
        undefined,
        [],
        combatDamageProfile(definition, 'enemy'),
      ),
    ).toMatchObject({ min: 4, max: 4, damageType: 'fire', resistance: 50 })
  })

  it('preserves Guard on immune hits, spends action costs and RNG normally, and emits no damage-received event', () => {
    const definition = fixture()
    const frames: CombatDebugFrame[] = []
    const result = resolve(definition, ['poison', 'physical'], { guard: { enemy: 12 } }, frames)
    const attacks = result.entries.filter((entry) => entry.type === 'attack')
    expect(attacks[0]).toMatchObject({ damage: 0, blocked: 0, immune: true, damageType: 'poison' })
    expect(attacks[1]).toMatchObject({ damage: 0, blocked: 10 })
    expect(
      frames.find((frame) => frame.kind === 'action' && frame.action?.move === 'poison'),
    ).toMatchObject({ spentAp: 1, guard: { enemy: 12 } })
    expect(result.mechanics?.resources.hits).toBe(0)
    expect(resolve(definition, ['poison']).seed).toBe(resolve(definition, ['physical']).seed)
    expect(result.seed).not.toBe(1024)
  })

  it('reevaluates defenses after status removal and before-action hooks', () => {
    const definition = fixture()
    const statuses = { enemy: [{ id: 'ward', source: 'enemy', remaining: 2 }] }
    expect(resolve(definition, ['fire'], { statuses }).health.enemy).toBe(90)
    expect(resolve(definition, ['shatter'], { statuses }).health.enemy).toBe(85)
    definition.mechanics!.triggers.ward = {
      event: 'before-action',
      move: 'fire',
      once: false,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'enemy', status: 'ward' }],
    }
    expect(resolve(definition, ['fire']).health.enemy).toBe(90)
  })

  it('applies typed defenses to periodic damage while retaining its bypass of flat defense and Guard', () => {
    const definition = fixture()
    definition.player.damageDefenses = { resistances: { poison: 50 } }

    const options = {
      statuses: {
        player: [{ id: 'venom', source: 'enemy', remaining: 2, stacks: 2, intensity: 2 }],
      },
      stats: { player: { attack: 0, defense: 100, guard: 100, maximumHealth: 80 } },
    }

    const result = resolve(definition, [], options)
    expect(result.health.player).toBe(74)
    expect(result.entries.find((entry) => entry.type === 'periodicDamage')).toMatchObject({
      amount: 6,
      rawDamage: 12,
      typeDamage: 6,
      damageType: 'poison',
      resisted: 6,
    })
    definition.player.damageDefenses.immunities = ['poison']
    const immune = resolve(definition, [], options)
    expect(immune.health.player).toBe(80)
    expect(immune.entries.find((entry) => entry.type === 'periodicDamage')).toMatchObject({
      amount: 0,
      immune: true,
    })
  })

  it('expires temporary immunity before the next round without modifying the actor profile', () => {
    const definition = fixture()
    definition.player.damageDefenses = { resistances: { fire: 50 } }
    definition.enemies[0]!.moves = ['fire']
    definition.enemies[0]!.rotation = ['fire']
    definition.enemies[0]!.ap = 1

    const sim = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: { player: [{ id: 'ward', source: 'player', remaining: 2 }] },
    })

    sim.resolve()
    expect(sim.snapshot().health.player).toBe(80)
    sim.resolve()
    expect(sim.snapshot().health.player).toBe(75)
    expect(definition.player.damageDefenses).toEqual({ resistances: { fire: 50 } })
  })

  it('matches dynamic damage previews and live type adjustments after attacker percentage bonuses', () => {
    const definition = fixture()
    definition.mechanics!.resources.energy = {
      label: 'Energy',
      description: '',
      initial: 50,
      maximum: 100,
    }
    definition.statuses!.power = {
      type: 'modifier',
      label: 'Power',
      description: '',
      duration: 2,
      modifiers: { attack: 2 },
      percentModifiers: { damage: 50 },
    }
    const fire = definition.moves.fire!

    if (fire.type !== 'attack') throw new Error('Expected attack')
    fire.damage = { min: 8, max: 8 }
    fire.scaling = { terms: [{ type: 'resource', resource: 'energy', factor: 0.1 }] }
    const statuses = { player: [{ id: 'power', source: 'player', remaining: 2 }] }

    const preview = combatMoveValues(
      fire,
      { attack: 2, defense: 0, guard: 0, maximumHealth: 80 },
      3,
      combatValueContext(definition, undefined, statuses, 'player', 'enemy'),
      statusContributions(definition, statuses.player),
      combatDamageProfile(definition, 'enemy'),
    )

    expect(preview.min).toBe(9)

    const result = resolve(definition, ['fire'], {
      statuses,
      stats: { enemy: { attack: 0, defense: 3, guard: 0, maximumHealth: 90 } },
      guard: { enemy: 1 },
    })

    expect(result.health.enemy).toBe(82)
  })

  it('keeps legacy physical damage and previews compatible when no typed defenses apply', () => {
    const definition = fixture()
    expect(combatMoveValues(definition.moves.physical!)).toEqual({ min: 10, max: 10 })
    const result = resolve(definition, ['physical'])
    const attack = result.entries.find((entry) => entry.type === 'attack')!
    expect(attack.damageType).toBeUndefined()
    expect(result.health.enemy).toBe(80)
    expect(resolve(definition, ['physical'], {}, []).seed).toBe(result.seed)
  })

  it('prevents no-effect damage item use against immunity while allowing separate status effects', () => {
    const definition = fixture()
    const poison = definition.moves.poison!

    const snapshot = {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      resources: {},
      statuses: {},
      guard: {},
      stats: {},
    }

    expect(abilityCanMatter(poison, definition, snapshot, 'enemy')).toBe(false)

    if (poison.type !== 'ability') throw new Error('Expected ability')
    poison.effects.push({ id: 'venom', type: 'apply-status', status: 'venom' })
    expect(abilityCanMatter(poison, definition, snapshot, 'enemy')).toBe(true)
    expect(
      combatAbilityEffectValues(
        poison.effects[0]!,
        undefined,
        0,
        undefined,
        [],
        combatDamageProfile(definition, 'enemy'),
      ),
    ).toMatchObject({ min: 0, max: 0, immune: true })
  })

  it('rejects overflowing vulnerability calculations atomically without appending debug frames', () => {
    const definition = fixture()
    const fire = definition.moves.fire!

    if (fire.type !== 'attack') throw new Error('Expected attack')
    fire.damage = { min: Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }
    definition.enemies[0]!.damageDefenses = { vulnerabilities: { fire: 100 } }

    const sim = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
    })

    sim.queue('fire', 'enemy')
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)
  })

  it('imports typed shared abilities/statuses and preserves extension data while clearing stale union fields', () => {
    const definition = fixture()
    const poison = definition.moves.poison!

    if (poison.type !== 'ability') throw new Error('Expected ability')
    poison.effects.push({ id: 'venom', type: 'apply-status', status: 'venom' })

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      moves: { poison },
      statuses: definition.statuses,
    })

    const moves = { ...definition.moves }
    delete moves.poison

    const source = combatSourceSchema.parse({
      ...definition,
      moves,
      statuses: { ward: definition.statuses!.ward },
      sharedMoves: [{ library: 'shared', id: 'poison' }],
    })

    const result = resolveCombatSource(source, new Map([['shared', library]]))
    expect(result.issues).toEqual([])
    expect(result.definition?.moves.poison).toMatchObject({
      effects: [{ damageType: 'poison' }, { status: 'venom' }],
    })
    expect(result.definition?.statuses?.venom).toMatchObject({ damageType: 'poison' })
    expect(result.origins.statuses.venom?.library).toBe('shared')
    expect(
      mergeCombatDamageDefenses(
        { extension: 'keep', resistances: { fire: 50 } },
        { immunities: ['water'] },
      ),
    ).toEqual({
      extension: 'keep',
      resistances: undefined,
      vulnerabilities: undefined,
      immunities: ['water'],
    })

    const old = {
      moves: {
        lightning: {
          ...definition.moves.lightning,
          effects: [{ id: 'damage', type: 'damage', damageType: 'lightning' }],
        },
      },
      statuses: {
        venom: {
          ...definition.statuses!.venom,
          damageType: 'poison',
          damageDefenses: { extension: 'defenses', immunities: ['fire'] },
        },
      },
    }

    const edited = combatSourceSchema.parse({
      ...definition,
      moves: {
        ...definition.moves,
        lightning: {
          type: 'ability',
          label: 'Heal',
          target: 'self',
          apCost: 1,
          effects: [{ id: 'damage', type: 'heal', amount: 3 }],
        },
      },
      statuses: {
        ...definition.statuses,
        venom: {
          type: 'regeneration',
          label: 'Regen',
          duration: 2,
          amount: 3,
          damageDefenses: { resistances: { water: 25 } },
        },
      },
    })

    const saved = mergeCombatEntries(old, edited)
    expect(saved.moves.lightning?.effects?.[0]?.damageType).toBeUndefined()
    expect(saved.statuses?.venom?.damageType).toBeUndefined()
    expect(saved.statuses?.venom?.damageDefenses).toMatchObject({
      extension: 'defenses',
      resistances: { water: 25 },
      immunities: undefined,
    })
  })
})
