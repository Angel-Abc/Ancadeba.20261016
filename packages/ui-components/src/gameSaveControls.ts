import type { GameData, IGameSaves } from '@ancadeba/game-runtime'

const messages = {
  en: {
    save: 'Save progress',
    load: 'Load progress',
    saved: 'Progress saved on this device.',
    loaded: 'Saved progress loaded.',
    confirm: 'Load saved progress? Unsaved progress will be replaced.',
    unavailable: 'Start a game before saving, or save a game before loading.',
    storage: 'Browser storage is unavailable or full. Your progress could not be saved or loaded.',
    'invalid-save': 'The saved game is damaged or invalid. Your current progress is unchanged.',
    'incompatible-save':
      'This save belongs to a different game or content version. Your current progress is unchanged.',
    busy: 'Wait for movement to finish before saving.',
  },
  nl: {
    save: 'Voortgang opslaan',
    load: 'Voortgang laden',
    saved: 'Voortgang opgeslagen op dit apparaat.',
    loaded: 'Opgeslagen voortgang geladen.',
    confirm: 'Opgeslagen voortgang laden? Niet-opgeslagen voortgang wordt vervangen.',
    unavailable: 'Start een spel om op te slaan, of sla een spel op om het te laden.',
    storage: 'Browseropslag is niet beschikbaar of vol. Opslaan of laden is niet gelukt.',
    'invalid-save':
      'Het opgeslagen spel is beschadigd of ongeldig. Je huidige voortgang is behouden.',
    'incompatible-save':
      'Deze opslag hoort bij een ander spel of een andere inhoudsversie. Je huidige voortgang is behouden.',
    busy: 'Wacht tot de beweging klaar is voordat je opslaat.',
  },
} as const

export function gameSaveMessages(game: GameData) {
  return messages[game.language?.toLowerCase().startsWith('nl') ? 'nl' : 'en']
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
