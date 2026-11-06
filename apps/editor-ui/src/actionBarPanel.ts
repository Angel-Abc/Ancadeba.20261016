import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { ActionBarComponentDefinition, InputDefinition } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { actionBarForm } from './actionBarForm.js'
import {
  createInputDraft,
  inputDefinitionForm,
  readInputDraft,
  type InputDraft,
} from './inputDefinitionForm.js'

function defaultInput(): InputDefinition {
  const slots = Array.from({ length: 15 }, (_, index) => `slot-${index + 1}`)

  return {
    'schema-version': '1.0.0',
    'virtual-keys': slots,
    keyboard: Object.fromEntries(
      'QWERTASDFGZXCVB'.split('').map((key, index) => [`Key${key}`, slots[index]!]),
    ),
    contexts: { gameplay: Object.fromEntries(slots.map((slot) => [slot, slot])) },
    'initial-context': 'gameplay',
  }
}

export function bindActionBarPanel(panel: HTMLElement, save: (command: EditorCommand) => void) {
  const document = panel.ownerDocument
  const navigation = document.createElement('div')
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const barFields = document.createElement('fieldset')
  const inputFields = document.createElement('fieldset')
  panel.replaceChildren(navigation, error, barFields, inputFields)

  let view: ProjectView | undefined
  let loadedPath: string | undefined
  let sceneId = ''
  let selectedSlot = '1'
  let barDraft: ActionBarComponentDefinition | undefined
  let inputDraft: InputDraft | undefined
  let inputId = 'controls'
  let barDirty = false
  let inputDirty = false
  let busy = false

  const barControls = ruleFormControls(document, () => {
    barDirty = true
  })

  const inputControls = ruleFormControls(document, () => {
    inputDirty = true
  })

  const barTab = barControls.button('Scene action bar', () => showInputs(false))
  const inputTab = inputControls.button('Game input bindings', () => showInputs(true))
  navigation.append(barTab, inputTab)

  function showInputs(show: boolean) {
    barFields.hidden = show
    inputFields.hidden = !show
    barTab.setAttribute('aria-pressed', String(!show))
    inputTab.setAttribute('aria-pressed', String(show))
  }

  showInputs(false)

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('\n')

    if (parsed.success) save(parsed.data)
  }

  function navigate(nextScene?: string): boolean {
    if (!nextScene || nextScene === sceneId) return true

    if (barDirty) {
      error.textContent = 'Save or discard the action-bar draft before switching scenes.'

      return false
    }

    sceneId = nextScene
    selectedSlot = '1'
    resetBar()
    error.textContent = ''
    showInputs(false)

    return true
  }

  function renderBar() {
    barFields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find(({ id, type }) => id === sceneId && type === 'game')

    const picker = barControls.select(
      'Game scene',
      sceneId,
      view.scenes.filter(({ type }) => type === 'game').map(({ id }) => id),
      (next) => {
        if (!navigate(next)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    barFields.append(picker)

    if (!scene) {
      barFields.append('Select a game scene to configure its action bar.')

      return
    }

    if (!barDraft) {
      barFields.append(
        barControls.button('Add action bar', () => {
          const { rows, columns } = scene.screen.grid
          barDraft = {
            id: 'action-bar',
            type: 'action-bar',
            slots: {},
            placement: {
              row: Math.max(1, rows - 2),
              column: 1,
              rowSpan: Math.min(3, rows),
              columnSpan: columns,
            },
          }
          barDirty = true
          renderBar()
        }),
      )

      return
    }

    const form = document.createElement('form')
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save action bar'
    form.append(
      saveBar(document, saveButton),
      ...actionBarForm(
        barControls,
        view,
        barDraft,
        selectedSlot,
        (id) => {
          selectedSlot = id
          renderBar()
        },
        (edit) => {
          edit()
          barDirty = true
          renderBar()
        },
        sceneId,
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (barDraft) submit({ type: 'scene.setActionBar', sceneId, component: barDraft })
    })
    barFields.append(
      form,
      barControls.button('Discard action-bar draft', () => {
        resetBar()
        error.textContent = ''
      }),
      barControls.button(
        'Remove action bar',
        () => submit({ type: 'scene.setActionBar', sceneId, component: null }),
        !scene.components.some((component) => component.type === 'action-bar'),
      ),
    )
  }

  function resetBar() {
    barDraft = structuredClone(
      view?.scenes
        .find(({ id }) => id === sceneId)
        ?.components.find((component) => component.type === 'action-bar'),
    )
    barDirty = false
    renderBar()
  }

  function resetInput() {
    inputDraft = view?.input ? createInputDraft(view.input) : undefined
    inputId = view?.game?.input ?? 'controls'
    inputDirty = false
    renderInput()
  }

  function renderInput() {
    inputFields.replaceChildren()

    if (!view?.game) return

    if (!inputDraft) {
      inputFields.append(
        inputControls.button('Create input configuration', () => {
          inputDraft = createInputDraft(defaultInput())
          inputDirty = true
          renderInput()
        }),
      )

      return
    }

    const form = document.createElement('form')

    if (!view.game.input)
      form.append(
        inputControls.input('Input file ID', inputId, (value) => {
          inputId = value.trim()
        }),
      )
    const location = document.createElement('p')
    location.textContent = `Game input file · input/${view.game.input ?? inputId}.json`
    const help = document.createElement('p')
    help.textContent =
      'Physical key codes identify keyboard positions, such as KeyQ, Digit1, and ArrowUp. Save input changes before choosing new bindings for a slot.'
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save input bindings'
    form.append(
      location,
      help,
      saveBar(document, saveButton),
      ...inputDefinitionForm(
        inputControls,
        inputDraft,
        () => {
          inputDirty = true
        },
        (message) => {
          error.textContent = message
        },
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (busy || !inputDraft) return

      try {
        submit({ type: 'game.updateInput', inputId, input: readInputDraft(inputDraft) })
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure)
      }
    })
    inputFields.append(
      form,
      inputControls.button('Discard input draft', () => {
        resetInput()
        error.textContent = ''
      }),
    )
  }

  return {
    navigate,
    hasDrafts: () => barDirty || inputDirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = state.path !== loadedPath
      const viewChanged = view !== state.view
      view = state.view
      loadedPath = state.path
      busy = state.busy
      const reset = projectChanged || (replaceFields && !state.preserveDrafts)
      const barSaved = replaceFields && state.lastCommand === 'scene.setActionBar'
      const inputSaved = replaceFields && state.lastCommand === 'game.updateInput'

      if (reset) {
        sceneId = view?.scenes.find(({ type }) => type === 'game')?.id ?? ''
        selectedSlot = '1'
      }

      if (reset || barSaved || (viewChanged && !barDirty)) resetBar()
      else if (viewChanged) renderBar()

      if (reset || inputSaved || (viewChanged && !inputDirty)) resetInput()

      if (reset || barSaved || inputSaved) error.textContent = ''
      barFields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
      inputFields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
