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
    let unsubscribeSelection: (() => void) | undefined
    let latest: TextResolution = { text: component.text, diagnostics: [] }
    const scene = context.scene
    const nearby = scene?.type === 'game' ? scene.game.nearby : undefined

    const panel = scene?.data.components.find(
      (entry) => entry.type === 'nearby' && entry.descriptionTarget === component.id,
    )

    const rendered: RenderedComponent = {
      element,
      dispose() {
        if (!active) return
        active = false

        try {
          unsubscribe?.()
          unsubscribeSelection?.()
        } finally {
          element.remove()
        }
      },
    }

    const updateText = ({ text, diagnostics }: TextResolution) => {
      if (!active) return
      latest = { text, diagnostics }
      const selected = panel && scene && nearby?.getSelection(scene, panel.id)
      const entry = selected && panel && scene && nearby?.getEntry(scene, panel.id, selected.entry)
      element.textContent = entry
        ? [text, entry.label, entry.description].filter(Boolean).join('\n\n')
        : text

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
      if (component.bindings === undefined) updateText({ text: component.text, diagnostics: [] })
      else {
        const options = { mode: context.bindingMode ?? 'standalone' }

        if (context.bindings)
          unsubscribe = observeText(component, context.bindings, updateText, options)
        else updateText(resolveText(component, undefined, options))
      }

      if (panel) unsubscribeSelection = nearby?.subscribeChanges(() => updateText(latest))

      return rendered
    } catch (error) {
      rendered.dispose()
      throw error
    }
  }
}
