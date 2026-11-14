import type { Translate } from '@ancadeba/utilities'
import type { ProjectEditorState } from './projectController.js'
import { EditorDraftStore, type EditorDraft } from './editorDraftStore.js'

export function bindEditorDraftRecovery(
  root: HTMLElement,
  store: EditorDraftStore,
  t: Translate,
  capture: () => EditorDraft | undefined,
  hasDrafts: () => boolean,
  restore: (draft: EditorDraft) => string[],
) {
  const window = root.ownerDocument.defaultView
  const panel = root.querySelector<HTMLElement>('#draft-recovery')
  const message = root.querySelector<HTMLElement>('#draft-recovery-message')
  const recover = root.querySelector<HTMLButtonElement>('#draft-restore')
  const discard = root.querySelector<HTMLButtonElement>('#draft-discard')
  let pending: ReturnType<EditorDraftStore['latest']>
  let currentPath: string | undefined
  let paused = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let notice = ''
  let busy = false
  const listeners: (() => void)[] = []

  const render = () => {
    if (panel) panel.hidden = !pending && !notice

    if (message) message.textContent = t(pending ? 'drafts.available' : notice)

    if (recover) {
      recover.hidden = !pending
      recover.disabled = busy
      recover.textContent = t('drafts.restore')
    }

    if (discard) {
      discard.hidden = !pending
      discard.disabled = busy
      discard.textContent = t('drafts.discard')
    }
  }

  const checkpoint = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (paused || disposed || currentPath === undefined) return

    if (pending && !hasDrafts()) return

    try {
      if (hasDrafts()) {
        const draft = capture()

        if (draft) store.write(draft)
      } else {
        store.clear(currentPath)
        notice = ''
      }
    } catch {
      notice = 'drafts.storageError'
    }

    render()
  }

  const schedule = () => {
    if (!timer && !disposed) timer = setTimeout(checkpoint, 250)
  }

  const on = (
    target: EventTarget | null,
    event: string,
    listener: EventListener,
    capture = false,
  ) => {
    target?.addEventListener?.(event, listener, capture)
    listeners.push(() => target?.removeEventListener?.(event, listener, capture))
  }

  on(recover, 'click', () => {
    if (!pending || busy) return

    if (hasDrafts() && window?.confirm(t('drafts.replaceCurrent')) !== true) return
    const source = pending
    paused = true
    let failed: string[]

    try {
      failed = restore(source.draft)
    } catch {
      failed = Object.keys(source.draft.drafts)
    } finally {
      paused = false
    }

    pending = undefined
    notice = failed.length ? 'drafts.partial' : 'drafts.restored'

    // Keep the source record if any part could not be restored or stored again.
    if (!failed.length) {
      try {
        const draft = capture()

        if (draft) {
          const key = store.write(draft)

          if (key !== source.key) store.discard(source.key)
        }
      } catch {
        notice = 'drafts.storageError'
      }
    }

    render()
  })
  on(discard, 'click', () => {
    if (!pending || busy) return

    try {
      store.discard(pending.key)
      pending = undefined
      notice = ''
    } catch {
      notice = 'drafts.storageError'
    }

    render()
  })

  for (const event of [
    'input',
    'change',
    'click',
    'pointerdown',
    'pointerenter',
    'pointerup',
    'keyup',
  ])
    on(root, event, schedule, true)
  on(window, 'beforeunload', (event) => {
    checkpoint()

    if (!hasDrafts()) return
    event.preventDefault()
    // Browsers display their own warning text; returnValue supports older implementations.
    Reflect.set(event, 'returnValue', '')
  })
  on(window, 'pagehide', checkpoint)
  on(root.ownerDocument, 'visibilitychange', () => {
    if (root.ownerDocument.hidden) checkpoint()
  })

  return {
    beforeRender() {
      checkpoint()
    },
    afterRender(state: ProjectEditorState) {
      busy = state.busy
      render()

      if (!state.view) {
        currentPath = undefined
        pending = undefined
        notice = ''
        render()

        return
      }

      if (paused || state.busy) return

      if (currentPath !== state.path) {
        currentPath = state.path
        notice = ''

        try {
          pending = store.latest(state.path)
        } catch {
          notice = 'drafts.storageError'
        }

        render()
      } else schedule()

      if (recover) recover.disabled = state.busy

      if (discard) discard.disabled = state.busy
    },
    languageChanged: render,
    dispose() {
      checkpoint()
      disposed = true

      if (timer) clearTimeout(timer)

      for (const remove of listeners) remove()
    },
  }
}
