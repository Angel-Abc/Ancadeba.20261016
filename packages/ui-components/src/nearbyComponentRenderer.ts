import type { NearbyComponentDefinition } from '@ancadeba/schemas'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Displays selectable targets; descriptions and commands are rendered by their configured components. */
export class NearbyComponentRenderer implements IComponentRenderer<NearbyComponentDefinition> {
  render(component: NearbyComponentDefinition, context: ComponentRenderContext): RenderedComponent {
    const { document, scene } = context
    const nearby = scene?.type === 'game' ? scene.game.nearby : undefined
    const root = document.createElement('section')
    root.className = 'ancadeba-nearby'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    root.append(title)
    const rows = new Map<string, { row: HTMLElement; button: HTMLButtonElement }>()

    for (const [id, entry] of Object.entries(component.entries)) {
      const row = document.createElement('div')
      row.className = 'ancadeba-nearby-entry'
      row.dataset.nearbyKind = entry.kind
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = entry.label
      button.dataset.nearbyEntry = id
      button.addEventListener('click', () => {
        if (active && scene) nearby?.select(scene, component.id, id)
      })
      row.append(button)
      root.append(row)
      rows.set(id, { row, button })
    }

    const empty = document.createElement('p')
    empty.textContent = 'None nearby'
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.textContent = 'Clear nearby selection'
    clear.addEventListener('click', () => {
      if (active && scene) nearby?.select(scene, component.id)
    })
    root.append(empty, clear)
    let active = true

    const update = () => {
      if (!active) return
      const selected = scene && nearby?.getSelection(scene, component.id)?.entry
      let count = 0

      for (const [id, { row, button }] of rows) {
        const entry = component.entries[id]!
        const condition = entry.visibleWhen && context.bindings?.read(entry.visibleWhen)

        const visible =
          nearby && scene
            ? Boolean(nearby.getEntry(scene, component.id, id))
            : !entry.visibleWhen || (condition?.status === 'resolved' && condition.value === true)

        row.hidden = !visible
        button.disabled = !nearby
        button.setAttribute('aria-pressed', String(id === selected))

        if (visible) count++
        else if (document.activeElement === button) context.onActionBarFocusLost?.()
      }

      empty.hidden = count !== 0
      clear.hidden = !selected

      if (clear.hidden && document.activeElement === clear) context.onActionBarFocusLost?.()
    }

    update()
    const unsubscribeSelection = nearby?.subscribeChanges(update)
    const unsubscribeBindings = context.bindings?.subscribeChanges(update)

    return {
      element: root,
      dispose() {
        active = false
        unsubscribeSelection?.()
        unsubscribeBindings?.()
        root.remove()
      },
    }
  }
}
