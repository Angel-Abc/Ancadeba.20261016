import './style.css'
import type { EngineState } from '@ancadeba/game-runtime'
import { createBrowserTiming } from '@ancadeba/ui-components'
import { EditorPreviewHost } from './previewHost'
import { ContainerBuilder } from './ioc/containerBuilder'

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector)
  if (!result) throw new Error(`Missing editor element: ${selector}`)
  return result
}

const form = element<HTMLFormElement>('#preview-form')
const folder = element<HTMLInputElement>('#game-folder')
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

function updateControls(): void {
  start.disabled = previewState !== 'stopped' || exporting
  stop.disabled = previewState === 'stopped'
  folder.disabled = previewState !== 'stopped' || exporting
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
  host: new EditorPreviewHost(content),
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
    exportButton.textContent = exporting ? 'Exporting…' : 'Export'
    exportStatus.textContent = exporting
      ? 'Building the game from its saved workspace files…'
      : state === 'ready'
        ? `Export ready: ${message ?? 'game.zip'}`
        : ''
    exportError.textContent =
      state === 'error' ? `Unable to export game: ${message ?? 'Export failed'}` : ''
    exportError.hidden = state !== 'error'
    if (state === 'exporting' || state === 'error') clearDownload()
    updateControls()
  },
  onPreviewStateChange: (state, message) => {
    previewState = state
    panel.dataset.state = state
    status.textContent = { stopped: 'Stopped', starting: 'Starting…', running: 'Running' }[state]
    updateControls()
    content.setAttribute('aria-busy', String(state === 'starting'))
    empty.hidden = state === 'running'
    empty.textContent =
      state === 'starting' ? 'Loading game.json…' : 'Start the engine to preview the game.'
    error.textContent = message ? `Unable to start preview: ${message}` : ''
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

import.meta.hot?.dispose(() => {
  form.removeEventListener('submit', onStart)
  stop.removeEventListener('click', onStop)
  exportButton.removeEventListener('click', onExport)
  exportController.dispose()
  clearDownload()
  controller.dispose()
})
