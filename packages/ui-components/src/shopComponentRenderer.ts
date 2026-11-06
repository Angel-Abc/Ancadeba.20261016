import type { ShopComponentDefinition } from '@ancadeba/schemas'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

export class ShopComponentRenderer implements IComponentRenderer<ShopComponentDefinition> {
  render(component: ShopComponentDefinition, context: ComponentRenderContext): RenderedComponent {
    const { document, scene } = context
    const game = scene?.type === 'game' ? scene.game : undefined
    const root = document.createElement('section')
    root.className = 'ancadeba-shop'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    const balances = document.createElement('p')
    balances.className = 'ancadeba-shop-balances'
    const quote = document.createElement('p')
    quote.className = 'ancadeba-shop-quote'
    const reason = document.createElement('p')
    reason.className = 'ancadeba-shop-reason'
    const feedback = document.createElement('p')
    feedback.setAttribute('role', 'status')
    root.append(title, balances, quote, reason, feedback)

    const update = () => {
      const current = scene && game?.trading?.quote(scene, component.id)
      const funds = scene && game?.trading?.balances(scene, component.id)
      const player = scene?.data.components.find((entry) => entry.id === component.playerInventory)

      const merchant = scene?.data.components.find(
        (entry) => entry.id === component.merchantInventory,
      )

      const ownerLabel = (panel: typeof player) =>
        panel?.type === 'inventory'
          ? (game?.data.inventory?.owners[panel.owners[0]!]?.label ?? '')
          : ''

      balances.textContent = `${ownerLabel(player)}: ${funds?.player ?? '—'} ${component.currency} · ${ownerLabel(merchant)}: ${funds?.merchant === 'unlimited' ? '∞' : (funds?.merchant ?? '—')} ${component.currency}`
      const item = current && game?.inventory?.snapshot.find((item) => item.id === current.item)
      const label = item && game?.data.inventory?.itemTypes[item.itemType]?.label
      quote.textContent = current
        ? `${label ?? current.item}: ${current.amount ?? '—'} ${component.currency}`
        : component.messages.selectItem
      reason.textContent = current?.reason ? component.messages[current.reason] : ''
      feedback.textContent = scene ? (game?.trading?.feedback(scene, component.id) ?? '') : ''
    }

    update()
    const unsubscribe = game?.trading?.subscribeChanges(update)

    return {
      element: root,
      dispose() {
        unsubscribe?.()
        root.remove()
      },
    }
  }
}
