import './style.css'
import '@ancadeba/ui-components/game.css'
import { bindProjectPanel } from './projectPanel.js'
import type { EngineState } from '@ancadeba/game-runtime'
import {
  createBrowserTiming,
  BrowserGameLanguagePreferences,
  BrowserGameSaveStore,
} from '@ancadeba/ui-components'
import { EditorPreviewHost } from './previewHost'
import { ContainerBuilder } from './ioc/containerBuilder'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import type { ExportState } from './exportController.js'
import { bindWorkspaceLayout } from './workspaceLayout.js'

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
const gameLanguage = element<HTMLInputElement>('#game-language')
const editorLanguage = element<HTMLSelectElement>('#editor-language')

editorLanguage.value = localization.language

const start = element<HTMLButtonElement>('#preview-start')
const stop = element<HTMLButtonElement>('#preview-stop')
const panel = element<HTMLElement>('#preview-pane')
const status = element<HTMLElement>('#preview-status')
const error = element<HTMLElement>('#preview-error')
const content = element<HTMLElement>('#preview-content')
const empty = element<HTMLElement>('#preview-empty')
const exportButton = element<HTMLButtonElement>('#game-export')
const exportStatus = element<HTMLElement>('#export-status')
const exportError = element<HTMLElement>('#export-error')
const exportDownload = element<HTMLAnchorElement>('#export-download')

const layout = bindWorkspaceLayout(
  {
    shell: element('#app'),
    modes: element('#layout-modes'),
    workspace: element('#editor-workspace'),
    splitter: element('#preview-splitter'),
    preview: panel,
  },
  () => window.localStorage,
)

let projectPath: string | undefined
let previewState: EngineState = 'stopped'
let exporting = false
let downloadUrl: string | undefined
let exportState: ExportState = 'idle'
let exportMessage: string | undefined
let previewMessage: string | undefined
let selectedScene: { id: string; title: string } | undefined

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

function renderStartLabel(): void {
  start.title = selectedScene
    ? t('preview.startScene', { scene: selectedScene.title })
    : t('preview.startGame')
}

function updateControls(): void {
  start.disabled = projectPath === undefined || previewState !== 'stopped' || exporting
  stop.disabled = previewState === 'stopped'
  gameLanguage.disabled = previewState !== 'stopped' || exporting
  exportButton.disabled = projectPath === undefined || exporting || previewState === 'starting'
}

function clearDownload(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = undefined
  exportDownload.removeAttribute('href')
  exportDownload.hidden = true
}

const projectSaveKeys = new Map<string, string>()

const container = new ContainerBuilder({
  fetcher: fetch,
  host: new EditorPreviewHost(
    content,
    t,
    subscribeLanguageChanges,
    undefined,
    () => selectedScene?.id,
  ),
  createHost: (source) =>
    new EditorPreviewHost(content, t, subscribeLanguageChanges, source, () => selectedScene?.id),
  gameLanguagePreferences: new BrowserGameLanguagePreferences(() => window.localStorage),
  getPreferredGameLanguages: () => {
    return gameLanguage.value.trim() ? [gameLanguage.value.trim()] : []
  },
  runtime: createBrowserTiming(window),
  createGameSaveStore: (folder) =>
    new BrowserGameSaveStore(
      () => window.localStorage,
      `editor-preview:${projectSaveKeys.get(folder) ?? folder}`,
    ),
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

    if (state !== 'ready') clearDownload()
    updateControls()
  },
  confirmExport: () => !projectPanel.hasDrafts() || window.confirm(t('export.unsaved')),
  confirmPreview: () => !projectPanel.hasDrafts() || window.confirm(t('preview.unsaved')),
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

  if (projectPath === undefined) return

  layout.revealPreview()
  void controller.start(projectPath)
}

const onStop = () => controller.stop()

const onExport = () => {
  if (projectPath !== undefined) void exportController.export(projectPath)
}

form.addEventListener('submit', onStart)

renderStartLabel()

stop.addEventListener('click', onStop)

exportButton.addEventListener('click', onExport)

controller.stop()

const projectPanel = bindProjectPanel(
  element<HTMLElement>('#app'),
  fetch,
  t,
  subscribeLanguageChanges,
  {
    onProjectChange(path, storageKey) {
      const restartPreview = previewState !== 'stopped'
      projectPath = path
      projectSaveKeys.set(path, storageKey ?? path)
      exportController.reset()
      controller.stop()

      if (restartPreview) void controller.start(path, { confirm: false })
    },
    onProjectClose() {
      projectPath = undefined
      selectedScene = undefined
      exportController.reset()
      controller.stop()
      renderStartLabel()
    },
    onSceneSelect(scene) {
      selectedScene = scene
      renderStartLabel()
    },
  },
)

const onLanguageChange = () => {
  localization = editorLocalization([editorLanguage.value])
  translatePage()
  renderExportState()
  renderPreviewState()
  renderStartLabel()

  for (const listener of languageListeners) listener()
}

editorLanguage.addEventListener('change', onLanguageChange)

import.meta.hot?.dispose(() => {
  projectPanel.dispose()
  layout.dispose()
  editorLanguage.removeEventListener('change', onLanguageChange)
  form.removeEventListener('submit', onStart)
  stop.removeEventListener('click', onStop)
  exportButton.removeEventListener('click', onExport)
  exportController.dispose()
  clearDownload()
  controller.dispose()
})
