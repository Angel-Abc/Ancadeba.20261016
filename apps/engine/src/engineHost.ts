import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import { mountGameView } from '@ancadeba/ui-components'

export class DomEngineHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    return mountGameView(this.element, game, session)
  }
}
