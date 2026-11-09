import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { StatusPanelComponentDefinition } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { statusPanelForm } from './statusPanelForm.js'
import { sceneChoices } from './choiceLabels.js'

/** Owns status-panel drafts independently of scene metadata and other component editors. */
export function bindStatusPanelEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let componentId = ''
  let draft: StatusPanelComponentDefinition | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      if (parsed.data.type === 'scene.upsertStatusPanel') componentId = parsed.data.component.id
      save(parsed.data)
    }
  }

  function reset() {
    const panels =
      view?.scenes
        .find((scene) => scene.id === sceneId)
        ?.components.filter((component) => component.type === 'status-panel') ?? []

    const selected = panels.find((panel) => panel.id === componentId) ?? panels[0]
    componentId = selected?.id ?? ''
    draft = selected ? structuredClone(selected) : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  function navigate(nextScene?: string, nextPanel?: string): boolean {
    if ((!nextScene || nextScene === sceneId) && (!nextPanel || nextPanel === componentId))
      return true

    if (dirty) {
      error.textContent = 'Save or discard the status-panel draft before switching targets.'

      return false
    }

    sceneId = nextScene ?? sceneId
    componentId = nextPanel ?? ''
    reset()

    return true
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)

    const picker = controls.select(
      'Status game scene',
      sceneId,
      sceneChoices(view, 'game'),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    picker.className = 'context-picker'

    fields.append(picker)

    if (!scene) return
    const panels = scene.components.filter((component) => component.type === 'status-panel')

    if (panels.length) {
      const picker = controls.select(
        'Status panel',
        componentId,
        panels.map(({ id }) => id),
        (value) => {
          if (!navigate(sceneId, value)) picker.querySelector('select')!.value = componentId
        },
        false,
      )

      picker.className = 'context-picker'

      fields.append(picker)
    }

    fields.append(
      controls.button('Add status panel', () => {
        if (dirty) {
          error.textContent = 'Save or discard the status-panel draft first.'

          return
        }

        let id = 'status-panel'
        let number = 1

        while (scene.components.some((component) => component.id === id))
          id = `status-panel-${number++}`
        componentId = id
        draft = {
          id,
          type: 'status-panel',
          label: 'Status',
          name: '',
          placement: {
            row: 1,
            column: 1,
            rowSpan: Math.min(3, scene.screen.grid.rows),
            columnSpan: Math.min(2, scene.screen.grid.columns),
          },
          rows: [],
          effects: [],
        }
        dirty = true
        render()
      }),
    )

    if (!draft) return
    const form = document.createElement('form')
    const submitButton = document.createElement('button')
    submitButton.type = 'submit'
    submitButton.textContent = 'Save status panel'
    form.append(
      saveBar(document, submitButton),
      ...statusPanelForm(
        controls,
        view,
        draft,
        render,
        panels.some((panel) => panel.id === draft!.id),
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (draft) submit({ type: 'scene.upsertStatusPanel', sceneId, component: draft })
    })
    fields.append(
      form,
      controls.button('Discard status-panel draft', reset),
      controls.button(
        'Remove status panel',
        () => {
          if (draft) submit({ type: 'scene.removeStatusPanel', sceneId, componentId: draft.id })
        },
        !panels.some((panel) => panel.id === draft!.id),
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
        (state.lastCommand === 'scene.upsertStatusPanel' ||
          state.lastCommand === 'scene.removeStatusPanel')

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        componentId = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
