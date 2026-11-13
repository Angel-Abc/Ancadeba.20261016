import type { GameData, IGameSaves } from '@ancadeba/game-runtime'
import { runtimeText } from '@ancadeba/game-runtime'

export function gameSaveMessages(game: GameData) {
  return {
    save: runtimeText(game, 'save.save'),
    load: runtimeText(game, 'save.load'),
    saved: runtimeText(game, 'save.saved'),
    loaded: runtimeText(game, 'save.loaded'),
    confirm: runtimeText(game, 'save.confirm'),
    unavailable: runtimeText(game, 'save.unavailable'),
    storage: runtimeText(game, 'save.storage'),
    'invalid-save': runtimeText(game, 'save.invalid-save'),
    'incompatible-save': runtimeText(game, 'save.incompatible-save'),
    busy: runtimeText(game, 'save.busy'),
  }
}

export function mountGameSaveControls(
  root: HTMLElement,
  game: GameData,
  saves: IGameSaves,
  hasGame: () => boolean,
): () => void {
  const document = root.ownerDocument
  const controls = document.createElement('div')
  controls.className = 'ancadeba-save-controls'
  const save = document.createElement('button')
  const load = document.createElement('button')
  save.type = load.type = 'button'
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  controls.append(save, load, status)
  root.append(controls)

  const update = () => {
    const t = gameSaveMessages(game)
    save.textContent = t.save
    load.textContent = t.load
    save.disabled = !saves.canSave
    load.disabled = !saves.canLoad
    status.textContent =
      saves.status === 'saved'
        ? t.saved
        : saves.status === 'loaded'
          ? t.loaded
          : saves.error
            ? t[saves.error]
            : ''
  }

  const onSave = () => {
    saves.save()
  }

  const onLoad = () => {
    if (hasGame() && document.defaultView?.confirm(gameSaveMessages(game).confirm) !== true) return
    saves.load()
  }

  save.addEventListener('click', onSave)
  load.addEventListener('click', onLoad)
  const unsubscribe = saves.subscribe(update)
  const unsubscribeLanguage = game.localization?.subscribe(update)
  update()

  return () => {
    unsubscribe()
    unsubscribeLanguage?.()
    save.removeEventListener('click', onSave)
    load.removeEventListener('click', onLoad)
    controls.remove()
  }
}
