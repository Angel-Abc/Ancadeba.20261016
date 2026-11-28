import type { CraftingComponentDefinition } from '@ancadeba/schemas'
import { componentRuntimeText } from './runtimeText.js'
import type { ComponentRenderContext, IComponentRenderer } from './componentRendering.js'

export class CraftingComponentRenderer implements IComponentRenderer<CraftingComponentDefinition> {
  render(component: CraftingComponentDefinition, context: ComponentRenderContext) {
    const { document, inventory } = context
    const definition = context.localization?.current.inventory ?? context.inventoryDefinition
    const crafting = context.scene?.type === 'game' ? context.scene.game.crafting : undefined
    const t = componentRuntimeText(context)
    const root = document.createElement('section')
    root.className = 'ancadeba-crafting'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    root.append(title)

    if (!inventory || !definition || !crafting) {
      status.textContent = t('inventory.unavailable')
      root.append(status)

      return { element: root, dispose: () => root.remove() }
    }

    const rows = new Map<string, { counts: HTMLUListElement; button: HTMLButtonElement }>()
    let disposed = false

    const update = () => {
      for (const recipe of crafting.recipes(component.owner)) {
        let row = rows.get(recipe.output)
        const label = definition.itemTypes[recipe.output]!.label

        if (!row) {
          const group = document.createElement('section')
          const name = document.createElement('h3')
          name.textContent = label
          const counts = document.createElement('ul')
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = t('crafting.craft', { item: label })
          button.addEventListener('click', () => {
            if (disposed || context.scene?.disposed || button.disabled) return
            status.textContent = crafting.craft(component.owner, recipe.output)
              ? t('crafting.crafted', { item: label })
              : t('crafting.unavailable')
          })
          group.append(name, counts, button)
          root.append(group)
          row = { counts, button }
          rows.set(recipe.output, row)
        }

        row.button.disabled = !recipe.available
        row.counts.replaceChildren(
          ...recipe.ingredients.map(({ itemType, required, available }) => {
            const line = document.createElement('li')
            line.textContent = t('crafting.ingredient', {
              item: definition.itemTypes[itemType]!.label,
              required,
              available,
            })

            return line
          }),
        )
      }
    }

    update()

    if (!rows.size) status.textContent = t('crafting.empty')
    root.append(status)
    const unsubscribe = inventory.subscribeChanges(update)

    return {
      element: root,
      dispose() {
        disposed = true
        unsubscribe()
        root.remove()
      },
    }
  }
}
