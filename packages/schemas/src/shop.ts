import type { ShopComponentDefinition } from './scene.js'
import type { InventoryDefinition } from './inventory.js'
import type { GameRulesDefinition } from './rules.js'
import type { GameBindingDefinition } from './bindings.js'

export function shopBindings(
  shop: ShopComponentDefinition,
): { binding: GameBindingDefinition; balance: boolean }[] {
  return [
    { binding: shop.playerBalance, balance: true },
    ...(shop.merchantFunds.type === 'finite'
      ? [{ binding: shop.merchantFunds.balance, balance: true }]
      : []),
    ...Object.values(shop.prices).flatMap((prices) =>
      [prices.buy, prices.sell].flatMap((value) =>
        typeof value === 'object' ? [{ binding: value, balance: false }] : [],
      ),
    ),
  ]
}

export function shopIssues(
  shop: ShopComponentDefinition,
  inventory?: InventoryDefinition,
  rules?: GameRulesDefinition,
): { path: (string | number)[]; message: string }[] {
  const issues: ReturnType<typeof shopIssues> = []

  for (const type of Object.keys(shop.prices))
    if (!inventory || !Object.hasOwn(inventory.itemTypes, type))
      issues.push({ path: ['prices', type], message: `Unknown shop item type: ${type}` })

  for (const { binding, balance } of shopBindings(shop)) {
    if (binding.source !== 'game.state') continue

    const field = rules?.state.find(
      (field) => JSON.stringify(field.path) === JSON.stringify(binding.path),
    )

    if (
      !field ||
      typeof field.value !== 'number' ||
      (balance && (!Number.isSafeInteger(field.value) || field.value < 0))
    )
      issues.push({
        path: [balance ? 'balances' : 'prices'],
        message: `Shop bindings require a declared numeric field${balance ? ' with a nonnegative whole-number balance' : ''}: ${binding.path.join('.')}`,
      })
  }

  return issues
}
