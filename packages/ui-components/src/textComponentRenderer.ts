import {
  observeText,
  resolveText,
  type TextComponentData,
  type TextResolution,
} from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Owns a text element and its optional binding subscription. */
export class TextComponentRenderer implements IComponentRenderer<TextComponentData> {
  render(component: TextComponentData, context: ComponentRenderContext): RenderedComponent {
    const element = context.document.createElement(
      component.presentation.variant === 'heading' ? 'h2' : 'div',
    )

    element.className = `ancadeba-text ancadeba-text--${component.presentation.variant}`
    element.style.setProperty('--ge-component-text-align', component.presentation.align)

    let active = true
    let unsubscribe: (() => void) | undefined

    const rendered: RenderedComponent = {
      element,
      dispose() {
        if (!active) return
        active = false

        try {
          unsubscribe?.()
        } finally {
          element.remove()
        }
      },
    }

    const updateText = ({ text, diagnostics }: TextResolution) => {
      if (!active) return
      element.textContent = text

      if (context.bindingMode === 'editor') {
        element.dataset.bindingStatus = diagnostics.length ? 'unresolved' : 'resolved'
        element.title = diagnostics
          .map(
            ({ alias, source, path, reason }) =>
              `${alias}: ${source ?? 'unknown source'} ${JSON.stringify(path ?? [])} (${reason})`,
          )
          .join('\n')
      }
    }

    try {
      if (component.bindings === undefined) element.textContent = component.text
      else {
        const options = { mode: context.bindingMode ?? 'standalone' }

        if (context.bindings)
          unsubscribe = observeText(component, context.bindings, updateText, options)
        else updateText(resolveText(component, undefined, options))
      }

      return rendered
    } catch (error) {
      rendered.dispose()
      throw error
    }
  }
}
