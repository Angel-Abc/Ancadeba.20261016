import { selectedItemDetails } from '@ancadeba/game-runtime'
import { inventoryColors, type ItemDetailsComponentDefinition } from '@ancadeba/schemas'
import { GraphicComponentRenderer, type RenderedGraphic } from './graphicComponentRenderer.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

export class ItemDetailsComponentRenderer implements IComponentRenderer<ItemDetailsComponentDefinition> {
  constructor(private readonly graphics = new GraphicComponentRenderer()) {}

  render(
    component: ItemDetailsComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, scene } = context
    const root = document.createElement('section')
    root.className = 'ancadeba-item-details'
    root.setAttribute('aria-label', component.label)
    let graphic: RenderedGraphic | undefined

    const update = () => {
      graphic?.dispose()
      graphic = undefined
      const title = document.createElement('h2')
      title.textContent = component.label
      root.replaceChildren(title)
      const details = scene && selectedItemDetails(scene, component.inventory)

      if (!details) {
        root.dataset.bindingStatus = 'resolved'
        root.title = ''
        const empty = document.createElement('p')
        empty.textContent = component.emptyText
        root.append(empty)

        return
      }

      const { item, type, location, properties } = details
      const visual = type.artwork ?? type.icon

      if (visual && context.assets) {
        const asset = context.assets.images[visual] ?? context.assets.parts[visual]
        graphic = this.graphics.render(
          {
            id: component.id,
            type: 'graphic',
            placement: component.placement,
            visual,
            alt: type.label,
            fit: 'contain',
            appearance: {
              visible: true,
              slots: {},
              colors: asset ? inventoryColors(item.colors, asset) : {},
            },
          },
          { ...context, bindings: undefined },
        )
        graphic.element.classList.add('ancadeba-item-artwork')
        root.append(graphic.element)
      }

      const name = document.createElement('h3')
      name.textContent = type.label
      const description = document.createElement('p')
      description.textContent = type.description
      const values = document.createElement('dl')

      for (const property of properties) {
        const label = document.createElement('dt')
        label.textContent = property.label
        const value = document.createElement('dd')
        value.textContent = String(property.value ?? '—')
        values.append(label, value)
      }

      const placement = document.createElement('p')
      placement.className = 'ancadeba-item-location'
      placement.textContent = location
      root.append(name, description, values, placement)

      if (details.useDetails) {
        const use = document.createElement('p')
        use.textContent = details.useDetails
        root.append(use)
      }

      if (component.showCombatStats && scene?.type === 'game') {
        const effects = document.createElement('dl')

        const labels = Object.values(scene.game.data.inventory?.owners ?? {}).find(
          (owner) => owner.combatStats,
        )?.combatStats?.messages

        for (const stat of combatStatNames)
          if (type.combatBonuses?.[stat]) {
            const label = document.createElement('dt'),
              value = document.createElement('dd')

            label.textContent = labels?.[stat] ?? stat
            value.textContent = `+${type.combatBonuses[stat]}`
            effects.append(label, value)
          }

        root.append(effects)

        const equipment = scene.data.components.find(
          (c) => c.id === component.equipment && c.type === 'equipment',
        )

        if (equipment?.type === 'equipment')
          root.append(equipmentStatsView(document, scene, equipment))
      }

      const issues = properties.flatMap((property) =>
        property.issue ? [`${property.id}: ${property.issue}`] : [],
      )

      root.dataset.bindingStatus = issues.length ? 'unresolved' : 'resolved'

      if (context.bindingMode === 'editor') root.title = issues.join('\n')
    }

    const cleanups: (() => void)[] = []

    try {
      update()

      if (scene?.type === 'game') {
        const itemUse = scene.game.itemUse?.subscribeChanges(update)

        if (itemUse) cleanups.push(itemUse)
        const selection = scene.game.inventorySelection?.subscribe(update)

        if (selection) cleanups.push(selection)
        const equipment = scene.game.equipment?.subscribe(update)

        if (equipment) cleanups.push(equipment)
      }

      const inventory = context.inventory?.subscribeChanges(update)
      const bindings = context.bindings?.subscribeChanges(update)

      if (inventory) cleanups.push(inventory)

      if (bindings) cleanups.push(bindings)
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()
      graphic?.dispose()
      root.remove()
      throw error
    }

    return {
      element: root,
      dispose() {
        for (const cleanup of cleanups.reverse()) cleanup()
        graphic?.dispose()
        root.remove()
      },
    }
  }
}

import { equipmentStatsView } from './equipmentStatsView.js'
import { combatStatNames } from '@ancadeba/schemas'
