import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import { mountGameView } from '@ancadeba/ui-components'

export class EditorPreviewHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    return mountGameView(this.element, game, session, { scenePicker: true })
  }
}
