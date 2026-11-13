import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatSourceSchema,
  combatLibrarySchema,
  gameRulesSchema,
  inventorySchema,
  gameplaySaveDefinition,
  questSchema,
  dialogueSchema,
  sceneSchema,
  levelingProfileSchema,
} from '@ancadeba/schemas'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'

const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

async function read(path: string): Promise<string> {
  return readFile(new URL(`../sample-games/basic/${path}`, import.meta.url), 'utf8')
}

async function load(overrides: Readonly<Record<string, unknown>> = {}, language = 'en') {
  return new GameLoader(
    new JsonResourceLoader(
      {
        readText: (path) =>
          Object.hasOwn(overrides, path)
            ? Promise.resolve(JSON.stringify(overrides[path]))
            : read(path),
        readBytes: async (path) =>
          new Uint8Array(await readFile(new URL(`../sample-games/basic/${path}`, import.meta.url))),
      },
      logger,
    ),
    [language],
  ).load()
}

describe('gameplay save compatibility', () => {
  it('uses the same fingerprint regardless of the startup language', async () => {
    const en = await load({}, 'en')
    const nl = await load({}, 'nl')

    expect(nl.language).toBe('nl')
    expect(nl.saveCompatibility).toBe(en.saveCompatibility)
  })

  it('ignores presentation edits across scenes, inventories, combat, libraries, dialogue, quests and leveling', async () => {
    const before = await load()
    const scene = sceneSchema.parse(JSON.parse(await read('scenes/standard.json')))
    const inventory = inventorySchema.parse(JSON.parse(await read('inventory/museum.json')))
    const combat = combatSourceSchema.parse(JSON.parse(await read('combat/training.json')))

    const library = combatLibrarySchema.parse(
      JSON.parse(await read('combat-libraries/common.json')),
    )

    const dialogue = dialogueSchema.parse(JSON.parse(await read('dialogues/curator.json')))
    const quest = questSchema.parse(JSON.parse(await read('quests/harbour-survey.json')))
    const leveling = levelingProfileSchema.parse(JSON.parse(await read('leveling/player.json')))
    const en = JSON.parse(await read('languages/en/messages.json'))
    const nl = JSON.parse(await read('languages/nl/messages.json'))
    en['translation.replacement'] = 'Revised presentation'
    nl['translation.replacement'] = 'Herziene presentatie'
    scene.titleKey = 'translation.replacement'
    const text = scene.components.find((component) => component.type === 'text')!
    text.textKey = 'translation.replacement'
    text.text = 'Revised literal fallback'
    inventory.owners.player!.labelKey = 'translation.replacement'
    inventory.owners.player!.label = 'Another fallback'
    inventory.owners.player!.equipmentSlots.charm = 'Renamed slot'
    inventory.owners.player!.equipmentSlotKeys = { charm: 'translation.replacement' }
    inventory.itemTypes['folded-letter']!.properties[0]!.value = 'Revised property text'
    combat.labelKey = 'translation.replacement'
    combat.moves.heavy!.labelKey = 'translation.replacement'
    combat.messageKeys.planning = 'translation.replacement'
    library.moves.attack!.labelKey = 'translation.replacement'
    dialogue.nodes.greeting!.lines[0]!.text = { textKey: 'translation.replacement' }
    dialogue.nodes.greeting!.choices[0]!.labelKey = 'translation.replacement'
    quest.stages[0]!.objectives[0]!.labelKey = 'translation.replacement'
    leveling.labelKey = 'translation.replacement'

    const after = await load({
      'scenes/standard.json': scene,
      'inventory/museum.json': inventory,
      'combat/training.json': combat,
      'combat-libraries/common.json': library,
      'dialogues/curator.json': dialogue,
      'quests/harbour-survey.json': quest,
      'leveling/player.json': leveling,
      'languages/en/messages.json': en,
      'languages/nl/messages.json': nl,
    })

    expect(after.saveCompatibility).toBe(before.saveCompatibility)
    expect(after.inventory!.owners.player!.label).toBe('Revised presentation')
  })

  it('retains gameplay changes across those same resources', async () => {
    const before = await load()
    const combat = combatSourceSchema.parse(JSON.parse(await read('combat/training.json')))

    const library = combatLibrarySchema.parse(
      JSON.parse(await read('combat-libraries/common.json')),
    )

    const dialogue = dialogueSchema.parse(JSON.parse(await read('dialogues/curator.json')))
    const quest = questSchema.parse(JSON.parse(await read('quests/harbour-survey.json')))
    const leveling = levelingProfileSchema.parse(JSON.parse(await read('leveling/player.json')))
    const scene = sceneSchema.parse(JSON.parse(await read('scenes/standard.json')))
    const inventory = inventorySchema.parse(JSON.parse(await read('inventory/museum.json')))
    const heavy = combat.moves.heavy!
    const attack = library.moves.attack!

    if (heavy.type !== 'attack' || attack.type !== 'attack')
      throw new Error('Expected sample attacks')
    heavy.damage.max++
    attack.damage.max++
    dialogue.nodes.greeting!.choices[0]!.next = 'greeting'
    quest.rewards!.numeric[0]!.amount++
    leveling.levels[1]!.xp++
    scene.components.pop()
    inventory.itemTypes['healing-potion']!.use!.consumption = 'keep'

    for (const [path, value] of Object.entries({
      'combat/training.json': combat,
      'combat-libraries/common.json': library,
      'dialogues/curator.json': dialogue,
      'quests/harbour-survey.json': quest,
      'leveling/player.json': leveling,
      'scenes/standard.json': scene,
      'inventory/museum.json': inventory,
    }))
      expect((await load({ [path]: value })).saveCompatibility, path).not.toBe(
        before.saveCompatibility,
      )
  })

  it('preserves dictionary IDs that share names with presentation fields and gameplay string values', () => {
    const rules = gameRulesSchema.parse({
      state: [{ path: ['labelKey'], value: 'closed' }],
      actions: {
        messages: [
          { when: [], effects: [{ type: 'set-state', path: ['labelKey'], value: 'open' }] },
        ],
      },
    })

    const before = gameplaySaveDefinition(gameRulesSchema, rules)
    const changed = structuredClone(rules)
    const effect = changed.actions.messages![0]!.effects[0]!

    if (effect.type !== 'set-state') throw new Error('Expected a state effect')
    effect.value = 'locked'
    expect(gameplaySaveDefinition(gameRulesSchema, changed)).not.toEqual(before)
    expect(gameplaySaveDefinition(gameRulesSchema, { ...rules, actions: {} })).not.toEqual(before)

    const inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: {},
      items: {},
      owners: { label: { label: 'Player', equipmentSlots: { text: 'Hand' } } },
    })

    const renamed = structuredClone(inventory)
    renamed.owners.label!.equipmentSlots = { name: 'Hand' }
    expect(gameplaySaveDefinition(inventorySchema, renamed)).not.toEqual(
      gameplaySaveDefinition(inventorySchema, inventory),
    )
  })
})
