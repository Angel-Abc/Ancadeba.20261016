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
  const { input, select, group, button, create, translation } = controls
  const keys = translationChoices(view)

  const existing = view.scenes
    .find((scene) => scene.id === sceneId)
    ?.components.some((component) => component.type === 'shop')

  const identity = input('Shop ID', shop.id, (value) => {
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
    placementFields.map(([key, label]) =>
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
    input('Shop title', shop.label, (value) => {
      shop.label = value
    }),
    translation('Shop title translation', shop.labelKey ?? '', keys, (value) => {
      shop.labelKey = value || undefined
    }),
    input('Currency label', shop.currency, (value) => {
      shop.currency = value
    }),
    translation('Currency translation', shop.currencyKey ?? '', keys, (value) => {
      shop.currencyKey = value || undefined
    }),
    balance('Player balance field', shop.playerBalance, (value) => {
      shop.playerBalance = value
    }),
    select('Merchant funds policy', shop.merchantFunds.type, ['finite', 'unlimited'], (value) => {
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
      balance('Merchant balance field', shop.merchantFunds.balance, (value) => {
        shop.merchantFunds = { type: 'finite', balance: value }
      }),
    )
  const scene = view.scenes.find((scene) => scene.id === sceneId)
  result.push(
    select(
      'Trade feedback text target',
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

  for (const [index, side] of ['Player', 'Merchant'].entries()) {
    const panel = panels[index]!
    const link = index === 0 ? 'playerInventory' : 'merchantInventory'
    result.push(
      group(
        `${side} inventory (saved read-only)`,
        select(
          `${side} inventory panel`,
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
        input(`${side} panel ID`, panel.id, (value) => {
          panel.id = value.trim()
          shop[link] = panel.id
        }),
        input(`${side} panel label`, panel.label, (value) => {
          panel.label = value
        }),
        select(
          `${side} owner`,
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
    const box = group(`Prices: ${id}`)

    for (const operation of ['buy', 'sell'] as const) {
      const value = prices[operation]

      const type =
        value === undefined ? 'disabled' : typeof value === 'object' ? 'binding' : 'fixed'

      box.append(
        select(
          `${humanizeCode(operation)} price source`,
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
            `${humanizeCode(operation)} amount`,
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
            `${humanizeCode(operation)} price binding`,
            JSON.stringify(value),
            bindings,
            (value) => {
              prices[operation] = gameBindingSchema.parse(JSON.parse(value))
            },
          ),
        )
    }

    box.append(
      button(`Remove prices for ${id}`, () => {
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
      'Add item prices',
      select(
        'Price item type',
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
        'Add prices',
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
  summary.textContent = 'Trade feedback and translations'
  messages.append(summary)

  for (const code of shopMessageSchema.options)
    messages.append(
      group(
        humanizeCode(code),
        input(`${humanizeCode(code)} message`, shop.messages[code], (value) => {
          shop.messages[code] = value
        }),
        translation(
          `${humanizeCode(code)} translation`,
          shop.messageKeys[code] ?? '',
          keys,
          (value) => {
            if (value) shop.messageKeys[code] = value
            else delete shop.messageKeys[code]
          },
        ),
      ),
    )
  result.push(messages, group('Shop placement', ...placement(shop)))

  return result
}
