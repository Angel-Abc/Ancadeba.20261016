import type { IGameLifecycle, SceneData, SceneInstance } from '@ancadeba/game-runtime'

/** Renders only the active scene. Geometry comes from data; appearance comes from CSS. */
export class SceneRenderer {
  private element: HTMLElement | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly target: HTMLElement,
    private readonly lifecycle: IGameLifecycle,
  ) {
    try {
      this.render(lifecycle.activeScene)
      this.unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => this.render(current))
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.element?.remove()
    this.element = undefined
  }

  private render(scene: SceneInstance | undefined): void {
    if (this.disposed) return
    const next = scene ? this.createScene(scene.data) : undefined
    this.element?.remove()
    this.element = next
    if (next) this.target.append(next)
  }

  private createScene(data: SceneData): HTMLElement {
    const document = this.target.ownerDocument
    const root = document.createElement('section')
    root.className = 'ancadeba-scene'
    root.dataset.sceneId = data.id
    root.setAttribute('aria-label', data.title)
    root.style.setProperty('--ge-scene-grid-rows', `${data.screen.grid.rows}`)
    root.style.setProperty('--ge-scene-grid-columns', `${data.screen.grid.columns}`)

    for (const component of data.components) {
      const text = document.createElement(
        component.presentation.variant === 'heading' ? 'h2' : 'div',
      )
      text.className = `ancadeba-text ancadeba-text--${component.presentation.variant}`
      text.dataset.componentId = component.id
      text.textContent = component.text
      const { row, column, rowSpan, columnSpan } = component.placement
      text.style.setProperty('--ge-component-row', String(row))
      text.style.setProperty('--ge-component-column', String(column))
      text.style.setProperty('--ge-component-row-span', String(rowSpan))
      text.style.setProperty('--ge-component-column-span', String(columnSpan))
      text.style.setProperty('--ge-component-text-align', component.presentation.align)
      root.append(text)
    }
    return root
  }
}
