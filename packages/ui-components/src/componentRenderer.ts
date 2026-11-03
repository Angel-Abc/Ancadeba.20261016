import type { SceneComponentData } from '@ancadeba/game-runtime'
import { ButtonComponentRenderer } from './buttonComponentRenderer.js'
import { TextComponentRenderer } from './textComponentRenderer.js'
import { LanguageSelectComponentRenderer } from './languageSelectComponentRenderer.js'
import { GraphicComponentRenderer } from './graphicComponentRenderer.js'
import type {
  ComponentRenderContext,
  ComponentRenderers,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Dispatches component data to its typed renderer. Renderers can be supplied by the host. */
export class ComponentRenderer implements IComponentRenderer {
  private readonly renderers: ComponentRenderers
  constructor(renderers: Partial<ComponentRenderers> = {}) {
    this.renderers = {
      text: new TextComponentRenderer(),
      graphic: new GraphicComponentRenderer(),
      button: new ButtonComponentRenderer(),
      'language-select': new LanguageSelectComponentRenderer(),
      ...renderers,
    }
  }

  render(component: SceneComponentData, context: ComponentRenderContext): RenderedComponent {
    switch (component.type) {
      case 'graphic':
        return this.renderers.graphic.render(component, context)
      case 'text':
        return this.renderers.text.render(component, context)
      case 'button':
        return this.renderers.button.render(component, context)
      case 'language-select':
        return this.renderers['language-select'].render(component, context)
      default: {
        const unsupported: never = component
        throw new Error(`Unsupported scene component: ${String(unsupported)}`)
      }
    }
  }
}
