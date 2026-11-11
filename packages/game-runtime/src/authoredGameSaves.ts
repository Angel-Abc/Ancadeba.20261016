import type { GameData } from './gameData.js'
import type { GameInstance, IGameLifecycle } from './gameLifecycle.js'
import type { AuthoredPlaythrough } from './authoredRules.js'
import type { GameActionRuntime } from './gameActionRuntime.js'
import type { IGameInput } from './input.js'
import { GameInventory } from './inventory.js'
import { GameSaves, GameSaveError, type GameSaveStore } from './gameSaves.js'

interface AuthoredSaveDependencies {
  game: GameData
  lifecycle: IGameLifecycle
  store: GameSaveStore
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
  isRunning,
  settleMessages,
  runtimeFor,
  playthroughFor,
  input,
  onObserverError,
}: AuthoredSaveDependencies) {
  let lastScene: string | undefined

  const saves = new GameSaves(
    game.id,
    store,
    () => Boolean(isRunning() && lifecycle.currentGame && lastScene),
    () => {
      if (!settleMessages()) throw new GameSaveError('busy')
      const instance = lifecycle.currentGame
      const scene = lifecycle.activeScene
      const runtime = instance && runtimeFor(instance)
      const playthrough = instance ? playthroughFor(instance) : undefined

      if (!instance || !runtime || !lastScene) throw new GameSaveError('unavailable')

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
      lifecycle.startGame(
        (instance) => {
          const playthrough = playthroughFor(instance)

          if (playthrough) playthrough.restore(save)
          else if (save.state.length || save.log.length)
            throw new GameSaveError('incompatible-save')

          if (instance.inventory instanceof GameInventory)
            instance.inventory.restore(save.inventory)
          else if (Object.keys(save.inventory).length) throw new GameSaveError('incompatible-save')
        },
        (instance) => {
          const runtime = runtimeFor(instance)

          if (!runtime) throw new GameSaveError('unavailable')
          runtime.restore(save, instance)
        },
      )

      if (save.language) game.localization?.select(save.language)
      const scene = lifecycle.enterScene(save.scene)
      const runtime = runtimeFor(lifecycle.currentGame!)!

      for (const [panel, entry] of Object.entries(save.nearby))
        runtime.nearby?.select(scene, panel, entry)

      for (const [panel, item] of Object.entries(save.inventorySelection))
        runtime.inventorySelection?.select(scene, panel, item)

      if (save.activeDialogue) runtime.dialogue?.resume(scene, save.activeDialogue)
      runtime.bindings.invalidate()

      if (save.inputContext) input()?.setContext(save.inputContext)
    },
    (save) =>
      save.gameId === game.id &&
      save.gameVersion === game.version &&
      save.contentVersion === (game.saveCompatibility ?? game.version) &&
      game.scenes.get(save.scene)?.type === 'game' &&
      (save.inputContext === undefined ||
        Object.hasOwn(game.input?.contexts ?? {}, save.inputContext)) &&
      (save.language === undefined ||
        game.localization?.available.some(({ tag }) => tag === save.language) === true),
    onObserverError,
  )

  const dispose = lifecycle.subscribeSceneChanges(({ current }) => {
    if (current?.type === 'game') lastScene = current.data.id
    else if (!lifecycle.currentGame) lastScene = undefined
    saves.notify()
  })

  return { saves, dispose }
}
