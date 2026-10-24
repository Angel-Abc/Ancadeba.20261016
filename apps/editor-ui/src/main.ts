import './style.css'
import { createEngine } from '@ancadeba/game-runtime'
import { ConsoleLogger, type IConsole } from '@ancadeba/utilities'
import { EditorWorkspaceResources } from './workspaceResources'
import { EditorPreviewController } from './previewController'
import { EditorPreviewHost } from './previewHost'

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

const consoleAdapter: IConsole = {
  debug: (message, ...args) => {
    console.debug(message, ...args)
    return message
  },
  info: (message, ...args) => {
    console.info(message, ...args)
    return message
  },
  warn: (message, ...args) => {
    console.warn(message, ...args)
    return message
  },
  error: (message, ...args) => {
    console.error(message, ...args)
    return message
  },
  log: (message, ...args) => {
    console.log(message, ...args)
    return message
  },
}
const logger = new ConsoleLogger(consoleAdapter)
const host = new EditorPreviewHost(content)
const controller = new EditorPreviewController(
  (gameFolder) =>
    createEngine({
      resourceSource: new EditorWorkspaceResources(gameFolder, fetch),
      host,
      logger,
    }),
  (state, message) => {
    panel.dataset.state = state
    status.textContent = { stopped: 'Stopped', starting: 'Starting…', running: 'Running' }[state]
    start.disabled = state !== 'stopped'
    stop.disabled = state === 'stopped'
    folder.disabled = state !== 'stopped'
    content.setAttribute('aria-busy', String(state === 'starting'))
    empty.hidden = state === 'running'
    empty.textContent =
      state === 'starting' ? 'Loading game.json…' : 'Start the engine to preview the game.'
    error.textContent = message ? `Unable to start preview: ${message}` : ''
    error.hidden = !message
  },
)

function onStart(event: SubmitEvent): void {
  event.preventDefault()
  void controller.start(folder.value)
}

const onStop = () => controller.stop()
form.addEventListener('submit', onStart)
stop.addEventListener('click', onStop)
controller.stop()

import.meta.hot?.dispose(() => {
  form.removeEventListener('submit', onStart)
  stop.removeEventListener('click', onStop)
  controller.dispose()
})
