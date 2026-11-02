import type { SceneComponentData } from '@ancadeba/game-runtime'
import { ButtonComponentRenderer } from './buttonComponentRenderer.js'
import { TextComponentRenderer } from './textComponentRenderer.js'
import type {
  ComponentRenderContext,
  ComponentRenderers,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Dispatches component data to its typed renderer. Renderers can be supplied by the host. */
export class ComponentRenderer implements IComponentRenderer {
  constructor(
    private readonly renderers: ComponentRenderers = {
      text: new TextComponentRenderer(),
      button: new ButtonComponentRenderer(),
    },
  ) {}

  render(component: SceneComponentData, context: ComponentRenderContext): RenderedComponent {
    switch (component.type) {
      case 'text':
        return this.renderers.text.render(component, context)
      case 'button':
        return this.renderers.button.render(component, context)
      default: {
        const unsupported: never = component
        throw new Error(`Unsupported scene component: ${String(unsupported)}`)
      }
    }
  }
}
