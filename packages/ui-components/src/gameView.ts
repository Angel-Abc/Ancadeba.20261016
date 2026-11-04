import type { GameData, IGameLifecycle, SceneData } from '@ancadeba/game-runtime'
import { bindKeyboardInput, type KeyboardInputSink } from './keyboardInput.js'
import { SceneRenderer, type SceneRendererOptions } from './sceneRenderer.js'
import { mountGameStylesheet } from './gameStylesheet.js'

export interface GameViewSession {
  readonly lifecycle: IGameLifecycle
  readonly input: KeyboardInputSink | undefined
}

export interface GameViewOptions extends SceneRendererOptions {
  readonly scenePicker?: boolean
  readonly scenePickerLabels?: {
    readonly caption: string
    readonly accessibleName: string
    readonly empty: string
  }
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
  const localization = options.localization ?? game.localization

  const syncMetadata = () => {
    const content = localization?.current ?? game
    root.setAttribute('aria-label', content.title)

    if (content.language) root.setAttribute('lang', content.language)
  }

  syncMetadata()
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
    if (localization) cleanups.push(localization.subscribe(syncMetadata))

    if (options.scenePicker) {
      const label = document.createElement('label')
      label.className = 'ancadeba-scene-picker'
      const caption = document.createElement('span')
      caption.textContent = options.scenePickerLabels?.caption ?? 'Scene'
      const select = document.createElement('select')
      select.setAttribute(
        'aria-label',
        options.scenePickerLabels?.accessibleName ?? 'Preview scene',
      )
      const empty = document.createElement('option')
      empty.value = ''
      empty.textContent = options.scenePickerLabels?.empty ?? 'No active scene'
      select.append(empty)

      const sceneOptions = new Map<string, HTMLOptionElement>()

      for (const scene of (localization?.current ?? game).scenes.values()) {
        const option = document.createElement('option')
        option.value = scene.id
        option.textContent = scene.title
        sceneOptions.set(scene.id, option)
        select.append(option)
      }

      if (localization)
        cleanups.push(
          localization.subscribe(() => {
            for (const [id, option] of sceneOptions) {
              option.textContent = localization.current.scenes.get(id)?.title ?? id
            }
          }),
        )

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

    if (game.stylesheet !== undefined) mountGameStylesheet(viewport, game.stylesheet)

    const renderer = new SceneRenderer(viewport, session.lifecycle, {
      ...options,
      assets: game.assets,
      localization,
      onButtonActivate: (action) => {
        if (disposed) return
        const scene = game.scenes.get(action.scene)

        if (!scene) throw new Error(`Missing button target scene: ${action.scene}`)

        if (action.type === 'new-game') session.lifecycle.startGame()
        enter(scene)
      },
    })

    cleanups.push(() => renderer.dispose())

    if (session.input) cleanups.push(bindKeyboardInput(root, session.input))

    if (!session.lifecycle.activeScene) {
      const first =
        game.initialScene === undefined
          ? game.scenes.values().next().value
          : game.scenes.get(game.initialScene)

      if (first) enter(first)
    }

    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}
