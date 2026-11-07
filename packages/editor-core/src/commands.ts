import { levelingProfileSchema, characterProgressionComponentSchema } from '@ancadeba/schemas'
import { z } from 'zod'
import {
  itemUseSchema,
  combatBonusesSchema,
  combatStatsProfileSchema,
  gameIdSchema,
  sceneSchema,
  imageAssetSchema,
  partSchema,
  compositionSchema,
  graphicComponentSchema,
  assetIdSchema,
  gameRulesSchema,
  gameBindingSchema,
  buttonComponentSchema,
  requestActionSchema,
  actionBarComponentSchema,
  inputSchema,
  inventoryItemActionSchema,
  nearbyComponentSchema,
  statusPanelComponentSchema,
  itemPresentationSchema,
  itemDetailsComponentSchema,
  equipmentComponentSchema,
  shopComponentSchema,
  inventoryComponentSchema,
  combatSourceSchema,
  combatLibrarySchema,
  combatReferenceSchema,
  combatComponentSchema,
  textComponentSchema,
  languageSelectComponentSchema,
  mapViewComponentSchema,
} from '@ancadeba/schemas'

/** Scene components without a dedicated authoring command are saved whole. */
export const basicComponentSchema = z.discriminatedUnion('type', [
  textComponentSchema,
  buttonComponentSchema,
  languageSelectComponentSchema,
  mapViewComponentSchema,
])

const metadata = {
  // A blank title is valid when the document has a titleKey; project validation enforces one of them.
  title: z.string().trim(),
  description: z.string(),
}

export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('game.updateMetadata'),
    ...metadata,
    version: z.string().trim().min(1),
  }),
  z.strictObject({
    type: z.literal('scene.create'),
    scene: sceneSchema.passthrough().safeExtend({
      screen: sceneSchema.shape.screen
        .passthrough()
        .extend({ grid: sceneSchema.shape.screen.shape.grid.passthrough() }),
    }),
  }),
  z.strictObject({
    type: z.literal('scene.updateMetadata'),
    sceneId: gameIdSchema,
    ...metadata,
  }),
  z.strictObject({
    type: z.literal('scene.updateLayout'),
    sceneId: gameIdSchema,
    rows: z.number().int().positive(),
    columns: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('assets.upsertImage'),
    id: assetIdSchema,
    image: imageAssetSchema,
  }),
  z.strictObject({ type: z.literal('assets.upsertPart'), id: assetIdSchema, part: partSchema }),
  z.strictObject({
    type: z.literal('assets.upsertComposition'),
    id: assetIdSchema,
    composition: compositionSchema,
  }),
  z.strictObject({
    type: z.literal('assets.remove'),
    kind: z.enum(['images', 'parts', 'compositions']),
    id: assetIdSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertGraphic'),
    sceneId: gameIdSchema,
    component: graphicComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.removeGraphic'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
  }),
  z.strictObject({
    type: z.literal('game.updateRules'),
    ruleId: gameIdSchema,
    rules: gameRulesSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertRuleButton'),
    sceneId: gameIdSchema,
    component: buttonComponentSchema.safeExtend({ action: requestActionSchema.optional() }),
  }),
  z.strictObject({
    type: z.literal('inventory.setRuleInspection'),
    itemType: gameIdSchema,
    inspection: z
      .strictObject({
        action: gameIdSchema,
        details: gameBindingSchema,
        inline: z.boolean().optional(),
      })
      .nullable(),
  }),
  z.strictObject({
    type: z.literal('scene.setActionBar'),
    sceneId: gameIdSchema,
    component: actionBarComponentSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('game.updateInput'),
    inputId: gameIdSchema,
    input: inputSchema,
  }),
  z.strictObject({
    type: z.literal('inventory.setItemActions'),
    itemType: gameIdSchema,
    actions: z.record(gameIdSchema, inventoryItemActionSchema),
  }),
  z.strictObject({
    type: z.literal('scene.upsertNearby'),
    sceneId: gameIdSchema,
    component: nearbyComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertComponent'),
    sceneId: gameIdSchema,
    component: basicComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertStatusPanel'),
    sceneId: gameIdSchema,
    component: statusPanelComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.removeStatusPanel'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
  }),
  z.strictObject({
    type: z.literal('inventory.setItemPresentation'),
    itemType: gameIdSchema,
    presentation: itemPresentationSchema,
    combatBonuses: combatBonusesSchema.nullable().optional(),
    use: itemUseSchema.nullable().optional(),
  }),
  z.strictObject({
    type: z.literal('inventory.setEquipmentSlots'),
    owner: gameIdSchema,
    slots: z.record(gameIdSchema, z.string().trim().min(1)),
    combatStats: combatStatsProfileSchema.nullable().optional(),
  }),
  z.strictObject({
    type: z.literal('scene.setInventoryDetails'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
    descriptionTarget: gameIdSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('scene.upsertItemView'),
    sceneId: gameIdSchema,
    component: z.discriminatedUnion('type', [itemDetailsComponentSchema, equipmentComponentSchema]),
  }),
  z.strictObject({
    type: z.literal('scene.removeItemView'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertShop'),
    sceneId: gameIdSchema,
    component: shopComponentSchema,
    panels: z.array(inventoryComponentSchema).max(2).optional(),
  }),
  z.strictObject({
    type: z.literal('scene.removeShop'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
  }),
  z.strictObject({
    type: z.literal('game.upsertCombat'),
    encounter: combatSourceSchema,
    scene: z.object({ id: gameIdSchema, component: combatComponentSchema }).optional(),
  }),
  z.strictObject({ type: z.literal('game.removeCombat'), encounterId: gameIdSchema }),
  z.strictObject({
    type: z.literal('scene.setCombat'),
    sceneId: gameIdSchema,
    component: combatComponentSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('game.upsertLeveling'),
    profile: levelingProfileSchema,
    scene: z
      .object({ id: gameIdSchema, component: characterProgressionComponentSchema })
      .optional(),
  }),
  z.strictObject({ type: z.literal('game.removeLeveling'), profileId: gameIdSchema }),
  z.strictObject({
    type: z.literal('scene.upsertLevelingView'),
    sceneId: gameIdSchema,
    component: characterProgressionComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.removeLevelingView'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
  }),
  z.strictObject({ type: z.literal('game.upsertCombatLibrary'), library: combatLibrarySchema }),
  z.strictObject({ type: z.literal('game.removeCombatLibrary'), libraryId: gameIdSchema }),
  z.strictObject({
    type: z.literal('combat.copySharedEntry'),
    encounterId: gameIdSchema,
    kind: z.enum(['moves', 'statuses']),
    reference: combatReferenceSchema,
    localId: combatReferenceSchema.shape.id,
  }),
])

// Paths are further checked by the server's workspace boundary.
export const commandRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  command: commandSchema,
})

export type EditorCommand = z.infer<typeof commandSchema>

export type CommandRequest = z.infer<typeof commandRequestSchema>

export const assetImportMetadataSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  id: assetIdSchema,
  format: imageAssetSchema.shape.format,
})

const scene = {
  'schema-version': '1.0.0',
  id: 'shop',
  title: 'Shop',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 12, columns: 16 } },
  components: [],
}

export const capabilities = {
  version: 1,
  requestSchema: z.toJSONSchema(commandRequestSchema),
  commands: [
    {
      type: 'game.upsertLeveling',
      example: {
        type: 'game.upsertLeveling',
        profile: {
          'schema-version': '1.0.0',
          id: 'player',
          label: 'Player',
          xp: { source: 'game.state', path: ['xp'] },
          level: { source: 'game.state', path: ['level'] },
          levels: [{ xp: 0 }, { xp: 10 }],
        },
      },
    },
    { type: 'game.removeLeveling', example: { type: 'game.removeLeveling', profileId: 'player' } },
    {
      type: 'scene.upsertLevelingView',
      example: {
        type: 'scene.upsertLevelingView',
        sceneId: 'shop',
        component: {
          id: 'progression',
          type: 'character-progression',
          profile: 'player',
          placement: { row: 1, column: 1 },
        },
      },
    },
    {
      type: 'scene.removeLevelingView',
      example: { type: 'scene.removeLevelingView', sceneId: 'shop', componentId: 'progression' },
    },
    {
      type: 'game.upsertCombat',
      example: {
        type: 'game.upsertCombat',
        encounter: {
          'schema-version': '1.0.0',
          id: 'training',
          label: 'Training',
          player: {
            id: 'player',
            label: 'Player',
            health: { source: 'game.state', path: ['health'] },
            maximumHealth: 40,
            moves: ['attack'],
          },
          enemies: [
            {
              id: 'enemy',
              label: 'Opponent',
              health: { source: 'game.state', path: ['enemyHealth'] },
              maximumHealth: 20,
              moves: ['attack'],
              rotation: ['attack'],
            },
          ],
          moves: {
            attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 4 } },
          },
        },
      },
    },
    { type: 'game.removeCombat', example: { type: 'game.removeCombat', encounterId: 'training' } },
    {
      type: 'scene.setCombat',
      example: { type: 'scene.setCombat', sceneId: 'shop', component: null },
    },
    {
      type: 'scene.upsertShop',
      example: {
        type: 'scene.upsertShop',
        sceneId: 'shop',
        component: {
          id: 'trading',
          type: 'shop',
          placement: { row: 1, column: 1 },
          playerInventory: 'player-items',
          merchantInventory: 'merchant-items',
          playerBalance: { source: 'game.state', path: ['gold'] },
          merchantFunds: { type: 'unlimited' },
          prices: {},
        },
      },
    },
    {
      type: 'scene.removeShop',
      example: { type: 'scene.removeShop', sceneId: 'shop', componentId: 'trading' },
    },
    {
      type: 'inventory.setItemPresentation',
      example: {
        type: 'inventory.setItemPresentation',
        itemType: 'letter',
        presentation: { label: 'Letter', description: 'A sealed letter', properties: [] },
      },
    },
    {
      type: 'inventory.setEquipmentSlots',
      example: { type: 'inventory.setEquipmentSlots', owner: 'player', slots: { head: 'Head' } },
    },
    {
      type: 'scene.setInventoryDetails',
      example: {
        type: 'scene.setInventoryDetails',
        sceneId: 'shop',
        componentId: 'inventory',
        descriptionTarget: 'narrative',
      },
    },
    {
      type: 'scene.upsertItemView',
      example: {
        type: 'scene.upsertItemView',
        sceneId: 'shop',
        component: {
          id: 'details',
          type: 'item-details',
          inventory: 'inventory',
          placement: { row: 1, column: 1 },
        },
      },
    },
    {
      type: 'scene.removeItemView',
      example: { type: 'scene.removeItemView', sceneId: 'shop', componentId: 'details' },
    },
    {
      type: 'scene.upsertComponent',
      example: {
        type: 'scene.upsertComponent',
        sceneId: 'shop',
        component: {
          id: 'title',
          type: 'text',
          text: 'Museum shop',
          placement: { row: 1, column: 1 },
          presentation: { variant: 'heading', align: 'center' },
        },
      },
    },
    {
      type: 'scene.upsertStatusPanel',
      example: {
        type: 'scene.upsertStatusPanel',
        sceneId: 'shop',
        component: {
          id: 'status',
          type: 'status-panel',
          label: 'Status',
          placement: { row: 1, column: 1 },
          rows: [],
          effects: [],
        },
      },
    },
    {
      type: 'scene.removeStatusPanel',
      example: { type: 'scene.removeStatusPanel', sceneId: 'shop', componentId: 'status' },
    },
    {
      type: 'scene.upsertNearby',
      example: {
        type: 'scene.upsertNearby',
        sceneId: 'shop',
        component: {
          id: 'nearby',
          type: 'nearby',
          label: 'Nearby',
          placement: { row: 1, column: 1 },
          descriptionTarget: 'narrative',
          entries: {},
        },
      },
    },
    {
      type: 'inventory.setItemActions',
      example: {
        type: 'inventory.setItemActions',
        itemType: 'letter',
        actions: { read: { action: 'read-letter' } },
      },
    },
    {
      type: 'scene.setActionBar',
      example: {
        type: 'scene.setActionBar',
        sceneId: 'shop',
        component: {
          id: 'actions',
          type: 'action-bar',
          placement: { row: 1, column: 1 },
          slots: {},
        },
      },
    },
    {
      type: 'game.updateInput',
      example: {
        type: 'game.updateInput',
        inputId: 'controls',
        input: {
          'schema-version': '1.0.0',
          'virtual-keys': ['primary'],
          keyboard: { KeyQ: 'primary' },
          contexts: { gameplay: { primary: 'slot-1' } },
          'initial-context': 'gameplay',
        },
      },
    },
    {
      type: 'game.updateRules',
      example: {
        type: 'game.updateRules',
        ruleId: 'greeting',
        rules: { state: [], actions: { greet: [{ when: [], effects: [] }] } },
      },
    },
    {
      type: 'scene.upsertRuleButton',
      example: {
        type: 'scene.upsertRuleButton',
        sceneId: 'shop',
        component: {
          type: 'button',
          id: 'greet',
          label: 'Greet',
          placement: { row: 1, column: 1 },
          action: { type: 'request-action', action: 'greet' },
        },
      },
    },
    {
      type: 'inventory.setRuleInspection',
      example: { type: 'inventory.setRuleInspection', itemType: 'letter', inspection: null },
    },
    {
      type: 'game.updateMetadata',
      example: { type: 'game.updateMetadata', title: 'My game', description: '', version: '1.0.0' },
    },
    { type: 'scene.create', example: { type: 'scene.create', scene } },
    {
      type: 'scene.updateMetadata',
      example: { type: 'scene.updateMetadata', sceneId: 'shop', title: 'Shop', description: '' },
    },
    {
      type: 'scene.updateLayout',
      example: { type: 'scene.updateLayout', sceneId: 'shop', rows: 12, columns: 16 },
    },
    {
      type: 'assets.upsertImage',
      example: {
        type: 'assets.upsertImage',
        id: 'icon',
        image: {
          format: 'svg',
          source: 'assets/icon.svg',
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          colors: {},
          palettes: {},
        },
      },
    },
    {
      type: 'assets.upsertPart',
      example: {
        type: 'assets.upsertPart',
        id: 'shirt',
        part: {
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          pieces: [{ id: 'front', image: 'icon', layer: 'body', anchor: 'origin' }],
          colors: {},
          palettes: {},
        },
      },
    },
    {
      type: 'assets.upsertComposition',
      example: {
        type: 'assets.upsertComposition',
        id: 'portrait',
        composition: {
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          layers: ['body'],
          anchors: { origin: { x: 0, y: 0 } },
          slots: { body: { parts: ['shirt'], default: 'shirt' } },
        },
      },
    },
    { type: 'assets.remove', example: { type: 'assets.remove', kind: 'images', id: 'unused' } },
    {
      type: 'scene.upsertGraphic',
      example: {
        type: 'scene.upsertGraphic',
        sceneId: 'shop',
        component: {
          id: 'portrait',
          type: 'graphic',
          placement: { row: 1, column: 1 },
          visual: 'icon',
          alt: 'Portrait',
        },
      },
    },
    {
      type: 'scene.removeGraphic',
      example: { type: 'scene.removeGraphic', sceneId: 'shop', componentId: 'portrait' },
    },
    {
      type: 'game.upsertCombatLibrary',
      example: {
        type: 'game.upsertCombatLibrary',
        library: { 'schema-version': '1.0.0', id: 'common', moves: {}, statuses: {} },
      },
    },
    {
      type: 'game.removeCombatLibrary',
      example: { type: 'game.removeCombatLibrary', libraryId: 'common' },
    },
    {
      type: 'combat.copySharedEntry',
      example: {
        type: 'combat.copySharedEntry',
        encounterId: 'training',
        kind: 'moves',
        reference: { library: 'common', id: 'attack' },
        localId: 'local-attack',
      },
    },
  ],
}
