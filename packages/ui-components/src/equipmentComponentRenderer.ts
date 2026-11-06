import {
  inventoryColors,
  inventoryIcon,
  inventoryEntry,
  type EquipmentComponentDefinition,
} from '@ancadeba/schemas'
import { GraphicComponentRenderer, type RenderedGraphic } from './graphicComponentRenderer.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Item buttons inspect worn items; separate slot buttons choose an equip destination. */
export class EquipmentComponentRenderer implements IComponentRenderer<EquipmentComponentDefinition> {
  constructor(private readonly graphics = new GraphicComponentRenderer()) {}
  render(
    component: EquipmentComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, scene, inventory, inventoryDefinition } = context
    const game = scene?.type === 'game' ? scene.game : undefined
    const root = document.createElement('section')
    root.className = 'ancadeba-equipment'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    const grid = document.createElement('div')
    grid.className = 'ancadeba-equipment-grid'
    grid.style.setProperty('--ge-equipment-columns', String(component.columns))
    root.append(title, grid)
    const owner = inventoryDefinition && inventoryEntry(inventoryDefinition.owners, component.owner)
    const icons = new Map<string, RenderedGraphic>()

    const update = () => {
      const focused = Boolean(document.activeElement && grid.contains(document.activeElement))

      const focusItem = focused
        ? (document.activeElement?.getAttribute('data-equipment-item') ?? undefined)
        : undefined

      const focusSlot = focused
        ? (document.activeElement?.getAttribute('data-equipment-slot') ?? undefined)
        : undefined

      const token = scene && game?.equipment?.get(scene, component.id)
      const selected = inventory?.snapshot.find((item) => item.id === token?.item)

      const type =
        selected &&
        inventoryDefinition &&
        inventoryEntry(inventoryDefinition.itemTypes, selected.itemType)

      const slots = owner
        ? [
            ...component.order,
            ...Object.keys(owner.equipmentSlots).filter((slot) => !component.order.includes(slot)),
          ]
        : []

      const visibleIcons = new Set<string>()
      grid.replaceChildren()
      let restore: HTMLButtonElement | undefined

      for (const slot of slots) {
        const item = inventory?.snapshot.find(
          (item) =>
            item.placement.type === 'equipped' &&
            item.placement.owner === component.owner &&
            item.placement.slot === slot,
        )

        const cell = document.createElement('div')

        const compatible =
          !selected ||
          (type?.equipmentSlots.includes(slot) &&
            inventory?.checkEquip(selected.id, component.owner, slot) === undefined)

        cell.className = `ancadeba-equipment-slot${item ? ' ancadeba-equipment-slot--occupied' : ''}${compatible ? '' : ' ancadeba-equipment-slot--incompatible'}`
        const destination = document.createElement('button')
        destination.type = 'button'
        destination.dataset.equipmentSlot = slot
        destination.textContent = owner?.equipmentSlots[slot] ?? slot
        destination.setAttribute('aria-pressed', String(token?.slot === slot))
        destination.addEventListener('click', () => {
          if (scene) game?.equipment?.selectSlot(scene, component.id, slot)
        })
        cell.append(destination)

        if (focusSlot === slot) restore = destination

        if (item && inventoryDefinition) {
          const worn = document.createElement('button')
          worn.type = 'button'
          worn.dataset.equipmentItem = item.id
          const type = inventoryEntry(inventoryDefinition.itemTypes, item.itemType)
          worn.textContent = type?.label ?? item.itemType
          const asset = type?.icon && inventoryIcon(context.assets, type.icon)

          if (asset && type?.icon) {
            let icon = icons.get(item.id)

            if (!icon) {
              icon = this.graphics.render(
                {
                  id: item.id,
                  type: 'graphic',
                  visual: type.icon,
                  alt: '',
                  placement: component.placement,
                  fit: 'contain',
                  appearance: {
                    visible: true,
                    colors: inventoryColors(item.colors, asset),
                    slots: {},
                  },
                },
                { ...context, bindings: undefined },
              )
              icon.element.classList.add('ancadeba-inventory-icon')
              icons.set(item.id, icon)
            }

            visibleIcons.add(item.id)
            worn.prepend(icon.element)
          }

          worn.setAttribute('aria-pressed', String(token?.item === item.id))
          worn.addEventListener('click', () => {
            if (scene) game?.inventorySelection?.select(scene, component.inventory, item.id)
          })
          cell.append(worn)

          if (focusItem === item.id) restore = worn
        } else {
          const empty = document.createElement('span')
          empty.textContent = 'Empty'
          cell.append(empty)
        }

        grid.append(cell)
      }

      for (const [id, icon] of icons) {
        if (visibleIcons.has(id)) continue
        icon.dispose()
        icons.delete(id)
      }

      if (focused) {
        if (restore) restore.focus()
        else context.onActionBarFocusLost?.()
      }
    }

    const cleanups: (() => void)[] = []

    try {
      update()
      const equipment = game?.equipment?.subscribe(update)

      if (equipment) cleanups.push(equipment)
      const changes = inventory?.subscribeChanges(update)

      if (changes) cleanups.push(changes)
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()

      for (const icon of icons.values()) icon.dispose()
      root.remove()
      throw error
    }

    return {
      element: root,
      dispose() {
        for (const cleanup of cleanups) cleanup?.()

        for (const icon of icons.values()) icon.dispose()
        root.remove()
      },
    }
  }
}
