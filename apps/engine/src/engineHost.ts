import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import {
  mountGameView,
  BrowserGraphicResources,
  createGraphicPlatform,
} from '@ancadeba/ui-components'
import type { IResourceSource } from '@ancadeba/utilities'

export class DomEngineHost implements IEngineHost {
  constructor(
    private readonly element: HTMLElement,
    private readonly resources?: IResourceSource,
  ) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    const graphics = this.resources
      ? new BrowserGraphicResources(
          this.resources,
          createGraphicPlatform(this.element.ownerDocument),
        )
      : undefined

    try {
      const unmount = mountGameView(this.element, game, session, {
        bindingMode: 'standalone',
        graphics,
      })

      return () => {
        try {
          unmount()
        } finally {
          graphics?.dispose()
        }
      }
    } catch (error) {
      graphics?.dispose()
      throw error
    }
  }
}
