import type { EngineHostSession, GameData, IEngineHost } from '@ancadeba/game-runtime'
import { bindKeyboardInput } from '@ancadeba/ui-components'

export class DomEngineHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(_game: GameData, session: EngineHostSession): () => void {
    const document = this.element.ownerDocument
    const root = document.createElement('section')
    root.tabIndex = 0
    const heading = document.createElement('h1')
    heading.textContent = 'Ancadeba Engine'

    const description = document.createElement('p')
    description.textContent = 'The engine workspace is ready.'

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
