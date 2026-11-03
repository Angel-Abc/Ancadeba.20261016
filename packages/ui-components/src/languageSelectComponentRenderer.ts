import type { LanguageSelectComponentData } from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Owns an accessible native select whose choices come from the game's catalogs. */
export class LanguageSelectComponentRenderer implements IComponentRenderer<LanguageSelectComponentData> {
  render(
    component: LanguageSelectComponentData,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const element = context.document.createElement('label')
    element.className = 'ancadeba-language-select'
    const caption = context.document.createElement('span')
    caption.textContent = component.label
    const select = context.document.createElement('select')
    select.dataset.componentId = component.id
    const localization = context.localization
    select.disabled = !localization

    for (const { tag, name } of localization?.available ?? []) {
      const option = context.document.createElement('option')
      option.value = tag
      option.textContent = name
      option.setAttribute('lang', tag)
      select.append(option)
    }

    select.value = localization?.current.language ?? ''
    element.append(caption, select)
    let active = true

    const onChange = () => {
      if (!active || !localization) return

      try {
        localization.select(select.value)
      } finally {
        select.value = localization.current.language
      }
    }

    select.addEventListener('change', onChange)

    return {
      element,
      dispose() {
        if (!active) return
        active = false
        select.removeEventListener('change', onChange)
        element.remove()
      },
    }
  }
}
