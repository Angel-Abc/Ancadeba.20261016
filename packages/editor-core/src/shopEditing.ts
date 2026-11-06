import type { GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { object, EditorError } from './project.js'

export function editShop(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'scene.upsertShop' | 'scene.removeShop' }>,
): string[] {
  const file = `scenes/${command.sceneId}.json`
  const scene = object(documents[file])

  if (!game.scenes.includes(command.sceneId) || scene.type !== 'game')
    throw new EditorError(422, 'invalid_shop_scene', 'Select a game scene')
  const components = Array.isArray(scene.components) ? [...scene.components] : []
  const id = command.type === 'scene.upsertShop' ? command.component.id : command.componentId
  const index = components.findIndex((entry) => object(entry).id === id)
  const previous = object(components[index])

  if (index >= 0 && previous.type !== 'shop')
    throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

  if (command.type === 'scene.removeShop') {
    if (index < 0) throw new EditorError(404, 'shop_not_found', 'Shop does not exist')
    components.splice(index, 1)
  } else {
    const shop = command.component

    const next = {
      ...previous,
      ...shop,
      labelKey: shop.labelKey,
      currencyKey: shop.currencyKey,
      feedbackTarget: shop.feedbackTarget,
      placement: { ...object(previous.placement), ...shop.placement },
      playerBalance: {
        ...object(previous.playerBalance),
        ...shop.playerBalance,
        fallback: shop.playerBalance.fallback,
      },
      merchantFunds: {
        ...object(previous.merchantFunds),
        ...shop.merchantFunds,
        balance:
          shop.merchantFunds.type === 'finite'
            ? {
                ...object(object(previous.merchantFunds).balance),
                ...shop.merchantFunds.balance,
                fallback: shop.merchantFunds.balance.fallback,
              }
            : undefined,
      },
      messages: { ...object(previous.messages), ...shop.messages },
      messageKeys: { ...shop.messageKeys },
      prices: Object.fromEntries(
        Object.entries(shop.prices).map(([type, prices]) => {
          const old = object(object(previous.prices)[type])

          const price = (value: typeof prices.buy, previous: unknown) =>
            typeof value === 'object'
              ? { ...object(previous), ...value, fallback: value.fallback }
              : value

          return [
            type,
            { ...old, buy: price(prices.buy, old.buy), sell: price(prices.sell, old.sell) },
          ]
        }),
      ),
    }

    if (index < 0) components.push(next)
    else components[index] = next
    const ids = new Set<string>()

    for (const panel of command.panels ?? []) {
      if (ids.has(panel.id) || ![shop.playerInventory, shop.merchantInventory].includes(panel.id))
        throw new EditorError(
          422,
          'invalid_shop_panels',
          'Only provide the two distinct linked inventory panels',
        )
      ids.add(panel.id)
      const index = components.findIndex((entry) => object(entry).id === panel.id)
      const previous = object(components[index])

      if (index >= 0 && previous.type !== 'inventory')
        throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

      const next = {
        ...previous,
        ...panel,
        labelKey: panel.labelKey,
        descriptionTarget: panel.descriptionTarget,
        placement: { ...object(previous.placement), ...panel.placement },
        previews: Object.fromEntries(
          Object.entries(panel.previews).map(([owner, preview]) => [
            owner,
            { ...object(object(previous.previews)[owner]), ...preview },
          ]),
        ),
      }

      if (index < 0) components.push(next)
      else components[index] = next
    }
  }

  documents[file] = { ...scene, components }

  return [file]
}
