import './style.css'
import '@ancadeba/ui-components/game.css'
import { bindProjectPanel } from './projectPanel.js'
import type { EngineState } from '@ancadeba/game-runtime'
import { createBrowserTiming, BrowserGameLanguagePreferences } from '@ancadeba/ui-components'
import { EditorPreviewHost } from './previewHost'
import { ContainerBuilder } from './ioc/containerBuilder'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import type { ExportState } from './exportController.js'

let localization = editorLocalization()
const t: Translate = (key, values) => localization.t(key, values)
const languageListeners = new Set<() => void>()

const subscribeLanguageChanges = (listener: () => void) => {
  languageListeners.add(listener)

  return () => {
    languageListeners.delete(listener)
  }
}

function translatePage(): void {
  document.documentElement.lang = localization.language

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n!)
  }

  for (const attribute of ['placeholder', 'aria-label']) {
    for (const node of document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)!))
    }
  }
}

translatePage()

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector)

  if (!result) throw new Error(`Missing editor element: ${selector}`)

  return result
}

const form = element<HTMLFormElement>('#preview-form')
const folder = element<HTMLInputElement>('#game-folder')
const gameLanguage = element<HTMLInputElement>('#game-language')
const editorLanguage = element<HTMLSelectElement>('#editor-language')

editorLanguage.value = localization.language

const start = element<HTMLButtonElement>('#preview-start')
const stop = element<HTMLButtonElement>('#preview-stop')
const panel = element<HTMLElement>('.preview-panel')
const status = element<HTMLElement>('#preview-status')
const error = element<HTMLElement>('#preview-error')
const content = element<HTMLElement>('#preview-content')
const empty = element<HTMLElement>('#preview-empty')
const exportButton = element<HTMLButtonElement>('#game-export')
const exportStatus = element<HTMLElement>('#export-status')
const exportError = element<HTMLElement>('#export-error')
const exportDownload = element<HTMLAnchorElement>('#export-download')

let previewState: EngineState = 'stopped'
let exporting = false
let downloadUrl: string | undefined
let exportState: ExportState = 'idle'
let exportMessage: string | undefined
let previewMessage: string | undefined

function renderExportState(): void {
  exportButton.textContent = t(exporting ? 'export.exporting' : 'export.button')
  exportStatus.textContent = exporting
    ? t('export.building')
    : exportState === 'ready'
      ? t('export.ready', { file: exportMessage ?? 'game.zip' })
      : ''
  exportError.textContent =
    exportState === 'error'
      ? t('export.error', { message: exportMessage ?? t('export.failed') })
      : ''
}

function renderPreviewState(): void {
  status.textContent = t(`preview.${previewState}`)
  empty.textContent = t(previewState === 'starting' ? 'preview.loading' : 'preview.empty')
  error.textContent = previewMessage ? t('preview.error', { message: previewMessage }) : ''
}

function updateControls(): void {
  start.disabled = previewState !== 'stopped' || exporting
  stop.disabled = previewState === 'stopped'
  folder.disabled = previewState !== 'stopped' || exporting
  gameLanguage.disabled = previewState !== 'stopped' || exporting
  exportButton.disabled = exporting || previewState === 'starting'
}

function clearDownload(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = undefined
  exportDownload.removeAttribute('href')
  exportDownload.hidden = true
}

const container = new ContainerBuilder({
  fetcher: fetch,
  host: new EditorPreviewHost(content, t, subscribeLanguageChanges),
  createHost: (source) => new EditorPreviewHost(content, t, subscribeLanguageChanges, source),
  gameLanguagePreferences: new BrowserGameLanguagePreferences(() => window.localStorage),
  getPreferredGameLanguages: () => {
    return gameLanguage.value.trim() ? [gameLanguage.value.trim()] : []
  },
  runtime: createBrowserTiming(window),
  download: (archive, fileName) => {
    clearDownload()
    downloadUrl = URL.createObjectURL(archive)
    exportDownload.href = downloadUrl
    exportDownload.download = fileName
    exportDownload.hidden = false
    exportDownload.click()
  },
  onExportStateChange: (state, message) => {
    exporting = state === 'exporting'
    exportState = state
    exportMessage = message
    renderExportState()
    exportError.hidden = state !== 'error'

    if (state === 'exporting' || state === 'error') clearDownload()
    updateControls()
  },
  onPreviewStateChange: (state, message) => {
    previewState = state
    previewMessage = message
    panel.dataset.state = state
    renderPreviewState()
    updateControls()
    content.setAttribute('aria-busy', String(state === 'starting'))
    empty.hidden = state === 'running'
    error.hidden = !message
  },
}).build()

const controller = container.resolve('previewController')
const exportController = container.resolve('exportController')

function onStart(event: SubmitEvent): void {
  event.preventDefault()
  void controller.start(folder.value)
}

const onStop = () => controller.stop()

const onExport = () => {
  void exportController.export(folder.value)
}

form.addEventListener('submit', onStart)

stop.addEventListener('click', onStop)

exportButton.addEventListener('click', onExport)

controller.stop()

const disposeProjectPanel = bindProjectPanel(
  element<HTMLElement>('#app'),
  fetch,
  t,
  subscribeLanguageChanges,
)

const onLanguageChange = () => {
  localization = editorLocalization([editorLanguage.value])
  translatePage()
  renderExportState()
  renderPreviewState()

  for (const listener of languageListeners) listener()
}

editorLanguage.addEventListener('change', onLanguageChange)

import.meta.hot?.dispose(() => {
  disposeProjectPanel()
  editorLanguage.removeEventListener('change', onLanguageChange)
  form.removeEventListener('submit', onStart)
  stop.removeEventListener('click', onStop)
  exportButton.removeEventListener('click', onExport)
  exportController.dispose()
  clearDownload()
  controller.dispose()
})
