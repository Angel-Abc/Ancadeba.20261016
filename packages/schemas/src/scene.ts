import { z } from 'zod'
import { dialogueCommandSchema, questOperationSchema } from './story.js'
import { questStatusSchema } from './storyConditions.js'
import { gameIdSchema } from './game.js'
import { translationKeySchema } from './languages.js'
import {
  bindingAliasSchema,
  gameBindingSchema,
  textBindingsSchema,
  textPlaceholders,
} from './bindings.js'
import {
  graphicAppearanceSchema,
  graphicHasBindings,
  assetIdSchema,
  colorSchema,
} from './assets.js'
import { mapPositionSchema, mapViewportSchema } from './map.js'
import { sceneTransitionSchema } from './sceneTransition.js'
import { characterReferenceSchema, characterViewKindSchema } from './characterAppearances.js'
import { combatCommandSchema } from './combat.js'

export const gridPlacementSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  rowSpan: z.number().int().positive().default(1),
  columnSpan: z.number().int().positive().default(1),
})

const componentLayoutFields = {
  placement: gridPlacementSchema,
  cssClasses: z.array(z.string().regex(/^\S+$/u, 'Expected a single CSS class name')).optional(),
}

export const characterProgressionComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('character-progression'),
  profile: gameIdSchema,
  textTarget: gameIdSchema.optional(),
  ...componentLayoutFields,
})

export const combatComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('combat'),
  ...componentLayoutFields,
  encounter: gameIdSchema,
  textTarget: gameIdSchema.optional(),
  lootInventory: gameIdSchema.optional(),
})

export const textComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('text'),
    ...componentLayoutFields,
    text: z.string().default(''),
    textKey: translationKeySchema.optional(),
    bindings: textBindingsSchema.optional(),
    presentation: z
      .object({
        variant: z.enum(['body', 'heading']).default('body'),
        align: z.enum(['start', 'center', 'end']).default('start'),
      })
      .default({ variant: 'body', align: 'start' }),
  })
  .superRefine((component, context) => {
    if (component.bindings === undefined) return

    for (const { alias } of textPlaceholders(component.text)) {
      if (!bindingAliasSchema.safeParse(alias).success || !Object.hasOwn(component.bindings, alias))
        context.addIssue({
          code: 'custom',
          path: ['text'],
          message: `Undeclared or invalid text binding: ${alias}`,
        })
    }
  })

export const requestActionSchema = z.object({
  type: z.literal('request-action'),
  action: gameIdSchema,
  enabledWhen: gameBindingSchema.optional(),
})

const gameplayButtonActions = [
  z.object({ type: z.literal('new-game'), scene: gameIdSchema }),
  sceneTransitionSchema.strip(),
  requestActionSchema,
  z.object({
    type: z.literal('interact-map'),
    mapView: gameIdSchema,
    object: gameIdSchema.optional(),
  }),
  z.object({
    type: z.literal('move-map'),
    mapView: gameIdSchema,
    direction: z.enum(['north', 'east', 'south', 'west']),
  }),
] as const

export const buttonActionSchema = z.discriminatedUnion('type', [
  ...gameplayButtonActions,
  z.object({ type: z.literal('save-game') }),
  z.object({ type: z.literal('load-game') }),
  z.object({ type: z.literal('load-autosave') }),
  z.object({ type: z.literal('delete-save') }),
  z.object({ type: z.literal('export-save') }),
  z.object({ type: z.literal('import-save') }),
  z.object({ type: z.literal('open-menu'), scene: gameIdSchema }),
  z.object({ type: z.literal('resume-game') }),
  z.object({ type: z.literal('main-menu'), scene: gameIdSchema }),
])

export const saveSlotsComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('save-slots'),
  ...componentLayoutFields,
  label: z.string().default('Save slots'),
  labelKey: translationKeySchema.optional(),
  showName: z.boolean().default(true),
})

export const saveStatusComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('save-status'),
  ...componentLayoutFields,
  label: z.string().default('Save status'),
  labelKey: translationKeySchema.optional(),
})

/** With no map target, the whole gameplay scene acts as a save point. */
export const savePointComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('save-point'),
  ...componentLayoutFields,
  label: z.string().default('Save game'),
  labelKey: translationKeySchema.optional(),
  location: z
    .object({
      mapView: gameIdSchema,
      map: gameIdSchema.optional(),
      position: mapPositionSchema,
      radius: z.number().int().nonnegative().default(0),
    })
    .optional(),
  menuScene: gameIdSchema.optional(),
})

export const buttonComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('button'),
    ...componentLayoutFields,
    showOnlyWhenActive: z.boolean().optional(),
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    description: z.string().optional(),
    descriptionKey: translationKeySchema.optional(),
    unavailableText: z.string().optional(),
    unavailableTextKey: translationKeySchema.optional(),
    /** Buttons without an action are rendered disabled. */
    action: buttonActionSchema.optional(),
  })
  .refine((button) => Boolean(button.label || button.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const actionBarSlotSchema = z
  .object({
    showOnlyWhenActive: z.boolean().optional(),
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    description: z.string().optional(),
    descriptionKey: translationKeySchema.optional(),
    unavailableText: z.string().optional(),
    unavailableTextKey: translationKeySchema.optional(),
    action: z.discriminatedUnion('type', [
      ...gameplayButtonActions,
      z.object({
        type: z.literal('dialogue-action'),
        nearby: gameIdSchema,
        command: dialogueCommandSchema,
      }),
      z
        .object({
          type: z.literal('quest-action'),
          quest: gameIdSchema.optional(),
          journal: gameIdSchema.optional(),
          operation: questOperationSchema,
          outcome: gameIdSchema.optional(),
        })
        .refine(
          (action) => !action.outcome || (action.operation === 'turn-in' && Boolean(action.quest)),
          { message: 'An explicit outcome requires a fixed turn-in quest' },
        )
        .refine((action) => Boolean(action.quest) !== Boolean(action.journal), {
          message: 'Choose a fixed quest or a quest journal',
        }),
      z.object({
        type: z.literal('item-use'),
        inventory: gameIdSchema,
        combat: gameIdSchema.optional(),
      }),
      z.object({
        type: z.literal('inventory-action'),
        inventory: gameIdSchema,
        action: gameIdSchema,
      }),
      z.object({
        type: z.literal('nearby-action'),
        nearby: gameIdSchema,
        action: gameIdSchema,
      }),
      z.object({
        type: z.literal('equipment-action'),
        equipment: gameIdSchema,
        operation: z.enum(['equip', 'unequip']),
      }),
      z.object({
        type: z.literal('shop-action'),
        shop: gameIdSchema,
        operation: z.enum(['buy', 'sell']),
      }),
      z.object({
        type: z.literal('combat-action'),
        combat: gameIdSchema,
        command: combatCommandSchema,
      }),
    ]),
    inputBinding: z.object({ context: gameIdSchema, input: gameIdSchema }).optional(),
  })
  .refine((slot) => Boolean(slot.label || slot.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const actionBarComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('action-bar'),
    ...componentLayoutFields,
    slots: z.record(z.string().regex(/^(?:[1-9]|1[0-5])$/), actionBarSlotSchema),
  })
  .superRefine((bar, context) => {
    const bindings = new Set<string>()

    for (const [id, slot] of Object.entries(bar.slots)) {
      if (!slot.inputBinding) continue
      const key = JSON.stringify([slot.inputBinding.context, slot.inputBinding.input])

      if (bindings.has(key))
        context.addIssue({
          code: 'custom',
          path: ['slots', id, 'inputBinding'],
          message: 'Input bindings must be unique within an action bar',
        })
      bindings.add(key)
    }
  })

export type ActionBarComponentDefinition = z.infer<typeof actionBarComponentSchema>

export type ActionBarSlotDefinition = z.infer<typeof actionBarSlotSchema>

/** Observes action presentation within its scene without changing gameplay state. */
export const actionInfoComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('action-info'),
  ...componentLayoutFields,
  label: z.string().default('Action information'),
  labelKey: translationKeySchema.optional(),
  emptyText: z.string().default('Hover over or focus an action to see its description.'),
  emptyTextKey: translationKeySchema.optional(),
})

export type ActionInfoComponentDefinition = z.infer<typeof actionInfoComponentSchema>

export const messageHistoryComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('message-history'),
  ...componentLayoutFields,
  label: z.string().trim().default('Message history'),
  labelKey: translationKeySchema.optional(),
})

export type MessageHistoryComponentDefinition = z.infer<typeof messageHistoryComponentSchema>

export const languageSelectComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('language-select'),
    ...componentLayoutFields,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const characterViewComponentSchema = z.strictObject({
  id: gameIdSchema,
  type: z.literal('character-view'),
  ...componentLayoutFields,
  character: assetIdSchema,
  view: characterViewKindSchema,
  label: z.string().trim().min(1),
  labelKey: translationKeySchema.optional(),
})

export const graphicComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('graphic'),
  ...componentLayoutFields,
  visual: assetIdSchema,
  alt: z.string(),
  altKey: translationKeySchema.optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
  appearance: graphicAppearanceSchema.prefault({}),
})

export const backgroundImageComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('background-image'),
  ...componentLayoutFields,
  image: assetIdSchema,
  fit: z.enum(['contain', 'cover']).default('cover'),
})

export const mapViewComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('map-view'),
    ...componentLayoutFields,
    map: gameIdSchema,
    followPlayer: z.boolean().optional(),
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    viewport: mapViewportSchema,
    playerSpawn: mapPositionSchema.optional(),
    interactive: z.boolean().optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const inventoryComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('inventory'),
    ...componentLayoutFields,
    label: z.string().trim().default('Inventory'),
    labelKey: translationKeySchema.optional(),
    owners: z
      .array(gameIdSchema)
      .min(1)
      .refine((owners) => new Set(owners).size === owners.length),
    // Preserve unrelated extension fields while rejecting retired inventory mappings.
    previews: z.never({ error: 'Use characterPreviews to reference named characters' }).optional(),
    characterPreviews: z.record(gameIdSchema, assetIdSchema).default({}),
    readOnly: z.boolean().optional(),
    descriptionTarget: gameIdSchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type InventoryComponentDefinition = z.infer<typeof inventoryComponentSchema>

export const craftingComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('crafting'),
  ...componentLayoutFields,
  label: z.string().trim().min(1).default('Crafting'),
  labelKey: translationKeySchema.optional(),
  owner: gameIdSchema,
})

export type CraftingComponentDefinition = z.infer<typeof craftingComponentSchema>

export const itemDetailsComponentSchema = z.object({
  equipment: gameIdSchema.optional(),
  showCombatStats: z.boolean().optional(),
  id: gameIdSchema,
  type: z.literal('item-details'),
  ...componentLayoutFields,
  label: z.string().default('Item details'),
  labelKey: translationKeySchema.optional(),
  inventory: gameIdSchema,
  emptyText: z.string().default('Select an item'),
  emptyTextKey: translationKeySchema.optional(),
})

export const equipmentComponentSchema = z.object({
  showCombatStats: z.boolean().optional(),
  id: gameIdSchema,
  type: z.literal('equipment'),
  ...componentLayoutFields,
  label: z.string().default('Equipment'),
  labelKey: translationKeySchema.optional(),
  inventory: gameIdSchema,
  owner: gameIdSchema,
  columns: z.number().int().min(1).max(12).default(3),
  order: z
    .array(gameIdSchema)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'Equipment slot order must be unique'),
  readOnly: z.boolean().default(false),
})

export type ItemDetailsComponentDefinition = z.infer<typeof itemDetailsComponentSchema>

export type EquipmentComponentDefinition = z.infer<typeof equipmentComponentSchema>

export const shopMessageSchema = z.enum([
  'bought',
  'sold',
  'selectItem',
  'unavailable',
  'invalidAmount',
  'insufficientPlayerFunds',
  'insufficientMerchantFunds',
  'equipped',
  'containerNotEmpty',
  'reserved',
  'wrongOwner',
  'unsupportedState',
  'stale',
])

export type ShopMessage = z.infer<typeof shopMessageSchema>

export const shopBalanceSchema = gameBindingSchema.safeExtend({
  source: z.literal('game.state'),
  path: z
    .array(gameIdSchema.refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id)))
    .min(1),
})

export const shopPriceSchema = z.union([z.number().int().nonnegative().safe(), gameBindingSchema])

export const shopComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('shop'),
    ...componentLayoutFields,
    label: z.string().trim().default('Shop'),
    labelKey: translationKeySchema.optional(),
    playerInventory: gameIdSchema,
    merchantInventory: gameIdSchema,
    currency: z.string().trim().default('Gold'),
    currencyKey: translationKeySchema.optional(),
    playerBalance: shopBalanceSchema,
    merchantFunds: z.discriminatedUnion('type', [
      z.object({ type: z.literal('unlimited') }),
      z.object({ type: z.literal('finite'), balance: shopBalanceSchema }),
    ]),
    prices: z.record(
      gameIdSchema,
      z.object({ buy: shopPriceSchema.optional(), sell: shopPriceSchema.optional() }),
    ),
    feedbackTarget: gameIdSchema.optional(),
    messages: z
      .object({
        bought: z.string().default('Bought {item} for {price} {currency}.'),
        sold: z.string().default('Sold {item} for {price} {currency}.'),
        selectItem: z.string().default('Select an item to trade.'),
        unavailable: z.string().default('This item is not available for this trade.'),
        invalidAmount: z
          .string()
          .default(
            'Prices and balances must be nonnegative whole numbers within the supported range.',
          ),
        insufficientPlayerFunds: z.string().default('You do not have enough currency.'),
        insufficientMerchantFunds: z
          .string()
          .default('The merchant does not have enough currency.'),
        equipped: z.string().default('Unequip this item first.'),
        containerNotEmpty: z.string().default('Empty this container first.'),
        reserved: z.string().default('This item is reserved by a combat plan.'),
        wrongOwner: z.string().default('The item no longer belongs to this participant.'),
        unsupportedState: z.string().default('Trading is unavailable for this game state.'),
        stale: z.string().default('The trade changed. Select the item again.'),
      })
      .prefault({}),
    messageKeys: z.partialRecord(shopMessageSchema, translationKeySchema).default({}),
  })
  .superRefine((shop, context) => {
    if (!shop.label && !shop.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A shop label or translation is required',
      })

    if (!shop.currency && !shop.currencyKey)
      context.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'A currency label or translation is required',
      })

    if (
      shop.merchantFunds.type === 'finite' &&
      JSON.stringify(shop.playerBalance.path) === JSON.stringify(shop.merchantFunds.balance.path)
    )
      context.addIssue({
        code: 'custom',
        path: ['merchantFunds'],
        message: 'Player and merchant balance fields must be distinct',
      })
  })

export type ShopComponentDefinition = z.infer<typeof shopComponentSchema>

export const nearbyEntrySchema = z
  .object({
    kind: z.enum(['character', 'object']),
    dialogue: gameIdSchema.optional(),
    conversationId: gameIdSchema.optional(),
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    description: z.string().default(''),
    descriptionKey: translationKeySchema.optional(),
    visibleWhen: gameBindingSchema.optional(),
    actions: z.record(gameIdSchema, requestActionSchema.omit({ type: true })).default({}),
  })
  .refine((entry) => Boolean(entry.label || entry.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const nearbyComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('nearby'),
    ...componentLayoutFields,
    label: z.string().trim().default('Nearby'),
    labelKey: translationKeySchema.optional(),
    descriptionTarget: gameIdSchema,
    entries: z.record(gameIdSchema, nearbyEntrySchema),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type NearbyComponentDefinition = z.infer<typeof nearbyComponentSchema>

export type NearbyEntryDefinition = z.infer<typeof nearbyEntrySchema>

export const statusNumberSchema = z.union([z.number().finite(), gameBindingSchema])
export const statusValueSchema = z.union([z.string(), z.number().finite(), gameBindingSchema])

const statusLabel = {
  label: z.string().trim().default(''),
  labelKey: translationKeySchema.optional(),
}

export const statusRowSchema = z
  .discriminatedUnion('type', [
    z.object({
      id: gameIdSchema,
      type: z.literal('value'),
      ...statusLabel,
      value: statusValueSchema,
      visibleWhen: gameBindingSchema.optional(),
    }),
    z.object({
      id: gameIdSchema,
      type: z.literal('bar'),
      ...statusLabel,
      value: statusNumberSchema,
      maximum: statusNumberSchema,
      color: colorSchema.optional(),
      visibleWhen: gameBindingSchema.optional(),
    }),
  ])
  .refine((row) => Boolean(row.label || row.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const statusEffectSchema = z
  .object({
    id: gameIdSchema,
    ...statusLabel,
    description: z.string().default(''),
    descriptionKey: translationKeySchema.optional(),
    icon: assetIdSchema.optional(),
    visibleWhen: gameBindingSchema.optional(),
  })
  .refine((effect) => Boolean(effect.label || effect.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const statusPanelComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('status-panel'),
    ...componentLayoutFields,
    label: z.string().trim().default('Status'),
    labelKey: translationKeySchema.optional(),
    name: z.string().default(''),
    nameKey: translationKeySchema.optional(),
    portrait: characterReferenceSchema.optional(),
    rows: z.array(statusRowSchema).default([]),
    effects: z.array(statusEffectSchema).default([]),
  })
  .superRefine((panel, context) => {
    if (!panel.label && !panel.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A label or labelKey is required',
      })

    for (const section of ['rows', 'effects'] as const) {
      const ids = new Set<string>()
      panel[section].forEach((entry, index) => {
        if (ids.has(entry.id))
          context.addIssue({
            code: 'custom',
            path: [section, index, 'id'],
            message: 'IDs must be unique within each status section',
          })
        ids.add(entry.id)
      })
    }
  })

export type StatusPanelComponentDefinition = z.infer<typeof statusPanelComponentSchema>

export const formComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('form'),
  form: gameIdSchema,
  submitLabel: z.string().trim().min(1).default('Submit'),
  submitLabelKey: translationKeySchema.optional(),
  cancelLabel: z.string().trim().min(1).default('Cancel'),
  cancelLabelKey: translationKeySchema.optional(),
  action: gameIdSchema.optional(),
  ...componentLayoutFields,
  label: z.string().trim().min(1).default('Form'),
  labelKey: translationKeySchema.optional(),
  continueScene: gameIdSchema.optional(),
  backScene: gameIdSchema.optional(),
})

export const characterSheetComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('character-sheet'),
    ...componentLayoutFields,
    label: z.string().trim().min(1).default('Character'),
    labelKey: translationKeySchema.optional(),
    rows: z.array(statusRowSchema).default([]),
  })
  .superRefine(({ rows }, context) => {
    if (new Set(rows.map(({ id }) => id)).size !== rows.length)
      context.addIssue({ code: 'custom', path: ['rows'], message: 'Stat rows require unique IDs' })
  })

export type StatusRowDefinition = z.infer<typeof statusRowSchema>

export type StatusEffectDefinition = z.infer<typeof statusEffectSchema>

export type StatusValueDefinition = z.infer<typeof statusValueSchema>

export const questLogComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('quest-log'),
  ...componentLayoutFields,
  label: z.string().default('Quests'),
  labelKey: translationKeySchema.optional(),
  quests: z.array(gameIdSchema).optional(),
  statuses: z.array(questStatusSchema).default(['active', 'ready', 'completed']),
  textTarget: gameIdSchema.optional(),
})

export type QuestLogComponentDefinition = z.infer<typeof questLogComponentSchema>

export const sceneComponentSchema = z.discriminatedUnion('type', [
  saveSlotsComponentSchema,
  saveStatusComponentSchema,
  savePointComponentSchema,
  combatComponentSchema,
  questLogComponentSchema,
  characterProgressionComponentSchema,
  textComponentSchema,
  buttonComponentSchema,
  languageSelectComponentSchema,
  graphicComponentSchema,
  characterViewComponentSchema,
  backgroundImageComponentSchema,
  mapViewComponentSchema,
  inventoryComponentSchema,
  craftingComponentSchema,
  actionBarComponentSchema,
  actionInfoComponentSchema,
  messageHistoryComponentSchema,
  nearbyComponentSchema,
  statusPanelComponentSchema,
  formComponentSchema,
  characterSheetComponentSchema,
  itemDetailsComponentSchema,
  equipmentComponentSchema,
  shopComponentSchema,
])

export const sceneSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().default(''),
    description: z.string().default(''),
    titleKey: translationKeySchema.optional(),
    descriptionKey: translationKeySchema.optional(),
    type: z.enum(['stand-alone', 'game']),
    screen: z.object({
      type: z.literal('grid'),
      grid: z.object({
        rows: z.number().int().positive(),
        columns: z.number().int().positive(),
      }),
    }),
    components: z.array(sceneComponentSchema),
  })
  .superRefine((scene, context) => {
    const { rows, columns } = scene.screen.grid

    if (!scene.title && !scene.titleKey)
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'A title or titleKey is required',
      })
    const ids = new Set<string>()
    let hasActionBar = false
    let hasShop = false
    let hasCombat = false
    const descriptionTargets = new Set<string>()
    scene.components.forEach((component, index) => {
      if (
        component.type === 'map-view' &&
        component.followPlayer &&
        (scene.type !== 'game' || !component.playerSpawn || component.interactive === false)
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'followPlayer'],
          message: 'Following the player requires an interactive game map view with a player spawn',
        })

      if (component.type === 'save-point') {
        const target =
          component.location &&
          scene.components.find((entry) => entry.id === component.location?.mapView)

        if (
          scene.type !== 'game' ||
          (component.location &&
            (target?.type !== 'map-view' || !target.playerSpawn || target.interactive === false))
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Save points require a game scene and an interactive map view with a player',
          })
      }

      if (
        component.type === 'character-progression' &&
        (scene.type !== 'game' ||
          (component.textTarget &&
            !scene.components.some(
              (entry) => entry.type === 'text' && entry.id === component.textTarget,
            )))
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index],
          message: 'Character progression requires a game scene and a same-scene text target',
        })

      if (component.type === 'combat') {
        if (hasCombat || scene.type !== 'game')
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Allow one combat component per game scene',
          })
        hasCombat = true

        if (
          component.textTarget &&
          !scene.components.some(
            (entry) => entry.type === 'text' && entry.id === component.textTarget,
          )
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'textTarget'],
            message: 'Select a text component in the same scene',
          })
      }

      if (component.type === 'shop') {
        if (hasShop || scene.type !== 'game')
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Allow one shop per game scene',
          })
        hasShop = true
        const player = scene.components.find((entry) => entry.id === component.playerInventory)
        const merchant = scene.components.find((entry) => entry.id === component.merchantInventory)

        if (
          player?.type !== 'inventory' ||
          merchant?.type !== 'inventory' ||
          player.readOnly !== true ||
          merchant.readOnly !== true ||
          player.owners.length !== 1 ||
          merchant.owners.length !== 1 ||
          player.owners[0] === merchant.owners[0]
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Shops require read-only inventory panels with one distinct owner each',
          })

        if (
          component.feedbackTarget &&
          !scene.components.some(
            (entry) => entry.type === 'text' && entry.id === component.feedbackTarget,
          )
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'feedbackTarget'],
            message: 'Select a text component in the same scene',
          })
      }

      if (component.type === 'item-details' || component.type === 'equipment') {
        if (
          component.type === 'item-details' &&
          component.equipment &&
          !scene.components.some(
            (entry) =>
              entry.type === 'equipment' &&
              entry.id === component.equipment &&
              entry.inventory === component.inventory,
          )
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'equipment'],
            message: 'Comparison equipment must use the same inventory panel',
          })
        const source = scene.components.find((entry) => entry.id === component.inventory)

        if (scene.type !== 'game' || source?.type !== 'inventory')
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'inventory'],
            message: 'Select an inventory panel in the same game scene',
          })

        if (
          component.type === 'equipment' &&
          source?.type === 'inventory' &&
          !source.owners.includes(component.owner)
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'owner'],
            message: 'Equipment owner must be shown in the source inventory',
          })
      }

      if (
        component.type === 'inventory' &&
        component.descriptionTarget &&
        !scene.components.some(
          (entry) => entry.type === 'text' && entry.id === component.descriptionTarget,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'descriptionTarget'],
          message: 'Select a text component in the same scene',
        })

      if (component.type === 'status-panel' && scene.type !== 'game')
        context.addIssue({
          code: 'custom',
          path: ['components', index],
          message: 'Status panels require a game scene',
        })

      if (component.type === 'nearby') {
        if (scene.type !== 'game')
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Nearby panels require a game scene',
          })

        if (
          !scene.components.some(
            (entry) => entry.id === component.descriptionTarget && entry.type === 'text',
          ) ||
          descriptionTargets.has(component.descriptionTarget)
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'descriptionTarget'],
            message:
              'Choose a text component in this scene that is not already used by another nearby panel',
          })
        descriptionTargets.add(component.descriptionTarget)
      }

      const movementActions =
        component.type === 'action-bar'
          ? Object.entries(component.slots).map(([id, slot]) => ({
              action: slot.action,
              path: ['components', index, 'slots', id, 'action'],
            }))
          : component.type === 'button' && component.action
            ? [{ action: component.action, path: ['components', index, 'action'] }]
            : []

      for (const { action, path } of movementActions) {
        if (action.type !== 'move-map' && action.type !== 'interact-map') continue
        const map = scene.components.find((entry) => entry.id === action.mapView)

        if (
          scene.type !== 'game' ||
          map?.type !== 'map-view' ||
          !map.playerSpawn ||
          map.interactive === false
        )
          context.addIssue({
            code: 'custom',
            path: [...path, 'mapView'],
            message:
              'Map movement requires an interactive map view with a player spawn in the same game scene',
          })
      }

      if (component.type === 'action-bar') {
        if (scene.type !== 'game' || hasActionBar)
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Only one action bar is allowed per game scene',
          })
        hasActionBar = true
      }

      if (
        scene.type === 'stand-alone' &&
        component.type === 'button' &&
        component.action?.type === 'request-action'
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'action'],
          message: 'Action requests require a game scene',
        })

      if (scene.type === 'stand-alone' && component.type === 'inventory')
        context.addIssue({
          code: 'custom',
          path: ['components', index],
          message: 'Inventory panels require a game scene',
        })

      if (scene.type === 'stand-alone' && component.type === 'crafting')
        context.addIssue({
          code: 'custom',
          path: ['components', index],
          message: 'Crafting panels require a game scene',
        })

      if (
        scene.type === 'stand-alone' &&
        component.type === 'graphic' &&
        graphicHasBindings(component.appearance)
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'appearance'],
          message: 'Game bindings require a game scene',
        })

      if (
        scene.type === 'stand-alone' &&
        component.type === 'text' &&
        Object.keys(component.bindings ?? {}).length > 0
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'bindings'],
          message: 'Game bindings require a game scene',
        })

      if (ids.has(component.id))
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'id'],
          message: 'Component IDs must be unique within a scene',
        })
      ids.add(component.id)
      const { row, column, rowSpan, columnSpan } = component.placement

      if (row > rows || rowSpan - 1 > rows - row)
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'placement'],
          message: 'Component exceeds the scene grid rows',
        })

      if (column > columns || columnSpan - 1 > columns - column)
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'placement'],
          message: 'Component exceeds the scene grid columns',
        })
    })
  })

export type SceneDefinition = z.infer<typeof sceneSchema>

export type SceneComponentDefinition = z.infer<typeof sceneComponentSchema>

export type GraphicComponentDefinition = z.infer<typeof graphicComponentSchema>

export type BackgroundImageComponentDefinition = z.infer<typeof backgroundImageComponentSchema>

export type MapViewComponentDefinition = z.infer<typeof mapViewComponentSchema>

export type TextComponentDefinition = z.infer<typeof textComponentSchema>

export type ButtonComponentDefinition = z.infer<typeof buttonComponentSchema>

export type LanguageSelectComponentDefinition = z.infer<typeof languageSelectComponentSchema>

export type ButtonActionDefinition = z.infer<typeof buttonActionSchema>

export type GridPlacementDefinition = z.infer<typeof gridPlacementSchema>
