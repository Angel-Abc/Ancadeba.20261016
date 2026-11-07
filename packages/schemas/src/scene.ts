import { z } from 'zod'
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
import { inventoryPreviewSchema } from './inventory.js'
import { combatCommandSchema } from './combat.js'

export const gridPlacementSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  rowSpan: z.number().int().positive().default(1),
  columnSpan: z.number().int().positive().default(1),
})

export const characterProgressionComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('character-progression'),
  profile: gameIdSchema,
  textTarget: gameIdSchema.optional(),
  placement: gridPlacementSchema,
})

export const combatComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('combat'),
  placement: gridPlacementSchema,
  encounter: gameIdSchema,
  textTarget: gameIdSchema.optional(),
  lootInventory: gameIdSchema.optional(),
})

export const textComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('text'),
    placement: gridPlacementSchema,
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

export const buttonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-game'), scene: gameIdSchema }),
  z.object({ type: z.literal('enter-scene'), scene: gameIdSchema }),
  requestActionSchema,
  z.object({
    type: z.literal('move-map'),
    mapView: gameIdSchema,
    direction: z.enum(['north', 'east', 'south', 'west']),
  }),
])

export const buttonComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('button'),
    placement: gridPlacementSchema,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    /** Buttons without an action are rendered disabled. */
    action: buttonActionSchema.optional(),
  })
  .refine((button) => Boolean(button.label || button.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const actionBarSlotSchema = z
  .object({
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    action: z.discriminatedUnion('type', [
      ...buttonActionSchema.options,
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
    placement: gridPlacementSchema,
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

export const languageSelectComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('language-select'),
    placement: gridPlacementSchema,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const graphicComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('graphic'),
  placement: gridPlacementSchema,
  visual: assetIdSchema,
  alt: z.string(),
  altKey: translationKeySchema.optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
  appearance: graphicAppearanceSchema.default({ colors: {}, visible: true, slots: {} }),
})

export const mapViewComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('map-view'),
    placement: gridPlacementSchema,
    map: gameIdSchema,
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
    placement: gridPlacementSchema,
    label: z.string().trim().default('Inventory'),
    labelKey: translationKeySchema.optional(),
    owners: z
      .array(gameIdSchema)
      .min(1)
      .refine((owners) => new Set(owners).size === owners.length),
    previews: z.record(gameIdSchema, inventoryPreviewSchema).default({}),
    readOnly: z.boolean().optional(),
    descriptionTarget: gameIdSchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type InventoryComponentDefinition = z.infer<typeof inventoryComponentSchema>

export const itemDetailsComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('item-details'),
  placement: gridPlacementSchema,
  label: z.string().default('Item details'),
  labelKey: translationKeySchema.optional(),
  inventory: gameIdSchema,
  emptyText: z.string().default('Select an item'),
  emptyTextKey: translationKeySchema.optional(),
})

export const equipmentComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('equipment'),
  placement: gridPlacementSchema,
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
    placement: gridPlacementSchema,
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
    placement: gridPlacementSchema,
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
    }),
    z.object({
      id: gameIdSchema,
      type: z.literal('bar'),
      ...statusLabel,
      value: statusNumberSchema,
      maximum: statusNumberSchema,
      color: colorSchema.optional(),
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
    placement: gridPlacementSchema,
    label: z.string().trim().default('Status'),
    labelKey: translationKeySchema.optional(),
    name: z.string().default(''),
    nameKey: translationKeySchema.optional(),
    portrait: assetIdSchema.optional(),
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

export type StatusRowDefinition = z.infer<typeof statusRowSchema>

export type StatusEffectDefinition = z.infer<typeof statusEffectSchema>

export type StatusValueDefinition = z.infer<typeof statusValueSchema>

export const sceneComponentSchema = z.discriminatedUnion('type', [
  combatComponentSchema,
  characterProgressionComponentSchema,
  textComponentSchema,
  buttonComponentSchema,
  languageSelectComponentSchema,
  graphicComponentSchema,
  mapViewComponentSchema,
  inventoryComponentSchema,
  actionBarComponentSchema,
  nearbyComponentSchema,
  statusPanelComponentSchema,
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
        compactColumns: z.array(z.number().int().positive()).optional(),
      }),
    }),
    components: z.array(sceneComponentSchema),
  })
  .superRefine((scene, context) => {
    const { rows, columns, compactColumns } = scene.screen.grid

    if (compactColumns && compactColumns.length !== columns)
      context.addIssue({
        code: 'custom',
        path: ['screen', 'grid', 'compactColumns'],
        message: 'Compact column weights must match the number of grid columns',
      })

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
        if (action.type !== 'move-map') continue
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

export type MapViewComponentDefinition = z.infer<typeof mapViewComponentSchema>

export type TextComponentDefinition = z.infer<typeof textComponentSchema>

export type ButtonComponentDefinition = z.infer<typeof buttonComponentSchema>

export type LanguageSelectComponentDefinition = z.infer<typeof languageSelectComponentSchema>

export type ButtonActionDefinition = z.infer<typeof buttonActionSchema>

export type GridPlacementDefinition = z.infer<typeof gridPlacementSchema>
