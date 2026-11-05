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
    const buttons = new Map<string, { button: HTMLButtonElement; badge: HTMLElement }>()
    const cleanups: (() => void)[] = []
    let active = true

    const update = () => {
      if (!active) return

      for (const [id, { button, badge }] of buttons) {
        const focused = document.activeElement === button

        button.disabled = !scene || !actionBar?.isEnabled(scene, component.id, id)

        if (focused && button.disabled) context.onActionBarFocusLost?.()

        const binding = component.slots[id]!.inputBinding

        const codes =
          binding && binding.context === input?.context
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
          slot.action.type === 'request-action' ? slot.action.action : slot.action.scene
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
        buttons.set(id, { button, badge })
        root.append(button)
      }

      update()
      const unsubscribeBindings = context.bindings?.subscribeChanges(update)

      if (unsubscribeBindings) cleanups.push(unsubscribeBindings)
      const unsubscribeInput = input?.subscribeContextChanges?.(update)

      if (unsubscribeInput) cleanups.push(unsubscribeInput)
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
