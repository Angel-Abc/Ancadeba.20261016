import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { sceneTitle } from './projectTree.js'

/** Scene and component structure controls share the same revision-checked save flow. */
export function bindSceneControls(
  root: HTMLElement,
  t: Translate,
  {
    save,
    canChange,
    confirmDelete,
    onSaved,
  }: {
    save: (command: EditorCommand) => void
    canChange: () => boolean
    confirmDelete: (message: string) => boolean
    onSaved: (command: EditorCommand, view: ProjectView) => void
  },
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let projectPath: string | undefined
  let sceneId: string | undefined
  let componentId: string | undefined
  let dirty = false
  let busy = false
  let renameId = ''
  let duplicateId = ''
  let duplicateTitle = ''
  let duplicateComponentId = ''
  let replacement = ''
  let pending: EditorCommand | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const scene = () => view?.scenes.find(({ id }) => id === sceneId)

  const reset = () => {
    const current = scene()
    renameId = current?.id ?? ''
    duplicateId = `${renameId}-copy`
    let suffix = 2

    while (view?.scenes.some(({ id }) => id.toLowerCase() === duplicateId.toLowerCase()))
      duplicateId = `${renameId}-copy-${suffix++}`
    duplicateComponentId = `${componentId ?? ''}-copy`
    suffix = 2

    while (current?.components.some(({ id }) => id === duplicateComponentId))
      duplicateComponentId = `${componentId}-copy-${suffix++}`
    duplicateTitle =
      current && view ? t('scene.copyTitle', { title: sceneTitle(view, current) }) : ''
    replacement = ''
    dirty = false
    error.textContent = ''
    render()
  }

  const submit = (command: EditorCommand) => {
    if (busy || !view?.game || view.diagnostics.length) return

    if (!canChange()) {
      error.textContent = t('scene.saveDraftsFirst')

      return
    }

    const parsed = commandSchema.safeParse(command)

    if (!parsed.success) {
      error.textContent = parsed.error.issues
        .map(({ path, message }) => `${path.join('.')}: ${message}`)
        .join('\n')

      return
    }

    if (
      (command.type === 'scene.remove' || command.type === 'scene.removeComponent') &&
      !confirmDelete(
        command.type === 'scene.remove'
          ? t('scene.confirmDelete', {
              scene: sceneId ?? '',
              replacement: replacement || t('scene.noReplacement'),
            })
          : t('component.confirmDelete', { component: componentId ?? '' }),
      )
    )
      return
    pending = parsed.data
    error.textContent = ''
    save(parsed.data)
  }

  const form = (buttonLabel: string, command: () => EditorCommand, ...children: HTMLElement[]) => {
    const element = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = t(buttonLabel)

    if (buttonLabel === 'component.duplicate') {
      button.setAttribute('aria-keyshortcuts', 'Control+d Meta+d')
      button.title = t('shortcuts.duplicate')
    }

    element.append(...children, saveBar(document, button))
    element.addEventListener('submit', (event) => {
      event.preventDefault()
      submit(command())
    })

    return element
  }

  function render() {
    fields.replaceChildren()
    const current = scene()

    if (!current) return
    fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    const legend = document.createElement('legend')
    legend.textContent = t(componentId ? 'component.actions' : 'scene.actions')
    fields.append(legend)

    if (componentId) {
      const index = current.components.findIndex(({ id }) => id === componentId)
      const component = current.components[index]

      if (component) {
        const singleton = ['action-bar', 'shop', 'combat'].includes(component.type)

        const deleteButton = controls.button(t('component.delete'), () =>
          submit({ type: 'scene.removeComponent', sceneId: current.id, componentId: component.id }),
        )

        deleteButton.setAttribute('aria-keyshortcuts', 'Delete Backspace')
        deleteButton.title = t('shortcuts.delete')

        if (singleton) {
          const help = document.createElement('p')
          help.textContent = t('component.singletonCopy')
          fields.append(help)
        } else {
          fields.append(
            form(
              'component.duplicate',
              () => ({
                type: 'scene.duplicateComponent',
                sceneId: current.id,
                componentId: component.id,
                newId: duplicateComponentId,
              }),
              controls.input(t('component.copyId'), duplicateComponentId, (value) => {
                duplicateComponentId = value.trim()
              }),
            ),
          )
        }

        fields.append(
          controls.button(
            t('component.moveUp'),
            () =>
              submit({
                type: 'scene.moveComponent',
                sceneId: current.id,
                componentId: component.id,
                index: index - 1,
              }),
            index === 0,
          ),
          controls.button(
            t('component.moveDown'),
            () =>
              submit({
                type: 'scene.moveComponent',
                sceneId: current.id,
                componentId: component.id,
                index: index + 1,
              }),
            index === current.components.length - 1,
          ),
          deleteButton,
          controls.button(t('component.discardControls'), reset),
        )
      }

      return
    }

    fields.append(
      form(
        'scene.rename',
        () => ({ type: 'scene.rename', sceneId: current.id, newId: renameId }),
        controls.input(t('scene.renameId'), renameId, (value) => {
          renameId = value.trim()
        }),
      ),
      form(
        'scene.duplicate',
        () => ({
          type: 'scene.duplicate',
          sceneId: current.id,
          newId: duplicateId,
          title: duplicateTitle,
        }),
        controls.input(t('scene.duplicateId'), duplicateId, (value) => {
          duplicateId = value.trim()
        }),
        controls.input(t('scene.duplicateTitle'), duplicateTitle, (value) => {
          duplicateTitle = value
        }),
      ),
      controls.button(
        t(
          (view?.game?.['initial-scene'] ?? view?.game?.scenes[0]) === current.id
            ? 'scene.isStartup'
            : 'scene.setStartup',
        ),
        () => submit({ type: 'game.setInitialScene', sceneId: current.id }),
        (view?.game?.['initial-scene'] ?? view?.game?.scenes[0]) === current.id,
      ),
      controls.select(
        t('scene.replacement'),
        replacement,
        [
          ['', t('scene.noReplacement')],
          ...(view?.scenes
            .filter(({ id }) => id !== current.id)
            .map((entry) => [entry.id, view ? sceneTitle(view, entry) : entry.id] as const) ?? []),
        ],
        (value) => {
          replacement = value
        },
      ),
      controls.button(
        t('scene.delete'),
        () =>
          submit({
            type: 'scene.remove',
            sceneId: current.id,
            ...(replacement ? { replacementScene: replacement } : {}),
          }),
        (view?.scenes.length ?? 0) <= 1,
      ),
      controls.button(t('scene.discardControls'), reset),
    )
  }

  const canNavigate = (nextScene?: string, nextComponent?: string) => {
    if (nextScene === sceneId && nextComponent === componentId) return true

    if (dirty) {
      error.textContent = t(
        componentId ? 'component.discardControlsFirst' : 'scene.discardControlsFirst',
      )

      return false
    }

    return true
  }

  return {
    shortcut(action: 'duplicate' | 'delete'): boolean {
      const current = scene()
      const component = current?.components.find(({ id }) => id === componentId)

      if (busy || !view?.game || view.diagnostics.length || !current || !component) return false

      if (dirty) {
        error.textContent = t('component.discardControlsFirst')

        return true
      }

      if (action === 'duplicate') {
        if (['action-bar', 'shop', 'combat'].includes(component.type)) {
          error.textContent = t('component.singletonCopy')

          return true
        }

        submit({
          type: 'scene.duplicateComponent',
          sceneId: current.id,
          componentId: component.id,
          newId: duplicateComponentId,
        })
      } else
        submit({ type: 'scene.removeComponent', sceneId: current.id, componentId: component.id })

      return true
    },
    hasDrafts: () => dirty,
    canNavigate,
    navigate(nextScene?: string, nextComponent?: string) {
      if (!canNavigate(nextScene, nextComponent)) return false

      if (nextScene === sceneId && nextComponent === componentId) return true
      sceneId = nextScene
      componentId = nextComponent
      reset()

      return true
    },
    render(state: ProjectEditorState, replaceFields: boolean) {
      const changedProject = projectPath !== state.path
      const changed = view !== state.view
      projectPath = state.path
      view = state.view
      busy = state.busy

      const saved =
        pending && replaceFields && state.lastCommand === pending.type ? pending : undefined

      if (!busy) pending = undefined

      if (saved?.type === 'scene.rename' || saved?.type === 'scene.duplicate') sceneId = saved.newId

      if (saved?.type === 'scene.remove') sceneId = saved.replacementScene ?? view?.scenes[0]?.id

      if (saved?.type === 'scene.removeComponent') componentId = undefined

      if (saved?.type === 'scene.duplicateComponent') componentId = saved.newId

      if (
        changedProject ||
        (replaceFields && !state.preserveDrafts) ||
        (saved && saved.type !== 'game.setInitialScene' && saved.type !== 'scene.moveComponent') ||
        (changed && !dirty)
      )
        reset()
      else render()

      if (saved && view) onSaved(saved, view)
    },
  }
}
