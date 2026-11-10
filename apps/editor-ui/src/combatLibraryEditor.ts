import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { combatLibrarySchema, resolveCombatSource, type CombatLibrary } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar, languageWatcher } from './ruleFormControls.js'
import { combatMovesForm } from './combatMovesForm.js'
import { combatStatusesForm } from './combatAbilitiesForm.js'

export function bindCombatLibraryEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
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
  let creating = false

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const reset = () => {
    draft = view?.combatLibraries?.[libraryId]
      ? structuredClone(view.combatLibraries[libraryId])
      : undefined
    dirty = false
    creating = false
    error.textContent = ''
    render()
  }

  const navigate = (id: string) => {
    if (id === libraryId) {
      root.scrollIntoView?.({ block: 'start' })

      return true
    }

    if (dirty && id !== libraryId) {
      error.textContent = t('combat.librarySaveFirstSwitch')

      return false
    }

    libraryId = id
    reset()
    root.scrollIntoView?.({ block: 'start' })

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return

    if (
      command.type === 'game.upsertCombatLibrary' &&
      creating &&
      (view?.game?.combatLibraries ?? []).some(
        (id) => id.toLowerCase() === command.library.id.toLowerCase(),
      )
    ) {
      error.textContent = t('combat.libraryExists')

      return
    }

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
      t('combat.library'),
      libraryId,
      ['', ...Object.keys(view.combatLibraries ?? {})],
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = libraryId
      },
      false,
    )

    fields.append(
      controls.group(
        t('tree.files.combatLibraries'),
        picker,
        controls.button(t('combat.addLibrary'), () => {
          if (dirty) {
            error.textContent = t('combat.librarySaveFirst')

            return
          }

          let id = 'common'
          let number = 1

          while (
            view?.game?.combatLibraries?.some((entry) => entry.toLowerCase() === id.toLowerCase())
          )
            id = `common-${number++}`
          libraryId = id
          draft = combatLibrarySchema.parse({ 'schema-version': '1.0.0', id })
          creating = true
          dirty = true
          render()
        }),
      ),
    )

    if (!draft) return
    const current = draft
    const usage = document.createElement('p')

    const encounters = Object.values(view.combatSources ?? {}).filter(
      (source) =>
        [...(source.sharedMoves ?? []), ...(source.sharedStatuses ?? [])].some(
          (ref) => ref.library === libraryId,
        ) ||
        source.itemUse?.itemTypes.some(
          (id) => view?.inventory?.itemTypes[id]?.use?.ability.library === libraryId,
        ),
    )

    const items = Object.entries(view.inventory?.itemTypes ?? {}).filter(
      ([, item]) => item.use?.ability.library === libraryId,
    )

    usage.textContent = t('combat.libraryUsage', {
      encounters: encounters.map((source) => source.id).join(', ') || t('combat.none'),
      items: items.map(([id]) => id).join(', ') || t('combat.none'),
    })
    const entryUsage = document.createElement('ul')

    const resolved = Object.values(view.combatSources ?? {}).map((source) => ({
      id: source.id,
      origins: resolveCombatSource(
        source,
        new Map(Object.entries(view?.combatLibraries ?? {})),
        undefined,
        view?.inventory,
      ).origins,
    }))

    for (const kind of ['moves', 'statuses'] as const)
      for (const id of Object.keys(current[kind])) {
        const row = document.createElement('li')
        row.textContent = `${kind} ${id}: ${
          resolved
            .filter((entry) => entry.origins[kind][id]?.library === libraryId)
            .map((entry) => entry.id)
            .join(', ') || t('combat.unused')
        }`
        entryUsage.append(row)
      }

    const form = document.createElement('form')
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = t('combat.saveLibrary')

    const identity = controls.input(t('combat.libraryId'), current.id, (value) => {
      if (creating) current.id = value.trim()
    })

    identity.querySelector('input')!.readOnly = !creating
    form.append(
      saveBar(document, saveButton),
      usage,
      entryUsage,
      identity,
      ...combatMovesForm(controls, view, current, render),
      combatStatusesForm(controls, view, current, render),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit({ type: 'game.upsertCombatLibrary', library: current, createOnly: creating })
    })
    fields.append(
      form,
      controls.button(t('combat.discardLibrary'), reset),
      controls.button(
        t('combat.deleteLibrary'),
        () => submit({ type: 'game.removeCombatLibrary', libraryId }),
        creating,
      ),
    )
  }

  return {
    navigate,
    hasDrafts: () => dirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
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
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
