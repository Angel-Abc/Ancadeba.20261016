import type { IEngineHost } from '@ancadeba/game-runtime'
import type { Game } from '@ancadeba/schemas'

export class EditorPreviewHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(game: Game): () => void {
    const document = this.element.ownerDocument
    const root = document.createElement('section')
    root.className = 'game-preview'
    const heading = document.createElement('h3')
    heading.textContent =
      typeof game.title === 'string' && game.title.trim() ? game.title : 'Game preview'
    const description = document.createElement('p')
    description.textContent = 'Game definition loaded.'
    root.append(heading, description)
    this.element.append(root)
    return () => root.remove()
  }
}
