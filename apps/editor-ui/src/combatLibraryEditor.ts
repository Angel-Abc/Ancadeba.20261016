import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { combatLibrarySchema, resolveCombatSource, type CombatLibrary } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { combatMovesForm } from './combatMovesForm.js'
import { combatStatusesForm } from './combatAbilitiesForm.js'

export function bindCombatLibraryEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let libraryId = ''
  let draft: CombatLibrary | undefined
  let dirty = false
  let busy = false
  let submittedId: string | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const reset = () => {
    draft = view?.combatLibraries?.[libraryId]
      ? structuredClone(view.combatLibraries[libraryId])
      : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (id: string) => {
    if (id === libraryId) {
      root.scrollIntoView?.({ block: 'start' })

      return true
    }

    if (dirty && id !== libraryId) {
      error.textContent = 'Save or discard the library draft before switching libraries.'

      return false
    }

    libraryId = id
    reset()
    root.scrollIntoView?.({ block: 'start' })

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      submittedId =
        parsed.data.type === 'game.upsertCombatLibrary' ? parsed.data.library.id : undefined
      save(parsed.data)
    }
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return

    const picker = controls.select(
      'Combat library',
      libraryId,
      ['', ...Object.keys(view.combatLibraries ?? {})],
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = libraryId
      },
      false,
    )

    fields.append(
      controls.group(
        'Combat libraries',
        picker,
        controls.button('Add combat library', () => {
          if (dirty) {
            error.textContent = 'Save or discard the library draft first.'

            return
          }

          let id = 'common'
          let number = 1

          while (view?.combatLibraries?.[id]) id = `common-${number++}`
          libraryId = id
          draft = combatLibrarySchema.parse({ 'schema-version': '1.0.0', id })
          dirty = true
          render()
        }),
      ),
    )

    if (!draft) return
    const current = draft
    const usage = document.createElement('p')

    const encounters = Object.values(view.combatSources ?? {}).filter((source) =>
      [...(source.sharedMoves ?? []), ...(source.sharedStatuses ?? [])].some(
        (ref) => ref.library === libraryId,
      ),
    )

    usage.textContent = `Affected encounters: ${encounters.map((source) => source.id).join(', ') || 'none'}. Changes apply after reloading play.`
    const entryUsage = document.createElement('ul')

    const resolved = Object.values(view.combatSources ?? {}).map((source) => ({
      id: source.id,
      origins: resolveCombatSource(source, new Map(Object.entries(view?.combatLibraries ?? {})))
        .origins,
    }))

    for (const kind of ['moves', 'statuses'] as const)
      for (const id of Object.keys(current[kind])) {
        const row = document.createElement('li')
        row.textContent = `${kind} ${id}: ${
          resolved
            .filter((entry) => entry.origins[kind][id]?.library === libraryId)
            .map((entry) => entry.id)
            .join(', ') || 'unused'
        }`
        entryUsage.append(row)
      }

    const form = document.createElement('form')
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save combat library'
    form.append(
      saveBar(document, saveButton),
      usage,
      entryUsage,
      controls.input('Library ID', current.id, (value) => {
        current.id = value.trim()
      }),
      ...combatMovesForm(controls, view, current, render),
      combatStatusesForm(controls, view, current, render),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit({ type: 'game.upsertCombatLibrary', library: current })
    })
    fields.append(
      form,
      controls.button('Discard library draft', reset),
      controls.button('Delete combat library', () =>
        submit({ type: 'game.removeCombatLibrary', libraryId }),
      ),
    )
  }

  return {
    navigate,
    hasDrafts: () => dirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        replaceFields &&
        ['game.upsertCombatLibrary', 'game.removeCombatLibrary'].includes(state.lastCommand ?? '')

      if (saved && submittedId) {
        libraryId = submittedId
        submittedId = undefined
      }

      if (projectChanged || (replaceFields && !state.preserveDrafts)) libraryId = ''

      if (
        projectChanged ||
        saved ||
        (replaceFields && !state.preserveDrafts) ||
        (changed && !dirty)
      )
        reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
