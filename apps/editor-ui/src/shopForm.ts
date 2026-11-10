import type { ProjectView } from '@ancadeba/editor-core'
import {
  shopBalanceSchema,
  gameBindingSchema,
  shopMessageSchema,
  type ShopComponentDefinition,
  type InventoryComponentDefinition,
} from '@ancadeba/schemas'
import {
  humanizeCode,
  placementFields,
  type RuleFormControls,
  translationChoices,
} from './ruleFormControls.js'

export function shopForm(
  controls: RuleFormControls,
  view: ProjectView,
  sceneId: string,
  shop: ShopComponentDefinition,
  panels: InventoryComponentDefinition[],
  render: () => void,
): HTMLElement[] {
  const { input, select, group, button, create, translation, t } = controls
  const keys = translationChoices(view)

  const existing = view.scenes
    .find((scene) => scene.id === sceneId)
    ?.components.some((component) => component.type === 'shop')

  const identity = input(t('shops.id'), shop.id, (value) => {
    if (!existing) shop.id = value.trim()
  })

  identity.querySelector('input')!.readOnly = Boolean(existing)
  const fields = (view.rules?.state ?? []).filter((field) => typeof field.value === 'number')

  const bindings = fields.map(
    (field) =>
      [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
  )

  const balance = (
    title: string,
    value: typeof shop.playerBalance,
    change: (value: typeof shop.playerBalance) => void,
  ) =>
    select(title, JSON.stringify(value), bindings, (value) =>
      change(shopBalanceSchema.parse(JSON.parse(value))),
    )

  const placement = (component: ShopComponentDefinition | InventoryComponentDefinition) =>
    placementFields(t).map(([key, label]) =>
      input(
        label,
        String(component.placement[key]),
        (value) => {
          component.placement[key] = Number(value)
        },
        'number',
      ),
    )

  const result: HTMLElement[] = [
    identity,
    input(t('shops.title'), shop.label, (value) => {
      shop.label = value
    }),
    translation(t('shops.titleTranslation'), shop.labelKey ?? '', keys, (value) => {
      shop.labelKey = value || undefined
    }),
    input(t('shops.currency'), shop.currency, (value) => {
      shop.currency = value
    }),
    translation(t('shops.currencyTranslation'), shop.currencyKey ?? '', keys, (value) => {
      shop.currencyKey = value || undefined
    }),
    balance(t('shops.playerBalance'), shop.playerBalance, (value) => {
      shop.playerBalance = value
    }),
    select(t('shops.fundsPolicy'), shop.merchantFunds.type, ['finite', 'unlimited'], (value) => {
      shop.merchantFunds =
        value === 'finite'
          ? {
              type: 'finite',
              balance: {
                source: 'game.state',
                path: fields.find(
                  (field) => JSON.stringify(field.path) !== JSON.stringify(shop.playerBalance.path),
                )?.path ?? ['merchantGold'],
              },
            }
          : { type: 'unlimited' }
      render()
    }),
  ]

  if (shop.merchantFunds.type === 'finite')
    result.push(
      balance(t('shops.merchantBalance'), shop.merchantFunds.balance, (value) => {
        shop.merchantFunds = { type: 'finite', balance: value }
      }),
    )
  const scene = view.scenes.find((scene) => scene.id === sceneId)
  result.push(
    select(
      t('shops.feedbackTarget'),
      shop.feedbackTarget ?? '',
      [
        '',
        ...(scene?.components
          .filter((component) => component.type === 'text')
          .map((component) => component.id) ?? []),
      ],
      (value) => {
        shop.feedbackTarget = value || undefined
      },
    ),
  )

  for (const [index, side] of [t('form.player'), t('shops.merchant')].entries()) {
    const panel = panels[index]!
    const link = index === 0 ? 'playerInventory' : 'merchantInventory'
    result.push(
      group(
        t('shops.inventoryReadOnly', { side }),
        select(
          t('shops.inventoryPanel', { side }),
          panel.id,
          scene?.components
            .filter((component) => component.type === 'inventory')
            .map((component) => component.id) ?? [],
          (id) => {
            const source = scene?.components.find((component) => component.id === id)

            if (source?.type === 'inventory') {
              panels[index] = structuredClone({ ...source, readOnly: true })
              shop[link] = source.id
              render()
            }
          },
        ),
        input(t('shops.panelId', { side }), panel.id, (value) => {
          panel.id = value.trim()
          shop[link] = panel.id
        }),
        input(t('shops.panelLabel', { side }), panel.label, (value) => {
          panel.label = value
        }),
        select(
          t('shops.ownerOf', { side }),
          panel.owners[0] ?? '',
          Object.keys(view.inventory?.owners ?? {}),
          (owner) => {
            panel.owners = [owner]
            panel.previews = panel.previews[owner] ? { [owner]: panel.previews[owner] } : {}
            render()
          },
        ),
        ...placement(panel),
      ),
    )
  }

  for (const [id, prices] of Object.entries(shop.prices)) {
    const box = group(t('shops.prices', { id }))

    for (const operation of ['buy', 'sell'] as const) {
      const value = prices[operation]

      const type =
        value === undefined ? 'disabled' : typeof value === 'object' ? 'binding' : 'fixed'

      box.append(
        select(
          t('shops.priceSource', { operation: humanizeCode(operation) }),
          type,
          ['disabled', 'fixed', 'binding'],
          (type) => {
            if (type === 'disabled') delete prices[operation]
            else
              prices[operation] =
                type === 'fixed' ? 1 : { source: 'game.state', path: fields[0]?.path ?? ['price'] }
            render()
          },
        ),
      )

      if (typeof value === 'number')
        box.append(
          input(
            t('shops.amountOf', { operation: humanizeCode(operation) }),
            String(value),
            (value) => {
              prices[operation] = Number(value)
            },
            'number',
          ),
        )
      else if (value)
        box.append(
          select(
            t('shops.priceBinding', { operation: humanizeCode(operation) }),
            JSON.stringify(value),
            bindings,
            (value) => {
              prices[operation] = gameBindingSchema.parse(JSON.parse(value))
            },
          ),
        )
    }

    box.append(
      button(t('shops.removePrices', { id }), () => {
        delete shop.prices[id]
        controls.markEdited()
        render()
      }),
    )
    result.push(box)
  }

  let itemType =
    Object.keys(view.inventory?.itemTypes ?? {}).find((id) => !Object.hasOwn(shop.prices, id)) ?? ''

  result.push(
    group(
      t('shops.addItemPrices'),
      select(
        t('shops.priceItemType'),
        itemType,
        Object.keys(view.inventory?.itemTypes ?? {}).filter(
          (id) => !Object.hasOwn(shop.prices, id),
        ),
        (value) => {
          itemType = value
        },
        false,
      ),
      button(
        t('shops.addPrices'),
        () => {
          if (itemType) {
            shop.prices[itemType] = { buy: 1 }
            controls.markEdited()
            render()
          }
        },
        !itemType,
      ),
    ),
  )
  const messages = create('details')
  const summary = create('summary')
  summary.textContent = t('shops.feedback')
  messages.append(summary)

  for (const code of shopMessageSchema.options)
    messages.append(
      group(
        humanizeCode(code),
        input(t('shops.messageOf', { code: humanizeCode(code) }), shop.messages[code], (value) => {
          shop.messages[code] = value
        }),
        translation(
          t('shops.translationOf', { code: humanizeCode(code) }),
          shop.messageKeys[code] ?? '',
          keys,
          (value) => {
            if (value) shop.messageKeys[code] = value
            else delete shop.messageKeys[code]
          },
        ),
      ),
    )
  result.push(messages, group(t('shops.placement'), ...placement(shop)))

  return result
}
