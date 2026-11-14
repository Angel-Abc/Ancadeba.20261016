import { projectImportRequestSchema, maxProjectArchiveBytes } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import type { ProjectEditorController, ProjectEditorState } from './projectController.js'

export function bindProjectArchivePanel(
  root: HTMLElement,
  controller: ProjectEditorController,
  t: Translate,
  allowDiscard: () => boolean,
) {
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const toggle = find<HTMLButtonElement>('project-import-toggle')
  const form = find<HTMLFormElement>('project-import-controls')
  const fields = find<HTMLFieldSetElement>('project-import-fields')
  const file = find<HTMLInputElement>('project-import-file')
  const folder = find<HTMLInputElement>('project-import-folder')
  const cancel = find<HTMLButtonElement>('project-import-cancel')
  const submit = find<HTMLButtonElement>('project-import-submit')
  const exportButton = find<HTMLButtonElement>('project-export')
  const feedback = find<HTMLElement>('project-transfer-feedback')
  const download = find<HTMLAnchorElement>('project-export-download')
  const listeners: (() => void)[] = []
  let state: ProjectEditorState | undefined
  let exporting = false
  let importing = false
  let notice = ''
  let objectUrl: string | undefined
  let exportScope: string | undefined
  let disposed = false

  const clearDownload = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
    download.href = ''
    download.hidden = true
  }

  const render = () => {
    toggle.disabled = Boolean(state?.busy)
    fields.disabled = Boolean(state?.busy)
    exportButton.disabled =
      Boolean(state?.busy) || !state?.view?.game || Boolean(state.view.diagnostics.length)
    exportButton.textContent = t(exporting ? 'project.exporting' : 'project.export')
    submit.textContent = t(importing ? 'project.importing' : 'project.import')
    feedback.textContent = t(notice)
    feedback.hidden = !notice
  }

  const on = (target: EventTarget, event: string, listener: EventListener) => {
    target.addEventListener(event, listener)
    listeners.push(() => target.removeEventListener(event, listener))
  }

  on(toggle, 'click', () => {
    if (toggle.disabled) return
    form.hidden = !form.hidden
    toggle.setAttribute('aria-expanded', String(!form.hidden))

    if (!form.hidden) file.focus()
  })
  on(cancel, 'click', () => {
    form.hidden = true
    toggle.setAttribute('aria-expanded', 'false')
    notice = ''
    render()
    toggle.focus()
  })
  on(file, 'change', () => {
    const selected = file.files?.[0]

    if (selected && !folder.value)
      folder.value = `${
        selected.name
          .replace(/(?:-project)?\.zip$/i, '')
          .replace(/[^A-Za-z0-9_-]/g, '-')
          .slice(0, 55) || 'game'
      }-imported`
  })
  on(form, 'submit', (event) => {
    event.preventDefault()

    if (state?.busy) return
    const request = projectImportRequestSchema.safeParse({ destination: folder.value.trim() })
    const selected = file.files?.[0]

    if (!request.success || !selected || !selected.size || selected.size > maxProjectArchiveBytes) {
      notice = 'project.invalidImport'
      render()

      return
    }

    if (allowDiscard()) {
      importing = true
      void controller.importProject(request.data, selected).then(() => {
        importing = false

        if (!disposed) render()
      })
    }
  })
  on(exportButton, 'click', () => {
    if (exportButton.disabled) return
    exporting = true
    clearDownload()
    notice = 'project.exporting'
    void controller.exportProject().then((archive) => {
      exporting = false

      if (disposed) return

      if (archive) {
        objectUrl = URL.createObjectURL(archive.blob)
        exportScope = `${state?.path}:${state?.view?.revision}`
        download.href = objectUrl
        download.download = archive.fileName
        download.hidden = false
        download.click()
        notice = 'project.exported'
      }

      render()
    })
  })
  clearDownload()
  render()

  return {
    render(next: ProjectEditorState, replaceFields: boolean) {
      state = next

      if (exportScope !== `${next.path}:${next.view?.revision}`) {
        clearDownload()

        if (notice === 'project.exported') notice = ''
      }

      if (!next.busy && next.error) notice = next.error

      if (next.busy && !exporting) notice = ''

      if (replaceFields && next.projectChange?.kind === 'imported') {
        form.reset()
        form.hidden = true
        toggle.setAttribute('aria-expanded', 'false')
        notice = 'project.imported'
      }

      render()
    },
    dispose() {
      disposed = true
      clearDownload()

      for (const remove of listeners) remove()
    },
  }
}
