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
    element.disabled = !action || !context.onButtonActivate
    let active = true

    const onClick = () => {
      if (active && action) context.onButtonActivate?.(action)
    }

    if (!element.disabled) element.addEventListener('click', onClick)

    return {
      element,
      dispose() {
        if (!active) return
        active = false
        element.removeEventListener('click', onClick)
        element.remove()
      },
    }
  }
}
