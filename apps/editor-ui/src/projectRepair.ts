import type { ProjectRepairRequest, ProjectRepairCheck } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import { z } from 'zod'
import { registerEditorDraft } from './editorDraftState.js'
import type { ProjectEditorState } from './projectController.js'

type RepairDraft = Omit<ProjectRepairRequest, 'path'>

/** An invalid project can be repaired incrementally without discarding unrelated editor drafts. */
export function bindProjectRepair(
  root: HTMLElement,
  t: Translate,
  actions: {
    check(request: RepairDraft): Promise<ProjectRepairCheck | undefined>
    save(request: RepairDraft): Promise<boolean>
  },
  validateCss?: (css: string) => void,
) {
  const document = root.ownerDocument
  const heading = document.createElement('h3')
  const help = document.createElement('p')
  help.className = 'help'
  const fields = document.createElement('fieldset')
  const fileLabel = document.createElement('label')
  const fileCaption = document.createElement('span')
  const picker = document.createElement('select')
  fileLabel.append(fileCaption, picker)
  const issues = document.createElement('pre')
  issues.className = 'repair-diagnostics'
  const sourceLabel = document.createElement('label')
  const sourceCaption = document.createElement('span')
  const source = document.createElement('textarea')
  source.rows = 20
  source.spellcheck = false
  source.className = 'repair-source'
  sourceLabel.append(sourceCaption, source)
  const savedDetails = document.createElement('details')
  const savedSummary = document.createElement('summary')
  const savedSource = document.createElement('pre')
  savedSource.tabIndex = 0
  savedSource.className = 'repair-source repair-saved-source'
  savedDetails.append(savedSummary, savedSource)
  const check = document.createElement('button')
  const save = document.createElement('button')
  const discard = document.createElement('button')
  const generate = document.createElement('button')
  generate.type = 'button'
  check.type = save.type = discard.type = 'button'
  const buttons = document.createElement('div')
  buttons.className = 'preview-actions'
  buttons.append(check, save, discard, generate)
  const feedback = document.createElement('p')
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')
  const preview = document.createElement('pre')
  preview.className = 'repair-diagnostics'
  fields.append(fileLabel, issues, sourceLabel, savedDetails, buttons)
  root.replaceChildren(heading, help, fields, feedback, preview)
  let state: ProjectEditorState | undefined
  let file = ''
  let text = ''
  let revision = ''
  let dirty = false
  let submitting = false
  let disposed = false
  let checked: { text: string; result: ProjectRepairCheck } | undefined
  let notice = ''
  let detail = ''

  const diagnosticsText = (diagnostics: ProjectRepairCheck['diagnostics']) =>
    diagnostics.map((issue) => `${issue.file} ${issue.path.join('.')}: ${issue.message}`).join('\n')

  const files = () => state?.view?.repairFiles ?? {}
  const request = (): RepairDraft => ({ file, text, expectedRevision: revision })

  const render = () => {
    root.hidden = !state?.view || (!state.view.diagnostics.length && !dirty)
    heading.textContent = t('repair.heading')
    help.textContent = t('repair.help')
    fileCaption.textContent = t('repair.file')
    sourceCaption.textContent = t('repair.source')
    savedSummary.textContent = t('repair.savedSource')
    savedSource.setAttribute('aria-label', t('repair.savedSource'))
    const entries = Object.keys(files())

    if (file && !entries.includes(file)) entries.push(file)
    picker.replaceChildren(
      ...entries.map((name) => {
        const option = document.createElement('option')
        option.value = name
        option.textContent = files()[name] === null ? t('repair.missing', { file: name }) : name

        return option
      }),
    )
    picker.value = file

    if (source.value !== text) source.value = text
    savedSource.textContent = files()[file] ?? ''
    issues.textContent = diagnosticsText(
      state?.view?.diagnostics.filter((issue) => issue.file === file) ?? [],
    )
    check.textContent = t('repair.check')
    save.textContent = checked?.result.diagnostics.length
      ? t('repair.saveRemaining', { count: checked.result.diagnostics.length })
      : t('repair.save')
    discard.textContent = t('repair.discard')
    generate.textContent = t('recovery.generate')
    generate.hidden = file !== 'game.json' || !state?.view?.recoveryManifest
    generate.disabled = dirty
    fields.disabled = state?.busy === true || submitting || !file
    picker.disabled = state?.busy === true
    save.disabled =
      !dirty || !checked || checked.text !== text || checked.result.revision !== revision
    discard.disabled = !dirty
    feedback.textContent =
      detail ||
      (notice
        ? t(notice)
        : checked
          ? t(checked.result.diagnostics.length ? 'repair.remaining' : 'repair.valid', {
              count: checked.result.diagnostics.length,
            })
          : '')
    preview.textContent = checked ? diagnosticsText(checked.result.diagnostics) : ''
  }

  const reset = () => {
    const available = files()

    if (!Object.hasOwn(available, file))
      file =
        state?.view?.diagnostics.find((issue) => Object.hasOwn(available, issue.file))?.file ??
        Object.keys(available)[0] ??
        ''
    text = available[file] ?? ''
    revision = state?.view?.revision ?? ''
    dirty = false
    checked = undefined
    notice = ''
    detail = ''
    render()
  }

  const onInput = () => {
    text = source.value
    dirty = true
    checked = undefined
    notice = ''
    detail = ''
    render()
  }

  const onSelect = () => {
    detail = ''

    if (dirty) {
      picker.value = file
      notice = 'repair.saveFirst'
      render()

      return
    }

    file = picker.value
    reset()
  }

  const onCheck = async () => {
    if (state?.busy || !file) return
    const draft = request()
    checked = undefined
    detail = ''
    notice = ''
    render()

    try {
      if (file.endsWith('.css')) validateCss?.(text)
      const result = await actions.check(draft)

      if (
        disposed ||
        draft.file !== file ||
        draft.text !== text ||
        draft.expectedRevision !== revision
      )
        return

      if (!result) {
        notice = 'repair.checkFailed'
        render()

        return
      }

      checked = { text, result }
      notice = ''
    } catch (error) {
      notice = 'repair.checkFailed'
      detail =
        error instanceof Error
          ? `${t(notice)} ${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`
          : ''
    }

    if (!disposed) render()
  }

  const onSave = async () => {
    if (state?.busy || save.disabled || !checked) return
    submitting = true
    render()

    try {
      if (await actions.save(request())) {
        if (disposed) return
        reset()
        notice = 'repair.saved'
      } else {
        checked = undefined
        notice = 'repair.saveFailed'
      }
    } catch {
      checked = undefined
      notice = 'repair.saveFailed'
    } finally {
      submitting = false

      if (!disposed) render()
    }
  }

  const onClickCheck = () => {
    void onCheck()
  }

  const onClickSave = () => {
    void onSave()
  }

  const onGenerate = () => {
    if (dirty || state?.busy || !state?.view?.recoveryManifest || file !== 'game.json') return
    source.value = state.view.recoveryManifest
    onInput()
    notice = 'recovery.review'
    render()
  }

  source.addEventListener('input', onInput)
  picker.addEventListener('change', onSelect)
  check.addEventListener('click', onClickCheck)
  save.addEventListener('click', onClickSave)
  discard.addEventListener('click', reset)
  generate.addEventListener('click', onGenerate)

  registerEditorDraft(
    root,
    'project-repair',
    z.object({
      file: z.string(),
      text: z.string(),
      revision: z.string(),
    }),
    () => (dirty ? { file, text, revision } : undefined),
    (draft) => {
      file = draft.file
      text = draft.text
      revision = draft.revision
      dirty = true
      checked = undefined
      detail = ''
      render()
    },
  )

  return {
    hasDrafts: () => dirty,
    render(next: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = state?.path !== next.path
      const changed = state?.view !== next.view
      state = next

      if (projectChanged || (replaceFields && !next.preserveDrafts) || (!dirty && changed)) reset()
      else if (replaceFields && dirty && next.lastCommand === null && !submitting) {
        revision = next.view?.revision ?? revision
        checked = undefined
        notice = 'repair.reloaded'
      }

      render()
    },
    dispose() {
      disposed = true
      source.removeEventListener('input', onInput)
      picker.removeEventListener('change', onSelect)
      check.removeEventListener('click', onClickCheck)
      save.removeEventListener('click', onClickSave)
      discard.removeEventListener('click', reset)
      generate.removeEventListener('click', onGenerate)
    },
  }
}
