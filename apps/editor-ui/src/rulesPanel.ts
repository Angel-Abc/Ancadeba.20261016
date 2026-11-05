import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { GameRulesDefinition } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls } from './ruleFormControls.js'
import { rulesDefinitionForm } from './rulesDefinitionForm.js'
import { ruleTriggerForms } from './ruleTriggerForms.js'

const defaultRuleId = 'rules'

export function bindRulesPanel(panel: HTMLElement, save: (command: EditorCommand) => void) {
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
  let submittedRuleId = ''
  let selected = ''
  let rulesDirty = false
  let triggersDirty = false
  let busy = false

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('\n')

    if (parsed.success) save(parsed.data)
  }

  const rulesControls = ruleFormControls(document, () => {
    rulesDirty = true
  })

  const triggerControls = ruleFormControls(document, () => {
    triggersDirty = true
  })

  const definitions = rulesControls.button('Rule definitions', () => showTriggers(false))
  const triggers = rulesControls.button('Trigger links', () => showTriggers(true))
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
      'Rule file',
      ruleId,
      [...choices, ['', 'New rule file…']],
      (next) => {
        if (rulesDirty) {
          filePicker.querySelector('select')!.value = ruleId
          error.textContent = 'Save or discard this draft before switching rule files.'

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
        rulesControls.input('New rule ID', newRuleId, (value) => {
          newRuleId = value.trim()
        }),
      )

    const otherFields = Object.entries(view.ruleFiles ?? {})
      .filter(([id]) => id !== ruleId)
      .flatMap(([, rules]) => rules.state)

    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save rules'
    form.append(
      saveButton,
      rulesControls.button('Discard rule draft', () => {
        newRuleId = ''
        resetRules()
        error.textContent = ''
      }),
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
        error.textContent = 'Choose a rule ID that is not already listed.'

        return
      }

      submittedRuleId = ruleId || newRuleId
      submit({ type: 'game.updateRules', ruleId: submittedRuleId, rules: draft })
    })
    rulesFields.append(form)
  }

  function renderTriggers() {
    triggerFields.replaceChildren()

    if (!view?.game) return
    triggerFields.append(
      triggerControls.button('Discard trigger draft', () => {
        triggersDirty = false
        error.textContent = ''
        renderTriggers()
      }),
      ...ruleTriggerForms(triggerControls, view, submit),
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
      const projectChanged = state.path !== loadedPath
      const viewChanged = view !== state.view
      view = state.view
      loadedPath = state.path
      busy = state.busy
      const rulesSaved = replaceFields && state.lastCommand === 'game.updateRules'

      const triggerSaved =
        replaceFields &&
        (state.lastCommand === 'scene.upsertRuleButton' ||
          state.lastCommand === 'inventory.setRuleInspection' ||
          state.lastCommand === 'inventory.setItemActions')

      const reset = projectChanged || (replaceFields && !state.preserveDrafts)

      if (reset) {
        ruleId = view?.game?.rules?.[0] ?? defaultRuleId
        newRuleId = ''
      }

      if (rulesSaved) ruleId = submittedRuleId

      if (reset || rulesSaved || (viewChanged && !rulesDirty)) {
        resetRules()
      }

      if (reset || triggerSaved || (viewChanged && !triggersDirty)) {
        triggersDirty = false
        renderTriggers()
      }

      if (reset || rulesSaved || triggerSaved) error.textContent = ''
      rulesFields.disabled = busy || !view?.game
      triggerFields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
    hasDrafts: () => rulesDirty || triggersDirty,
  }
}
