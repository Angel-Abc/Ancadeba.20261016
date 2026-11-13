import { describe, expect, it } from 'vite-plus/test'
import { createRuntimeTranslator } from '@ancadeba/schemas'
import { GameLifecycle, GameLoader, runtimeText } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'

const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

interface GameFiles {
  readonly [path: string]: unknown
}

describe('built-in runtime localization', () => {
  it('uses regional defaults and catalog overrides with safe, single-pass substitutions', () => {
    expect(createRuntimeTranslator()('inventory.carried')).toBe('Carried')
    expect(createRuntimeTranslator('nl-NL')('inventory.carried')).toBe('Gedragen')
    expect(createRuntimeTranslator('fr')('inventory.carried')).toBe('Carried')

    const t = createRuntimeTranslator('nl', {
      fallback: { 'runtime.inventory.worn': 'Equipment', 'runtime.nearby.empty': 'Nobody' },
      messages: { 'runtime.inventory.worn': 'Aangetrokken', 'runtime.nearby.empty': '' },
    })

    expect(t('inventory.worn')).toBe('Aangetrokken')
    expect(t('nearby.empty')).toBe('')
    expect(t('inventory.move')).toBe('Geselecteerd voorwerp verplaatsen')
    expect(t('inventory.inspectItem', { item: '<b>{item}$&</b>' })).toBe(
      '<b>{item}$&</b> inspecteren',
    )
    expect(
      createRuntimeTranslator('fr', {
        fallback: { 'runtime.inventory.worn': 'Equipment' },
        messages: {},
      })('inventory.worn'),
    ).toBe('Equipment')
  })

  it('loads overrides without rules and updates retained inventory feedback on language changes', async () => {
    const files: GameFiles = {
      'game.json': {
        'schema-version': '1.0.0',
        id: 'runtime-text',
        title: 'Runtime text',
        version: '1',
        scenes: [],
        languages: { default: 'en', available: ['en', 'nl'] },
        inventory: ['items'],
      },
      'inventory/items.json': {
        'schema-version': '1.0.0',
        owners: {
          player: {
            label: 'Player',
            labelKey: 'player',
            equipmentSlots: { hand: 'Hand' },
            equipmentSlotKeys: { hand: 'hand' },
          },
        },
        itemTypes: { stone: { label: 'Stone' } },
        items: { stone: { itemType: 'stone', placement: { type: 'carried', owner: 'player' } } },
      },
      'languages/en/messages.json': {
        player: 'Player',
        hand: 'Hand',
        'runtime.inventory.unknownItem': 'Missing {id}',
        'runtime.save.save': 'Keep progress',
      },
      'languages/nl/messages.json': {
        player: 'Speler',
        hand: 'Handslot',
        'runtime.inventory.unknownItem': 'Ontbrekend {id}',
      },
    }

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readBytes: async () => new Uint8Array(),
          readText: async (path) => {
            if (!Object.hasOwn(files, path)) throw new Error(`Missing fixture: ${path}`)

            return JSON.stringify(files[path])
          },
        },
        logger,
      ),
    ).load()

    const lifecycle = new GameLifecycle(game, {
      createGameState: () => undefined,
      createSceneState: () => undefined,
    })

    try {
      const instance = lifecycle.startGame()
      const inventory = instance.inventory!
      expect(inventory.checkMove('missing', { type: 'carried', owner: 'player' })).toBe(
        'Missing missing',
      )
      expect(runtimeText(game, 'save.save')).toBe('Keep progress')
      game.localization!.select('nl')
      expect(game.inventory!.owners.player!.label).toBe('Speler')
      expect(game.inventory!.owners.player!.equipmentSlots.hand).toBe('Handslot')
      expect(inventory.checkMove('missing', { type: 'carried', owner: 'player' })).toBe(
        'Ontbrekend missing',
      )
      expect(runtimeText(game, 'save.save')).toBe('Keep progress')
      expect(inventory.checkMove('stone', { type: 'inside', container: 'stone' })).toBe(
        'Dit voorwerp kan geen andere voorwerpen bevatten: stone',
      )
      const token = { encounter: 'test' }
      expect(inventory.reserveItem?.('stone', token)).toBeUndefined()
      expect(inventory.checkMove('stone', { type: 'carried', owner: 'other' })).toBe(
        'Onbekende inventariseigenaar: other',
      )
      expect(inventory.reserveItem?.('stone', token)).toBe(
        'Het voorwerp is gereserveerd voor een gevechtsplan',
      )
      expect(lifecycle.currentGame).toBe(instance)
    } finally {
      lifecycle.dispose()
    }
  })
})
