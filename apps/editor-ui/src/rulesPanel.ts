import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { GameRulesDefinition } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar, languageWatcher } from './ruleFormControls.js'
import { rulesDefinitionForm } from './rulesDefinitionForm.js'
import {
  ruleTriggerForms,
  ruleTriggerSections,
  type RuleTriggerSection,
} from './ruleTriggerForms.js'

const defaultRuleId = 'rules'

export function bindRulesPanel(
  panel: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = panel.ownerDocument
  const rulesFields = document.createElement('fieldset')
  const triggerFields = document.createElement('fieldset')
  const navigation = document.createElement('div')
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  panel.replaceChildren(navigation, error, rulesFields, triggerFields)

  let view: ProjectView | undefined
  let loadedPath: string | undefined
  let draft: GameRulesDefinition = { state: [], actions: {} }
  let ruleId = defaultRuleId
  let newRuleId = ''
  let submitted: EditorCommand | undefined
  let selected = ''
  let rulesDirty = false
  const dirtyTriggers = new Set<RuleTriggerSection>()
  let triggerForms = new Map<RuleTriggerSection, HTMLElement>()
  let busy = false

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('\n')

    if (parsed.success) {
      submitted = structuredClone(parsed.data)
      save(parsed.data)
    }
  }

  const languageChanged = languageWatcher(t)

  const rulesControls = ruleFormControls(
    document,
    () => {
      rulesDirty = true
    },
    t,
  )

  const triggerControls = ruleFormControls(document, () => {}, t)

  const definitions = rulesControls.button(t('rules.definitions'), () => showTriggers(false))
  const triggers = rulesControls.button(t('rules.triggers'), () => showTriggers(true))
  navigation.append(definitions, triggers)
  showTriggers(false)

  function showTriggers(show: boolean) {
    rulesFields.hidden = show
    triggerFields.hidden = !show
    definitions.setAttribute('aria-pressed', String(!show))
    triggers.setAttribute('aria-pressed', String(show))
  }

  const selectAction = (id: string) => {
    selected = id
  }

  const change = (edit: () => void) => {
    edit()
    rulesDirty = true
    renderRules()
  }

  function renderRules() {
    rulesFields.replaceChildren()

    if (!view?.game) return
    const form = document.createElement('form')
    const ids = view.game.rules ?? []
    const choices = ids.length ? ids : [defaultRuleId]

    const filePicker = rulesControls.select(
      t('rules.file'),
      ruleId,
      [...choices, ['', t('rules.newFile')]],
      (next) => {
        if (rulesDirty) {
          filePicker.querySelector('select')!.value = ruleId
          error.textContent = t('rules.saveFirstFiles')

          return
        }

        ruleId = next
        newRuleId = ''
        error.textContent = ''
        resetRules()
      },
      false,
    )

    form.append(filePicker)

    if (!ruleId)
      form.append(
        rulesControls.input(t('rules.newId'), newRuleId, (value) => {
          newRuleId = value.trim()
        }),
      )

    const otherFields = Object.entries(view.ruleFiles ?? {})
      .filter(([id]) => id !== ruleId)
      .flatMap(([, rules]) => rules.state)

    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = t('rules.save')
    form.append(
      saveBar(
        document,
        saveButton,
        rulesControls.button(t('rules.discard'), () => {
          newRuleId = ''
          resetRules()
          error.textContent = ''
        }),
      ),
      ...rulesDefinitionForm(
        rulesControls,
        view,
        draft,
        selected,
        (id) => {
          selectAction(id)
          renderRules()
        },
        change,
        renderRules,
        otherFields,
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (!ruleId && ids.some((id) => id.toLowerCase() === newRuleId.toLowerCase())) {
        error.textContent = t('rules.idExists')

        return
      }

      submit({ type: 'game.updateRules', ruleId: ruleId || newRuleId, rules: draft })
    })
    rulesFields.append(form)
  }

  function renderTriggers() {
    if (!view?.game) {
      triggerFields.replaceChildren()
      triggerForms.clear()

      return
    }

    const retained = new Map([...triggerForms].filter(([section]) => dirtyTriggers.has(section)))

    const forms = ruleTriggerForms(triggerControls, view, submit, {
      retained,
      controls: (section) => ruleFormControls(document, () => dirtyTriggers.add(section), t),
      discarded: (section) => {
        dirtyTriggers.delete(section)
        renderTriggers()
      },
    })

    triggerForms = new Map(ruleTriggerSections.map((section, index) => [section, forms[index]!]))
    triggerFields.replaceChildren(
      triggerControls.button(t('rules.discardTrigger'), () => {
        dirtyTriggers.clear()
        error.textContent = ''
        renderTriggers()
      }),
      ...forms,
    )
  }

  function resetRules() {
    const ids = view?.game?.rules ?? []
    const ruleFiles = view?.ruleFiles

    if (ruleId && ids.length && !ids.includes(ruleId)) ruleId = ids[0]!
    const saved = ruleFiles && Object.hasOwn(ruleFiles, ruleId) ? ruleFiles[ruleId] : undefined
    draft = structuredClone(saved ?? { state: [], actions: {} })

    if (!Object.hasOwn(draft.actions, selected)) selected = Object.keys(draft.actions)[0] ?? ''
    rulesDirty = false
    renderRules()
  }

  return {
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
      const projectChanged = state.path !== loadedPath
      const viewChanged = view !== state.view
      view = state.view
      loadedPath = state.path
      busy = state.busy

      const saved =
        submitted && !busy && replaceFields && !state.error && state.lastCommand === submitted.type
          ? submitted
          : undefined

      if (!busy) submitted = undefined
      const rulesSaved = saved?.type === 'game.updateRules'

      const triggerSection: RuleTriggerSection | undefined =
        saved?.type === 'scene.upsertRuleButton'
          ? 'buttons'
          : saved?.type === 'inventory.setRuleInspection'
            ? 'inspection'
            : saved?.type === 'inventory.setItemActions'
              ? 'actions'
              : saved?.type === 'scene.upsertNearby'
                ? 'nearby'
                : undefined

      const reset = projectChanged || (replaceFields && !state.preserveDrafts)

      if (reset) {
        ruleId = view?.game?.rules?.[0] ?? defaultRuleId
        newRuleId = ''
        dirtyTriggers.clear()
        triggerForms.clear()
        submitted = undefined
      }

      if (saved?.type === 'game.updateRules') ruleId = saved.ruleId

      if (triggerSection) dirtyTriggers.delete(triggerSection)

      if (translated) {
        definitions.textContent = t('rules.definitions')
        triggers.textContent = t('rules.triggers')
      }

      if (reset || rulesSaved || (viewChanged && !rulesDirty)) {
        resetRules()
      } else if (translated) renderRules()

      if (reset || triggerSection || viewChanged || translated) {
        renderTriggers()
      }

      if (reset || rulesSaved || triggerSection) error.textContent = ''
      rulesFields.disabled = busy || !view?.game
      triggerFields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
    hasDrafts: () => rulesDirty || dirtyTriggers.size > 0,
    /** Opens a rule file's definitions; refuses while the current file has a draft. */
    navigate(id: string) {
      if (id === ruleId) {
        showTriggers(false)

        return true
      }

      if (rulesDirty) return false
      ruleId = id
      newRuleId = ''
      error.textContent = ''
      showTriggers(false)
      resetRules()

      return true
    },
  }
}
