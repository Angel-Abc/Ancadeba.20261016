import {
  renameProjectRequestSchema,
  restoreProjectRequestSchema,
  type DeletedProject,
} from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import type { HttpEditorClient } from './editorClient.js'
import type { ProjectEditorController, ProjectEditorState } from './projectController.js'
import { gameTitle } from './projectTree.js'

/** Project folder actions and recoverable deletion, separate from authoring forms. */
export function bindProjectManagementPanel(
  root: HTMLElement,
  client: HttpEditorClient,
  controller: ProjectEditorController,
  t: Translate,
  allowDiscard: () => boolean,
  confirmDelete: (message: string) => boolean,
) {
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const renameToggle = find<HTMLButtonElement>('project-rename-toggle')
  const renameForm = find<HTMLFormElement>('project-rename-controls')
  const renameFields = find<HTMLFieldSetElement>('project-rename-fields')
  const title = find<HTMLInputElement>('project-rename-title')
  const folder = find<HTMLInputElement>('project-rename-folder')
  const remove = find<HTMLButtonElement>('project-delete')
  const trashToggle = find<HTMLButtonElement>('project-trash-toggle')
  const trash = find<HTMLElement>('project-trash-controls')
  const trashSelect = find<HTMLSelectElement>('project-trash-list')
  const destination = find<HTMLInputElement>('project-restore-folder')
  const restore = find<HTMLButtonElement>('project-restore')
  const feedback = find<HTMLElement>('project-management-feedback')
  const listeners: (() => void)[] = []
  let state: ProjectEditorState | undefined
  let deleted: DeletedProject[] = []
  let disposed = false
  let listing = false
  let sequence = 0
  let notice = ''

  const on = (target: EventTarget, event: string, listener: EventListener) => {
    target.addEventListener(event, listener)
    listeners.push(() => target.removeEventListener(event, listener))
  }

  const controls = () => {
    renameToggle.disabled = !state?.view || state.busy
    renameFields.disabled = !state?.view || state.busy
    folder.disabled = !state?.path || Boolean(state.busy)
    title.disabled = !state?.view?.game || Boolean(state.busy)
    remove.disabled = !state?.path || !state.view || state.busy
    trashToggle.disabled = Boolean(state?.busy) || listing
    trashSelect.disabled = Boolean(state?.busy) || listing || !deleted.length
    destination.disabled = trashSelect.disabled
    restore.disabled = trashSelect.disabled
    feedback.textContent = t(notice)
    feedback.hidden = !notice
  }

  const selectDeleted = () => {
    destination.value = deleted.find(({ trashId }) => trashId === trashSelect.value)?.path ?? ''
  }

  const list = async (keepNotice = false) => {
    const request = ++sequence
    listing = true

    if (!keepNotice) notice = ''
    controls()

    try {
      const result = await client.listDeleted()

      if (disposed || request !== sequence) return
      deleted = result
      trashSelect.replaceChildren(
        ...deleted.map((entry) => {
          const option = root.ownerDocument.createElement('option')
          option.value = entry.trashId
          option.textContent = `${entry.title} (${entry.path}) — ${entry.deletedAt}`

          return option
        }),
      )
      selectDeleted()

      if (!result.length && !keepNotice) notice = 'project.trashEmpty'
    } catch (error) {
      if (!disposed && request === sequence)
        notice = error instanceof Error ? error.message : String(error)
    } finally {
      if (!disposed && request === sequence) {
        listing = false
        controls()
      }
    }
  }

  on(renameToggle, 'click', () => {
    if (renameToggle.disabled) return
    renameForm.hidden = !renameForm.hidden
    renameToggle.setAttribute('aria-expanded', String(!renameForm.hidden))

    if (!renameForm.hidden) {
      title.value = state?.view?.game?.title ?? ''
      folder.value = state?.path.split('/').at(-1) ?? ''
      const focus = title.disabled ? folder : title
      focus.focus()
    }
  })
  on(find('project-rename-cancel'), 'click', () => {
    renameForm.hidden = true
    renameToggle.setAttribute('aria-expanded', 'false')
    renameToggle.focus()
  })
  on(renameForm, 'submit', (event) => {
    event.preventDefault()

    if (!state?.view || state.busy) return

    const request = renameProjectRequestSchema.safeParse({
      path: state.path,
      expectedRevision: state.view.revision,
      ...(state.view.game && title.value !== state.view.game.title ? { title: title.value } : {}),
      ...(state.path && folder.value !== state.path.split('/').at(-1)
        ? { folderName: folder.value }
        : {}),
    })

    if (!request.success) {
      notice = 'project.invalidRename'
      controls()

      return
    }

    if (allowDiscard()) void controller.rename(request.data)
  })
  on(remove, 'click', () => {
    if (remove.disabled || !allowDiscard()) return

    if (
      confirmDelete(
        t('project.confirmDelete', {
          title: state?.view ? gameTitle(state.view) || state.path : '',
          path: state?.path ?? '',
        }),
      )
    )
      void controller.delete()
  })
  on(trashToggle, 'click', () => {
    if (trashToggle.disabled) return
    trash.hidden = !trash.hidden
    trashToggle.setAttribute('aria-expanded', String(!trash.hidden))

    if (!trash.hidden) void list()
  })
  on(trashSelect, 'change', selectDeleted)
  on(restore, 'click', () => {
    if (restore.disabled) return
    const selected = deleted.find(({ trashId }) => trashId === trashSelect.value)

    if (!selected) return

    const request = restoreProjectRequestSchema.safeParse({
      trashId: selected.trashId,
      expectedRevision: selected.revision,
      destination: destination.value,
    })

    if (!request.success) {
      notice = 'project.invalidRestore'
      controls()

      return
    }

    if (allowDiscard()) void controller.restoreProject(request.data)
  })
  controls()

  return {
    render(next: ProjectEditorState, replaceFields: boolean) {
      if (next.view && (!state?.view || state.path !== next.path)) {
        renameForm.hidden = true
        renameToggle.setAttribute('aria-expanded', 'false')
      }

      state = next

      if (next.busy) notice = ''
      else if (next.error) notice = next.error

      if (replaceFields && next.projectChange) {
        renameForm.hidden = true
        renameToggle.setAttribute('aria-expanded', 'false')
        notice = `project.${next.projectChange.kind}`

        if (next.projectChange.kind === 'deleted') {
          trash.hidden = false
          trashToggle.setAttribute('aria-expanded', 'true')
        }

        if (!trash.hidden) void list(true)
      }

      controls()
    },
    dispose() {
      disposed = true
      sequence++

      for (const removeListener of listeners) removeListener()
    },
  }
}
