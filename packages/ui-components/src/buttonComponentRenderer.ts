import type { ButtonComponentData } from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Owns a native button and its activation listener. */
export class ButtonComponentRenderer implements IComponentRenderer<ButtonComponentData> {
  render(component: ButtonComponentData, context: ComponentRenderContext): RenderedComponent {
    const element = context.document.createElement('button')
    element.type = 'button'
    element.className = 'ancadeba-button'
    element.textContent = component.label
    const action = component.action
    let active = true

    const update = () => {
      if (action?.type !== 'request-action') {
        element.disabled = !action || !context.onButtonActivate

        return
      }

      const enabled = action.enabledWhen && context.bindings?.read(action.enabledWhen)
      element.disabled =
        !context.actions ||
        Boolean(action.enabledWhen && (enabled?.status !== 'resolved' || enabled.value !== true))
    }

    const onClick = () => {
      if (!active || element.disabled || !action) return

      if (action.type === 'request-action') context.actions?.request(action.action)
      else context.onButtonActivate?.(action)
    }

    update()

    const unsubscribe =
      action?.type === 'request-action' && action.enabledWhen
        ? context.bindings?.subscribeChanges(update)
        : undefined

    if (action) element.addEventListener('click', onClick)

    return {
      element,
      dispose() {
        if (!active) return
        active = false
        unsubscribe?.()
        element.removeEventListener('click', onClick)
        element.remove()
      },
    }
  }
}
