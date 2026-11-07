import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import {
  mountGameView,
  BrowserGraphicResources,
  createGraphicPlatform,
} from '@ancadeba/ui-components'
import type { IResourceSource } from '@ancadeba/utilities'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'

export class EditorPreviewHost implements IEngineHost {
  constructor(
    private readonly element: HTMLElement,
    private readonly t: Translate = editorLocalization().t,
    private readonly subscribeLanguageChanges?: (listener: () => void) => () => void,
    private readonly resources?: IResourceSource,
    /** The scene being edited; the preview opens there instead of the game's start scene. */
    private readonly startScene?: () => string | undefined,
  ) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    const graphics = this.resources
      ? new BrowserGraphicResources(
          this.resources,
          createGraphicPlatform(this.element.ownerDocument),
        )
      : undefined

    let unmount: () => void

    try {
      unmount = mountGameView(this.element, game, session, {
        graphics,
        scenePicker: true,
        scenePickerLabels: {
          caption: this.t('scene.label'),
          accessibleName: this.t('preview.scene'),
          empty: this.t('preview.noScene'),
        },
        bindingMode: 'editor',
      })
      this.enterStartScene(game, session)
    } catch (error) {
      graphics?.dispose()
      throw error
    }

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

      try {
        unmount()
      } finally {
        graphics?.dispose()
      }
    }
  }

  private enterStartScene(game: GameData, session: EngineHostSession): void {
    const id = this.startScene?.()
    const scene = id === undefined ? undefined : game.scenes.get(id)
    const { lifecycle } = session

    if (!scene || lifecycle.activeScene?.data.id === scene.id) return

    if (scene.type === 'game' && !lifecycle.currentGame) lifecycle.startGame()
    lifecycle.enterScene(scene.id)
  }
}
