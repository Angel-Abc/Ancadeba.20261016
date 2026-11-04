import type { InventoryComponentData, InventoryItemSnapshot } from '@ancadeba/game-runtime'
import {
  inventoryColors,
  inventoryIcon,
  type GameBindingDefinition,
  type InventoryPlacement,
  type SlotAppearance,
} from '@ancadeba/schemas'
import { GraphicComponentRenderer, type RenderedGraphic } from './graphicComponentRenderer.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

const appearance = { visible: true, colors: {}, slots: {} }

interface Destination {
  readonly label: string
  readonly placement: InventoryPlacement
}

function appendGroup(parent: HTMLElement, heading: string): HTMLUListElement {
  const document = parent.ownerDocument
  const title = document.createElement('h4')
  title.textContent = heading
  const list = document.createElement('ul')
  parent.append(title, list)

  return list
}

export class InventoryComponentRenderer implements IComponentRenderer<InventoryComponentData> {
  constructor(private readonly graphics = new GraphicComponentRenderer()) {}

  render(component: InventoryComponentData, context: ComponentRenderContext): RenderedComponent {
    const { document, assets, inventory, inventoryDefinition: definition } = context
    const root = document.createElement('section')
    root.className = component.readOnly
      ? 'ancadeba-inventory ancadeba-inventory--read-only'
      : 'ancadeba-inventory'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    root.append(title)

    if (!inventory || !definition) {
      root.append('Inventory unavailable')

      return { element: root, dispose: () => root.remove() }
    }

    const onlyOwner = component.owners.length === 1 ? component.owners[0] : undefined

    const simple =
      component.readOnly &&
      onlyOwner !== undefined &&
      !component.previews[onlyOwner] &&
      !Object.keys(definition.owners[onlyOwner]!.equipmentSlots).length

    if (simple) root.className += ' ancadeba-inventory--simple'

    const renderGraphic = (visual: string, alt = '', initial = appearance) =>
      this.graphics.render(
        {
          id: visual,
          type: 'graphic',
          placement: component.placement,
          visual,
          alt,
          fit: 'contain',
          appearance: initial,
        },
        { ...context, bindings: undefined },
      )

    const owners = document.createElement('div')
    owners.className = 'ancadeba-inventory-owners'
    const controls = document.createElement('div')
    controls.className = 'ancadeba-inventory-controls'
    const label = document.createElement('label')
    label.textContent = 'Destination '
    const select = document.createElement('select')
    label.append(select)
    const move = document.createElement('button')
    move.type = 'button'
    move.textContent = 'Move selected item'
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    controls.append(label, move, status)
    root.append(owners)

    if (!component.readOnly) root.append(controls)

    const icons = new Map<string, RenderedGraphic>()
    const previews = new Map<string, RenderedGraphic>()

    for (const [id, preview] of Object.entries(component.previews)) {
      const graphic = renderGraphic(preview.composition, definition.owners[id]!.label)
      graphic.element.classList.add('ancadeba-inventory-preview')
      previews.set(id, graphic)
    }

    let selected: string | undefined
    let destinations: Destination[] = []
    const buttons = new Map<string, HTMLButtonElement>()
    const inspectionDetails = new Map<HTMLElement, GameBindingDefinition>()

    const updateInspections = () => {
      for (const [details, binding] of inspectionDetails) {
        const result = context.bindings?.read(binding)
        const text = result?.status === 'resolved' ? String(result.value) : (binding.fallback ?? '')

        if (details.textContent !== text) details.textContent = text
      }
    }

    const syncSelection = (choices: readonly Destination[]) => {
      for (const [id, button] of buttons)
        button.setAttribute('aria-pressed', String(id === selected))

      destinations =
        selected === undefined
          ? []
          : choices.filter(
              ({ placement }) => inventory.checkMove(selected!, placement) === undefined,
            )
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = selected ? 'Choose a destination' : 'Select an item first'
      select.replaceChildren(placeholder)
      const names = new Map<string, number>()

      for (const { label } of destinations) names.set(label, (names.get(label) ?? 0) + 1)
      destinations.forEach(({ label, placement }, index) => {
        const option = document.createElement('option')
        option.value = String(index)
        option.textContent =
          placement.type === 'inside' && (names.get(label) ?? 0) > 1
            ? `${label} (${placement.container})`
            : label
        select.append(option)
      })
      select.disabled = destinations.length === 0
      move.disabled = true
    }

    const update = () => {
      const snapshot = inventory.snapshot
      const children = new Map<string, InventoryItemSnapshot[]>()
      const roots = new Map<string, InventoryItemSnapshot[]>()

      for (const item of snapshot) {
        const { placement } = item
        const group = placement.type === 'inside' ? children : roots
        const key = placement.type === 'inside' ? placement.container : placement.owner
        const items = group.get(key)

        if (items) items.push(item)
        else group.set(key, [item])
      }

      const choices: Destination[] = []
      const visibleIcons = new Set<string>()
      const sections: HTMLElement[] = []

      const restoreFocus =
        selected !== undefined && buttons.get(selected) === document.activeElement

      buttons.clear()
      inspectionDetails.clear()

      const itemRow = (item: InventoryItemSnapshot, path: string): HTMLLIElement => {
        const type = definition.itemTypes[item.itemType]!
        const row = document.createElement('li')
        const line = simple ? document.createElement('div') : row

        if (simple) {
          line.className = 'ancadeba-inventory-item-line'
          row.append(line)
        }

        if (component.readOnly) {
          const name = document.createElement('span')
          name.textContent = type.label
          line.append(name)
        } else {
          const button = document.createElement('button')
          button.type = 'button'
          button.dataset.itemId = item.id
          button.textContent = type.label
          button.addEventListener('click', () => {
            selected = item.id
            status.textContent = ''
            syncSelection(choices)
          })
          buttons.set(item.id, button)
          line.append(button)
        }

        const icon = type.icon && inventoryIcon(assets, type.icon)

        if (icon && type.icon) {
          let graphic = icons.get(item.id)

          if (!graphic) {
            graphic = renderGraphic(type.icon, '', {
              ...appearance,
              colors: inventoryColors(item.colors, icon),
            })
            graphic.element.classList.add('ancadeba-inventory-icon')
            icons.set(item.id, graphic)
          }

          visibleIcons.add(item.id)
          line.prepend(graphic.element)
        }

        if (type.container)
          choices.push({
            label: `Inside ${path} / ${type.label}`,
            placement: { type: 'inside', container: item.id },
          })

        const contents = children.get(item.id)

        if (contents?.length) {
          const list = document.createElement('ul')
          list.setAttribute('aria-label', `Inside ${type.label}`)

          for (const child of contents) list.append(itemRow(child, `${path} / ${type.label}`))
          row.append(list)
        }

        if (type.inspection && context.actions) {
          const { action, details: binding } = type.inspection
          const inspect = document.createElement('button')
          inspect.type = 'button'
          inspect.dataset.inspectItem = item.id
          inspect.textContent = 'Inspect'
          inspect.setAttribute('aria-label', `Inspect ${type.label}`)
          inspect.addEventListener('click', () => {
            if (inspectionDetails.has(details)) context.actions?.request(action, item.id)
          })
          const details = document.createElement('p')
          details.className = 'ancadeba-inventory-inspection'
          details.setAttribute('role', 'status')
          inspectionDetails.set(details, binding)
          line.append(inspect)
          row.append(details)
        }

        return row
      }

      for (const ownerId of component.owners) {
        const owner = definition.owners[ownerId]!
        const ownerItems = roots.get(ownerId) ?? []
        const equipmentSlots = Object.entries(owner.equipmentSlots)
        const preview = previews.get(ownerId)
        const equipped = new Map<string, InventoryItemSnapshot>()

        for (const item of ownerItems) {
          if (item.placement.type === 'equipped') equipped.set(item.placement.slot, item)
        }

        const section = document.createElement('section')
        section.dataset.inventoryOwner = ownerId
        section.setAttribute('aria-label', owner.label)

        if (!simple) {
          const heading = document.createElement('h3')
          heading.textContent = owner.label
          section.append(heading)
        }

        choices.push({
          label: `Carried by ${owner.label}`,
          placement: { type: 'carried', owner: ownerId },
        })

        if (preview) {
          const slots: Record<string, SlotAppearance> = {}

          for (const [slot, target] of Object.entries(component.previews[ownerId]!.slots)) {
            const item = equipped.get(slot)
            const part = item && definition.itemTypes[item.itemType]?.wornPart
            const asset = part && assets?.parts[part]
            slots[target] = {
              part: part ?? null,
              visible: true,
              colors: item && asset ? inventoryColors(item.colors, asset) : {},
            }
          }

          preview.setAppearance({ ...appearance, slots })
          section.append(preview.element)
        }

        const carried = simple ? document.createElement('ul') : appendGroup(section, 'Carried')

        for (const item of ownerItems) {
          if (item.placement.type === 'carried') carried.append(itemRow(item, owner.label))
        }

        if (!carried.firstChild) {
          const empty = document.createElement(simple ? 'p' : 'li')
          empty.textContent = 'Empty'

          if (simple) {
            empty.className = 'ancadeba-inventory-empty'
            section.append(empty)
          } else carried.append(empty)
        } else if (simple) {
          carried.setAttribute('role', 'list')
          section.append(carried)
        }

        if (equipmentSlots.length) {
          const worn = appendGroup(section, 'Worn')

          for (const [slot, name] of equipmentSlots) {
            const slotLabel = document.createElement('span')
            const item = equipped.get(slot)
            const row = item ? itemRow(item, owner.label) : document.createElement('li')
            slotLabel.textContent = item ? `${name}: ` : `${name}: empty`
            row.prepend(slotLabel)
            worn.append(row)
            choices.push({
              label: `${owner.label} / ${name}`,
              placement: { type: 'equipped', owner: ownerId, slot },
            })
          }
        }

        sections.push(section)
      }

      for (const [id, icon] of icons) {
        if (visibleIcons.has(id)) continue
        icon.dispose()
        icons.delete(id)
      }

      owners.replaceChildren(...sections)
      updateInspections()

      if (selected !== undefined && !buttons.has(selected)) selected = undefined
      syncSelection(choices)

      if (restoreFocus && selected !== undefined) buttons.get(selected)?.focus()
    }

    select.addEventListener('change', () => {
      move.disabled = select.value === ''
    })
    move.addEventListener('click', () => {
      const destination = select.value === '' ? undefined : destinations[Number(select.value)]

      if (!selected || !destination) return
      const result = inventory.move(selected, destination.placement)
      status.textContent =
        result.status === 'rejected'
          ? result.reason
          : `Selected item is now at ${destination.label}.`

      if (result.status === 'applied') buttons.get(selected)?.focus()
    })

    update()
    const unsubscribe = inventory.subscribeChanges(update)

    const unsubscribeInspections = Object.values(definition.itemTypes).some(
      (type) => type.inspection,
    )
      ? context.bindings?.subscribeChanges(updateInspections)
      : undefined

    return {
      element: root,
      dispose() {
        unsubscribe()
        unsubscribeInspections?.()
        inspectionDetails.clear()

        for (const graphic of [...icons.values(), ...previews.values()]) graphic.dispose()
        root.remove()
      },
    }
  }
}
