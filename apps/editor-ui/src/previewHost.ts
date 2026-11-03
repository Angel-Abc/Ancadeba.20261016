import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import { mountGameView } from '@ancadeba/ui-components'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'

export class EditorPreviewHost implements IEngineHost {
  constructor(
    private readonly element: HTMLElement,
    private readonly t: Translate = editorLocalization().t,
    private readonly subscribeLanguageChanges?: (listener: () => void) => () => void,
  ) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    const unmount = mountGameView(this.element, game, session, {
      scenePicker: true,
      scenePickerLabels: {
        caption: this.t('scene.label'),
        accessibleName: this.t('preview.scene'),
        empty: this.t('preview.noScene'),
      },
      bindingMode: 'editor',
    })

    const unsubscribe = this.subscribeLanguageChanges?.(() => {
      const picker = this.element.querySelector('.ancadeba-scene-picker')
      const caption = picker?.querySelector('span')
      const select = picker?.querySelector('select')
      const empty = select?.querySelector('option[value=""]')

      if (caption) caption.textContent = this.t('scene.label')
      select?.setAttribute('aria-label', this.t('preview.scene'))

      if (empty) empty.textContent = this.t('preview.noScene')
    })

    return () => {
      unsubscribe?.()
      unmount()
    }
  }
}
