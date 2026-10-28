import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import { bindKeyboardInput } from '@ancadeba/ui-components'

export class EditorPreviewHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(game: GameData, session: EngineHostSession): () => void {
    const document = this.element.ownerDocument
    const root = document.createElement('section')
    root.tabIndex = 0
    root.className = 'game-preview'
    const heading = document.createElement('h3')
    heading.textContent =
      typeof game.title === 'string' && game.title.trim() ? game.title : 'Game preview'
    const description = document.createElement('p')
    description.textContent = 'Game definition loaded.'
    root.append(heading, description)
    this.element.append(root)
    try {
      const unbind = session.input ? bindKeyboardInput(root, session.input) : undefined
      return () => {
        unbind?.()
        root.remove()
      }
    } catch (error) {
      root.remove()
      throw error
    }
  }
}
