import type { GameData } from './gameData.js'
import type { GameSave } from '@ancadeba/schemas'
import type { GameInstance, IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { AuthoredPlaythrough } from './authoredRules.js'
import type { GameActionRuntime } from './gameActionRuntime.js'
import type { IGameInput } from './input.js'
import { GameInventory } from './inventory.js'
import { GameSaves, GameSaveError, type GameSaveStore } from './gameSaves.js'
import { GameAutosave } from './gameAutosave.js'
import type { ITaskScheduler } from '@ancadeba/utilities'

interface AuthoredSaveDependencies {
  game: GameData
  lifecycle: IGameLifecycle
  store: GameSaveStore
  scheduler: ITaskScheduler
  isRunning: () => boolean
  settleMessages: () => boolean
  runtimeFor: (game: GameInstance) => GameActionRuntime | undefined
  playthroughFor: (game: GameInstance) => AuthoredPlaythrough | undefined
  input: () => IGameInput | undefined
  onObserverError: (error: unknown) => void
}

/** Coordinates snapshots of the built-in authored runtime; custom runtime state is never silently omitted. */
export function bindAuthoredGameSaves({
  game,
  lifecycle,
  store,
  scheduler,
  isRunning,
  settleMessages,
  runtimeFor,
  playthroughFor,
  input,
  onObserverError,
}: AuthoredSaveDependencies) {
  let lastScene: string | undefined
  let lastGame: GameInstance | undefined

  const prepare = (save: GameSave, instance: GameInstance) => {
    const playthrough = playthroughFor(instance)

    if (playthrough) playthrough.restore(save)
    else if (save.state.length || save.log.length) throw new GameSaveError('incompatible-save')

    if (instance.inventory instanceof GameInventory) instance.inventory.restore(save.inventory)
    else if (Object.keys(save.inventory).length) throw new GameSaveError('incompatible-save')
  }

  const restoreRuntime = (save: GameSave, instance: GameInstance) => {
    const runtime = runtimeFor(instance)

    if (!runtime) throw new GameSaveError('unavailable')
    runtime.restore(save, instance)
  }

  const saves = new GameSaves(
    game.id,
    store,
    () =>
      Boolean(
        isRunning() && lifecycle.currentGame && lifecycle.currentGame === lastGame && lastScene,
      ),
    () => {
      if (!settleMessages()) throw new GameSaveError('busy')
      const instance = lifecycle.currentGame
      const scene = lifecycle.activeScene
      const runtime = instance && runtimeFor(instance)
      const playthrough = instance ? playthroughFor(instance) : undefined

      if (!instance || instance !== lastGame || !runtime || !lastScene)
        throw new GameSaveError('unavailable')

      return {
        'save-version': 1,
        gameId: game.id,
        gameVersion: game.version,
        contentVersion: game.saveCompatibility ?? game.version,
        scene: lastScene,
        language: game.language,
        inputContext: input()?.context,
        ...(playthrough?.save() ?? { state: [], log: [] }),
        inventory: Object.fromEntries(
          (instance.inventory?.snapshot ?? []).map(({ id, ...item }) => [id, item]),
        ),
        progression: { ...runtime.actions.progression },
        ...runtime.save(),
        nearby: Object.fromEntries(
          scene?.type === 'game'
            ? scene.data.components.flatMap((component) => {
                const selection = runtime.nearby?.getSelection(scene, component.id)

                return selection ? [[component.id, selection.entry]] : []
              })
            : [],
        ),
        inventorySelection: Object.fromEntries(
          scene?.type === 'game'
            ? scene.data.components.flatMap((component) => {
                const selection = runtime.inventorySelection?.get(scene, component.id)

                return selection ? [[component.id, selection.item]] : []
              })
            : [],
        ),
        activeDialogue: runtime.dialogue?.activePanel(),
      }
    },
    (save) => {
      if (!isRunning()) throw new GameSaveError('unavailable')
      let candidate: GameInstance | undefined
      let scene: SceneInstance | undefined

      const requireCurrent = () => {
        if (
          !isRunning() ||
          lifecycle.disposed ||
          !candidate ||
          candidate.disposed ||
          lifecycle.currentGame !== candidate ||
          (scene && (scene.disposed || lifecycle.activeScene !== scene))
        )
          throw new GameSaveError('unavailable')

        return candidate
      }

      const complete = (apply: () => void, committed: () => boolean) => {
        try {
          apply()
        } catch (error) {
          if (!isRunning() || lifecycle.disposed) throw new GameSaveError('unavailable')

          if (!committed()) throw error
          onObserverError(error)
        }
      }

      // A lifecycle call can throw after committing and releasing the previous game.
      complete(
        () =>
          lifecycle.startGame(
            (instance) => prepare(save, instance),
            (instance) => {
              restoreRuntime(save, instance)
              candidate = instance
            },
          ),
        () => Boolean(candidate && lifecycle.currentGame === candidate && !candidate.disposed),
      )
      const instance = requireCurrent()

      const step = (apply: () => void, committed: () => boolean = () => true) => {
        requireCurrent()
        complete(apply, () => {
          requireCurrent()

          return committed()
        })
        requireCurrent()
      }

      const { language, activeDialogue, inputContext } = save
      const localization = game.localization

      if (language && localization?.available.some(({ tag }) => tag === language))
        step(() => localization.select(language))

      const isSavedScene = () => {
        const active = lifecycle.activeScene

        return active?.type === 'game' && active.game === instance && active.data.id === save.scene
      }

      step(() => lifecycle.enterScene(save.scene), isSavedScene)

      if (!isSavedScene()) throw new GameSaveError('unavailable')
      scene = lifecycle.activeScene!
      const active = scene
      const runtime = runtimeFor(instance)!

      // Validated setters commit before notifying; an observer must not skip later setters.
      for (const [panel, entry] of Object.entries(save.nearby))
        step(() => runtime.nearby?.select(active, panel, entry))

      for (const [panel, item] of Object.entries(save.inventorySelection))
        step(() => runtime.inventorySelection?.select(active, panel, item))

      if (activeDialogue) step(() => runtime.dialogue?.resume(active, activeDialogue))
      step(() => runtime.bindings.invalidate())

      if (inputContext) step(() => input()?.setContext(inputContext))
    },
    (save) =>
      save.gameId === game.id &&
      save.gameVersion === game.version &&
      save.contentVersion === (game.saveCompatibility ?? game.version) &&
      game.scenes.get(save.scene)?.type === 'game' &&
      (save.inputContext === undefined ||
        Object.hasOwn(game.input?.contexts ?? {}, save.inputContext)),
    (save) => {
      if (!isRunning()) throw new GameSaveError('unavailable')
      lifecycle.validateGame(
        (instance) => prepare(save, instance),
        (instance) => restoreRuntime(save, instance),
      )
    },
    onObserverError,
  )

  const unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => {
    if (current?.type === 'game') {
      lastScene = current.data.id
      lastGame = current.game
    } else if (!lifecycle.currentGame) {
      lastScene = undefined
      lastGame = undefined
    }

    saves.notify()
  })

  const autosave = new GameAutosave(lifecycle, scheduler, () => {
    saves.autosave()
  })

  const dispose = () => {
    autosave.dispose()
    unsubscribe()
  }

  return { saves, dispose }
}
