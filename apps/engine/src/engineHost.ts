import type { IEngineHost } from '@ancadeba/game-runtime'

export class DomEngineHost implements IEngineHost {
  constructor(private readonly element: HTMLElement) {}

  mount(): () => void {
    const document = this.element.ownerDocument
    const root = document.createElement('section')
    const heading = document.createElement('h1')
    heading.textContent = 'Ancadeba Engine'

    const description = document.createElement('p')
    description.textContent = 'The engine workspace is ready.'

    root.append(heading, description)
    this.element.append(root)
    return () => root.remove()
  }
}
