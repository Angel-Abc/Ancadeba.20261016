import {
  observeText,
  resolveText,
  type IGameLifecycle,
  type SceneInstance,
  type TextResolution,
  type TextResolutionOptions,
} from '@ancadeba/game-runtime'

export interface SceneRendererOptions {
  readonly bindingMode?: TextResolutionOptions['mode']
}

interface RenderedScene {
  readonly element: HTMLElement
  dispose(): void
}

/** Renders only the active scene. Geometry comes from data; appearance comes from CSS. */
export class SceneRenderer {
  private scene: RenderedScene | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly target: HTMLElement,
    private readonly lifecycle: IGameLifecycle,
    private readonly options: SceneRendererOptions = {},
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
    this.scene?.dispose()
    this.scene = undefined
  }

  private render(scene: SceneInstance | undefined): void {
    if (this.disposed) return
    const next = scene ? this.createScene(scene) : undefined
    this.scene?.dispose()
    this.scene = next
    if (next) this.target.append(next.element)
  }

  private createScene(scene: SceneInstance): RenderedScene {
    const data = scene.data
    const document = this.target.ownerDocument
    const root = document.createElement('section')
    root.className = 'ancadeba-scene'
    root.dataset.sceneId = data.id
    root.setAttribute('aria-label', data.title)
    root.style.setProperty('--ge-scene-grid-rows', `${data.screen.grid.rows}`)
    root.style.setProperty('--ge-scene-grid-columns', `${data.screen.grid.columns}`)

    const cleanups: (() => void)[] = []
    let active = true
    const rendered: RenderedScene = {
      element: root,
      dispose() {
        active = false
        for (const cleanup of cleanups.splice(0)) cleanup()
        root.remove()
      },
    }
    try {
      for (const component of data.components) {
        const text = document.createElement(
          component.presentation.variant === 'heading' ? 'h2' : 'div',
        )
        text.className = `ancadeba-text ancadeba-text--${component.presentation.variant}`
        text.dataset.componentId = component.id
        const updateText = ({ text: content, diagnostics }: TextResolution) => {
          if (!active) return
          text.textContent = content
          if (this.options.bindingMode === 'editor') {
            text.dataset.bindingStatus = diagnostics.length ? 'unresolved' : 'resolved'
            text.title = diagnostics
              .map(
                ({ alias, source, path, reason }) =>
                  `${alias}: ${source ?? 'unknown source'} ${JSON.stringify(path ?? [])} (${reason})`,
              )
              .join('\n')
          }
        }
        if (component.bindings === undefined) text.textContent = component.text
        else {
          const source = scene.type === 'game' ? scene.game.bindings : undefined
          const options = { mode: this.options.bindingMode ?? 'standalone' }
          if (source) cleanups.push(observeText(component, source, updateText, options))
          else updateText(resolveText(component, undefined, options))
        }
        const { row, column, rowSpan, columnSpan } = component.placement
        text.style.setProperty('--ge-component-row', String(row))
        text.style.setProperty('--ge-component-column', String(column))
        text.style.setProperty('--ge-component-row-span', String(rowSpan))
        text.style.setProperty('--ge-component-column-span', String(columnSpan))
        text.style.setProperty('--ge-component-text-align', component.presentation.align)
        root.append(text)
      }
      return rendered
    } catch (error) {
      rendered.dispose()
      throw error
    }
  }
}
