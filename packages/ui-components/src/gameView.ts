import type { GameData, IGameLifecycle, SceneData } from '@ancadeba/game-runtime'
import { bindKeyboardInput, type KeyboardInputSink } from './keyboardInput.js'
import { SceneRenderer, type SceneRendererOptions } from './sceneRenderer.js'

export interface GameViewSession {
  readonly lifecycle: IGameLifecycle
  readonly input: KeyboardInputSink | undefined
}

export interface GameViewOptions extends SceneRendererOptions {
  readonly scenePicker?: boolean
}

/** Shared browser surface for the standalone engine and the editor preview. */
export function mountGameView(
  target: HTMLElement,
  game: GameData,
  session: GameViewSession,
  options: GameViewOptions = {},
): () => void {
  const document = target.ownerDocument
  const root = document.createElement('section')
  root.className = 'ancadeba-game'
  root.tabIndex = 0
  root.setAttribute('aria-label', game.title)
  const viewport = document.createElement('div')
  viewport.className = 'ancadeba-scene-viewport'
  const cleanups: (() => void)[] = []
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    const errors: unknown[] = []
    try {
      for (const release of [...cleanups].reverse()) {
        try {
          release()
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      root.remove()
    }
    if (errors.length) throw new AggregateError(errors, 'Game view cleanup failed')
  }

  const enter = (scene: SceneData) => {
    if (scene.type === 'game' && !session.lifecycle.currentGame) session.lifecycle.startGame()
    session.lifecycle.enterScene(scene.id)
  }

  try {
    if (options.scenePicker) {
      const label = document.createElement('label')
      label.className = 'ancadeba-scene-picker'
      const caption = document.createElement('span')
      caption.textContent = 'Scene'
      const select = document.createElement('select')
      select.setAttribute('aria-label', 'Preview scene')
      const empty = document.createElement('option')
      empty.value = ''
      empty.textContent = 'No active scene'
      select.append(empty)
      for (const scene of game.scenes.values()) {
        const option = document.createElement('option')
        option.value = scene.id
        option.textContent = scene.title
        select.append(option)
      }
      const syncSelection = () => {
        select.value = session.lifecycle.activeScene?.data.id ?? ''
      }
      syncSelection()
      const onChange = () => {
        try {
          if (!select.value) session.lifecycle.leaveScene()
          else {
            const scene = game.scenes.get(select.value)
            if (scene) enter(scene)
          }
        } finally {
          syncSelection()
        }
      }
      select.addEventListener('change', onChange)
      cleanups.push(() => select.removeEventListener('change', onChange))
      cleanups.push(session.lifecycle.subscribeSceneChanges(syncSelection))
      label.append(caption, select)
      root.append(label)
    }

    root.append(viewport)
    target.append(root)
    const renderer = new SceneRenderer(viewport, session.lifecycle, options)
    cleanups.push(() => renderer.dispose())
    if (session.input) cleanups.push(bindKeyboardInput(root, session.input))
    if (!session.lifecycle.activeScene) {
      const first = game.scenes.values().next().value
      if (first) enter(first)
    }
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}
