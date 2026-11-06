import type { ActionBarComponentDefinition } from '@ancadeba/schemas'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

function keyLabel(code: string): string {
  return code.replace(/^(?:Key(?=[A-Z]$)|Digit(?=[0-9]$))/, '')
}

/** Renders slot presentation while the game runtime owns activation and input routing. */
export class ActionBarComponentRenderer implements IComponentRenderer<ActionBarComponentDefinition> {
  render(
    component: ActionBarComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, scene, input } = context
    const root = document.createElement('div')
    root.className = 'ancadeba-action-bar'
    const actionBar = scene?.type === 'game' ? scene.game.actionBar : undefined

    const buttons = new Map<
      string,
      { button: HTMLButtonElement; badge: HTMLElement; empty: HTMLElement | undefined }
    >()

    const cleanups: (() => void)[] = []
    let active = true

    const update = () => {
      if (!active) return

      for (const [id, { button, badge, empty }] of buttons) {
        const focused = document.activeElement === button

        const available =
          !['inventory-action', 'nearby-action'].includes(component.slots[id]!.action.type) ||
          Boolean(scene && actionBar?.getSlot(scene, component.id, id))

        button.disabled = !scene || !actionBar?.isEnabled(scene, component.id, id)
        button.hidden = !available

        if (empty) empty.hidden = available

        if (focused && button.disabled) context.onActionBarFocusLost?.()

        const binding = component.slots[id]!.inputBinding

        const codes =
          available && binding && binding.context === input?.context
            ? (input.getKeyboardCodes?.(binding.context, binding.input) ?? [])
            : []

        badge.textContent = codes.map(keyLabel).join(' / ')
        badge.hidden = codes.length === 0
      }
    }

    try {
      for (let index = 1; index <= 15; index++) {
        const id = String(index)
        const slot = component.slots[id]

        if (!slot) {
          const empty = document.createElement('div')
          empty.className = 'ancadeba-action-bar-empty'
          empty.setAttribute('aria-hidden', 'true')
          root.append(empty)

          continue
        }

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ancadeba-button ancadeba-action-bar-button'
        button.dataset.actionBarSlot = id
        button.dataset.slotAction =
          slot.action.type === 'combat-action'
            ? `${slot.action.combat}:${slot.action.command.type}`
            : slot.action.type === 'shop-action'
              ? `${slot.action.shop}:${slot.action.operation}`
              : slot.action.type === 'equipment-action'
                ? `${slot.action.equipment}:${slot.action.operation}`
                : slot.action.type === 'move-map'
                  ? `${slot.action.mapView}:${slot.action.direction}`
                  : 'action' in slot.action
                    ? slot.action.action
                    : slot.action.scene
        const label = document.createElement('span')
        label.textContent = slot.label
        const badge = document.createElement('kbd')
        badge.className = 'ancadeba-action-bar-key'
        button.append(label, badge)

        const activate = () => {
          if (active && scene) actionBar?.activate(scene, component.id, id)
        }

        button.addEventListener('click', activate)
        cleanups.push(() => button.removeEventListener('click', activate))
        let empty: HTMLElement | undefined

        if (slot.action.type === 'inventory-action' || slot.action.type === 'nearby-action') {
          const cell = document.createElement('div')
          cell.className = 'ancadeba-action-bar-cell'
          empty = document.createElement('div')
          empty.className = 'ancadeba-action-bar-empty'
          empty.setAttribute('aria-hidden', 'true')
          cell.append(button, empty)
          root.append(cell)
        } else root.append(button)
        buttons.set(id, { button, badge, empty })
      }

      update()
      const unsubscribeBindings = context.bindings?.subscribeChanges(update)

      if (unsubscribeBindings) cleanups.push(unsubscribeBindings)
      const unsubscribeInput = input?.subscribeContextChanges?.(update)

      if (unsubscribeInput) cleanups.push(unsubscribeInput)
      const unsubscribeContext = actionBar?.subscribeChanges(update)

      if (unsubscribeContext) cleanups.push(unsubscribeContext)
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()
      root.remove()
      throw error
    }

    return {
      element: root,
      dispose() {
        if (!active) return
        active = false

        for (const cleanup of cleanups.reverse()) cleanup()
        root.remove()
      },
    }
  }
}
