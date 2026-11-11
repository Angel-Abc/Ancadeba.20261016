import { describe, expect, it } from 'vite-plus/test'
import {
  gameRulesSchema,
  gameSchema,
  inventorySchema,
  sceneSchema,
  type GameRulesDefinition,
} from '@ancadeba/schemas'
import { assembleGameData } from '@ancadeba/game-runtime'
import { applyCommand, inspectProject } from '@ancadeba/editor-core'

const game = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'pickups',
  title: 'Pickups',
  version: '1',
  scenes: ['world'],
  inventory: ['items'],
  rules: ['pickups'],
})

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'world',
  title: 'World',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
  components: [],
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  itemTypes: { berry: { label: 'Berry' } },
  owners: { player: { label: 'Player' }, world: { label: 'World' } },
  items: { berry: { itemType: 'berry', placement: { type: 'carried', owner: 'world' } } },
})

const rules = gameRulesSchema.parse({
  state: [{ path: ['collected'], value: false }],
  actions: {
    collect: [
      {
        when: [],
        effects: [
          { type: 'collect-items', items: ['berry'], owner: 'player' },
          { type: 'set-state', path: ['collected'], value: true },
        ],
      },
    ],
  },
})

const project = (candidate = rules) => ({
  revision: 'one',
  documents: {
    'game.json': game,
    'scenes/world.json': scene,
    'inventory/items.json': inventory,
    'rules/pickups.json': candidate,
  },
})

describe('authored inventory collection validation', () => {
  it.each([
    { items: [], owner: 'player' },
    { items: ['berry', 'berry'], owner: 'player' },
    { items: ['berry'], owner: '' },
    { items: Array.from({ length: 101 }, (_, index) => `berry-${index}`), owner: 'player' },
  ])('rejects malformed pickup batches %#', (effect) => {
    expect(
      gameRulesSchema.safeParse({
        ...rules,
        actions: { collect: [{ when: [], effects: [{ type: 'collect-items', ...effect }] }] },
      }).success,
    ).toBe(false)
  })

  it.each(['item', 'owner'])(
    'validates pickup %s references in both runtime loading and editor commands',
    (reference) => {
      const candidate = structuredClone(rules)
      const effect = candidate.actions.collect![0]!.effects[0]!

      if (effect.type !== 'collect-items') throw new Error('Expected pickup effect')

      if (reference === 'item') effect.items = ['missing']
      else effect.owner = 'missing'
      expect(() =>
        assembleGameData(
          game,
          new Map([['world', scene]]),
          undefined,
          undefined,
          new Map(),
          new Map([['items', inventory]]),
          undefined,
          new Map([['pickups', candidate]]),
        ),
      ).toThrow(`Unknown inventory ${reference}`)
      expect(inspectProject(project(candidate)).diagnostics).toContainEqual(
        expect.objectContaining({
          file: 'rules/pickups.json',
          message: `Unknown inventory ${reference}`,
        }),
      )
      const original = project()
      const before = JSON.stringify(original)
      expect(() =>
        applyCommand(original, { type: 'game.updateRules', ruleId: 'pickups', rules: candidate }),
      ).toThrow('invalid project')
      expect(JSON.stringify(original)).toBe(before)
    },
  )

  it.each([
    { type: 'move-item', item: 'berry', owner: 'player' },
    { type: 'enter-scene', scene: 'world' },
    { type: 'collect-items', items: ['berry'], owner: 'player' },
  ])(
    'rejects combining a pickup with another inventory operation or scene transition: $type',
    (effect) => {
      expect(
        gameRulesSchema.safeParse({
          ...rules,
          actions: {
            collect: [
              {
                when: [],
                effects: [{ type: 'collect-items', items: ['berry'], owner: 'player' }, effect],
              },
            ],
          },
        }).success,
      ).toBe(false)
    },
  )

  it('persists pickup item lists through editor commands without dropping the associated state write', () => {
    const candidate: GameRulesDefinition = structuredClone(rules)

    const result = applyCommand(project(), {
      type: 'game.updateRules',
      ruleId: 'pickups',
      rules: candidate,
    })

    expect(inspectProject(result.project).rules?.actions.collect).toEqual(rules.actions.collect)
  })
})
