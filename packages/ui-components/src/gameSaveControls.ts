import type { GameData, GameSaveFile, IGameSaves } from '@ancadeba/game-runtime'
import type { RuntimeTextKey } from '@ancadeba/schemas'
import { maxGameSaveBytes, runtimeText } from '@ancadeba/game-runtime'
import { BrowserGameSaveDownload } from './browserGameSaveDownload.js'

export function gameSaveMessages(game: GameData) {
  return {
    save: runtimeText(game, 'save.save'),
    load: runtimeText(game, 'save.load'),
    saved: runtimeText(game, 'save.saved'),
    loaded: runtimeText(game, 'save.loaded'),
    imported: runtimeText(game, 'save.imported'),
    exported: runtimeText(game, 'save.exported'),
    deleted: runtimeText(game, 'save.deleted'),
    confirm: runtimeText(game, 'save.confirm'),
    unavailable: runtimeText(game, 'save.unavailable'),
    storage: runtimeText(game, 'save.storage'),
    'invalid-save': runtimeText(game, 'save.invalid-save'),
    'incompatible-save': runtimeText(game, 'save.incompatible-save'),
    busy: runtimeText(game, 'save.busy'),
    'invalid-name': runtimeText(game, 'save.invalid-name'),
    'too-large': runtimeText(game, 'save.too-large'),
    'delete-unavailable': runtimeText(game, 'save.delete-unavailable'),
  }
}

export function mountGameSaveControls(
  root: HTMLElement,
  game: GameData,
  saves: IGameSaves,
  hasGame: () => boolean,
  download?: (file: GameSaveFile) => void,
): () => void {
  const document = root.ownerDocument
  const controls = document.createElement('div')
  controls.className = 'ancadeba-save-controls'
  const save = document.createElement('button')
  const load = document.createElement('button')
  const exportSave = document.createElement('button')
  const importSave = document.createElement('button')
  const loadAutosave = document.createElement('button')
  const deleteSave = document.createElement('button')
  save.type =
    load.type =
    exportSave.type =
    importSave.type =
    loadAutosave.type =
    deleteSave.type =
      'button'
  const slotLabel = document.createElement('label')
  const slotCaption = document.createElement('span')
  const slot = document.createElement('select')
  slotLabel.append(slotCaption, slot)
  const nameLabel = document.createElement('label')
  const nameCaption = document.createElement('span')
  const name = document.createElement('input')
  name.type = 'text'
  name.maxLength = 80
  nameLabel.append(nameCaption, name)
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = '.json,application/json'
  file.hidden = true
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const autosaveStatus = document.createElement('span')
  autosaveStatus.className = 'ancadeba-autosave-status'
  autosaveStatus.setAttribute('role', 'status')
  autosaveStatus.setAttribute('aria-live', 'polite')
  controls.append(
    slotLabel,
    nameLabel,
    save,
    load,
    loadAutosave,
    exportSave,
    importSave,
    deleteSave,
    file,
    status,
    autosaveStatus,
  )
  root.append(controls)
  const browserDownload = new BrowserGameSaveDownload(document)
  let disposed = false
  let reading = false
  let shownSlot: string | undefined
  let selectionEpoch = 0
  let message: RuntimeTextKey | undefined

  const update = () => {
    const t = gameSaveMessages(game)
    const slots = saves.slots
    const selected = slots.find(({ id }) => id === saves.selectedSlot)

    if (shownSlot !== saves.selectedSlot) {
      shownSlot = saves.selectedSlot
      selectionEpoch++
      name.value = selected?.name ?? ''
      message = undefined
    }

    slot.replaceChildren(
      ...slots.map((saved) => {
        const option = document.createElement('option')
        option.value = saved.id
        option.textContent = runtimeText(game, 'save.slotLabel', {
          slot: saved.id,
          name: !saved.available
            ? runtimeText(game, 'save.slotUnavailable')
            : saved.occupied
              ? saved.name || runtimeText(game, 'save.unnamed')
              : runtimeText(game, 'save.empty'),
        })

        return option
      }),
    )
    slot.value = saves.selectedSlot
    slotCaption.textContent = runtimeText(game, 'save.slot')
    slot.setAttribute('aria-label', slotCaption.textContent)
    nameCaption.textContent = runtimeText(game, 'save.name')
    name.setAttribute('aria-label', nameCaption.textContent)
    save.textContent = t.save
    load.textContent = t.load
    exportSave.textContent = runtimeText(game, 'save.export')
    importSave.textContent = runtimeText(game, 'save.import')
    loadAutosave.textContent = runtimeText(game, 'save.loadAutosave')
    deleteSave.textContent = runtimeText(game, 'save.delete')
    file.setAttribute('aria-label', importSave.textContent)
    slot.disabled = name.disabled = reading
    save.disabled = reading || !saves.canSave
    load.disabled = exportSave.disabled = reading || !saves.canLoad
    importSave.disabled = reading || !saves.canImport
    loadAutosave.disabled = reading || !saves.canLoadAutosave
    deleteSave.disabled = reading || !saves.canDelete
    autosaveStatus.textContent = saves.autosaveError
      ? runtimeText(game, 'save.autosaveError', { error: t[saves.autosaveError] })
      : runtimeText(
          game,
          saves.autosaveStatus === 'saved' ? 'save.autosaved' : 'save.autosaveEnabled',
        )
    status.textContent = reading
      ? runtimeText(game, 'save.reading')
      : message
        ? runtimeText(game, message)
        : saves.error
          ? t[saves.error]
          : saves.status !== 'idle' && saves.status !== 'error'
            ? t[saves.status]
            : ''
  }

  const onSave = () => {
    if (reading || disposed) return
    message = undefined
    saves.save(name.value)
  }

  const onLoad = () => {
    if (reading || disposed) return
    message = undefined

    if (hasGame() && document.defaultView?.confirm(gameSaveMessages(game).confirm) !== true) return
    saves.load()
  }

  const onSlot = () => {
    if (reading || disposed) return
    saves.selectSlot(slot.value)
  }

  const onDelete = () => {
    if (reading || disposed || !saves.canDelete) return
    const selected = saves.slots.find(({ id }) => id === saves.selectedSlot)

    const confirmation = runtimeText(game, 'save.confirmDelete', {
      slot: saves.selectedSlot,
      name: selected?.name || runtimeText(game, 'save.unnamed'),
    })

    if (document.defaultView?.confirm(confirmation) !== true) return
    message = undefined

    if (saves.delete()) name.value = ''
  }

  const onLoadAutosave = () => {
    if (reading || disposed) return

    if (hasGame() && document.defaultView?.confirm(gameSaveMessages(game).confirm) !== true) return
    message = undefined
    saves.loadAutosave()
  }

  const onExport = () => {
    if (reading || disposed) return
    message = undefined
    const snapshot = saves.exportFile()

    if (!snapshot) return

    try {
      if (download) download(snapshot)
      else browserDownload.download(snapshot)
    } catch {
      message = 'save.downloadError'
      update()
    }
  }

  const onImport = () => {
    if (reading || disposed) return
    file.value = ''
    file.click()
  }

  const onFile = async () => {
    const selectedFile = file.files?.[0]

    if (!selectedFile || reading || disposed) return
    message = undefined

    if (selectedFile.size > maxGameSaveBytes) {
      message = 'save.too-large'
      update()

      return
    }

    const epoch = selectionEpoch
    reading = true
    update()

    try {
      const text = await selectedFile.text()

      if (disposed || epoch !== selectionEpoch) return
      const selected = saves.slots.find(({ id }) => id === saves.selectedSlot)

      if (
        selected?.occupied &&
        document.defaultView?.confirm(runtimeText(game, 'save.confirmImport')) !== true
      )
        return
      saves.importFile(text)
      name.value = saves.slots.find(({ id }) => id === saves.selectedSlot)?.name ?? ''
    } catch {
      if (!disposed && epoch === selectionEpoch) message = 'save.fileError'
    } finally {
      reading = false
      file.value = ''

      if (!disposed) update()
    }
  }

  save.addEventListener('click', onSave)
  load.addEventListener('click', onLoad)
  loadAutosave.addEventListener('click', onLoadAutosave)
  deleteSave.addEventListener('click', onDelete)
  slot.addEventListener('change', onSlot)
  exportSave.addEventListener('click', onExport)
  importSave.addEventListener('click', onImport)
  file.addEventListener('change', onFile)
  const unsubscribe = saves.subscribe(update)
  const unsubscribeLanguage = game.localization?.subscribe(update)
  update()

  return () => {
    disposed = true
    unsubscribe()
    unsubscribeLanguage?.()
    save.removeEventListener('click', onSave)
    load.removeEventListener('click', onLoad)
    loadAutosave.removeEventListener('click', onLoadAutosave)
    deleteSave.removeEventListener('click', onDelete)
    slot.removeEventListener('change', onSlot)
    exportSave.removeEventListener('click', onExport)
    importSave.removeEventListener('click', onImport)
    file.removeEventListener('change', onFile)
    browserDownload.dispose()
    controls.remove()
  }
}
