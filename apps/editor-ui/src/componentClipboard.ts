import {
  commandSchema,
  type ComponentClipboard,
  type EditorCommand,
  type ProjectView,
} from '@ancadeba/editor-core'
import { sceneComponentSchema } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'

/** A saved-source clipboard for one open project, with a separate destination draft. */
export function bindComponentClipboard(
  root: HTMLElement,
  t: Translate,
  {
    copy,
    save,
    canChange,
    onSaved,
  }: {
    copy: (sceneId: string, componentId: string) => Promise<ComponentClipboard | undefined>
    save: (command: EditorCommand) => void
    canChange: () => boolean
    onSaved: (command: Extract<EditorCommand, { type: 'scene.pasteComponent' }>) => void
  },
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId: string | undefined
  let componentId: string | undefined
  let clipboard: ComponentClipboard | undefined
  let sourceScene = ''
  let newId = ''
  let placement = { row: 1, column: 1, rowSpan: 1, columnSpan: 1 }
  let dirty = false
  let busy = false
  let copying = false
  let pending: Extract<EditorCommand, { type: 'scene.pasteComponent' }> | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const scene = () => view?.scenes.find(({ id }) => id === sceneId)

  function reset() {
    const current = scene()
    const component = clipboard && sceneComponentSchema.parse(clipboard.component)
    newId = component?.id ?? ''

    if (current?.components.some(({ id }) => id === newId)) newId = `${component?.id}-copy`
    let suffix = 2

    while (current?.components.some(({ id }) => id === newId))
      newId = `${component?.id}-copy-${suffix++}`

    if (component && current) {
      const { rows, columns } = current.screen.grid
      const row = Math.min(component.placement.row, rows)
      const column = Math.min(component.placement.column, columns)
      placement = {
        row,
        column,
        rowSpan: Math.min(component.placement.rowSpan, rows - row + 1),
        columnSpan: Math.min(component.placement.columnSpan, columns - column + 1),
      }
    }

    dirty = false
    error.textContent = ''
    render()
  }

  const canEdit = () => {
    if (busy || copying || !view?.game || view.diagnostics.length) return false

    if (!canChange()) {
      error.textContent = t('clipboard.saveDraftsFirst')

      return false
    }

    return true
  }

  const copySelected = async () => {
    if (!sceneId || !componentId || !canEdit()) return

    if (dirty) {
      error.textContent = t('clipboard.discardFirst')

      return
    }

    const source = sceneId
    copying = true
    render()

    try {
      const result = await copy(sceneId, componentId)

      if (result) {
        clipboard = result
        sourceScene = source
        reset()
      }
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
    } finally {
      copying = false
      render()
    }
  }

  const paste = () => {
    const current = scene()

    if (!current || !clipboard || !canEdit()) return

    const result = commandSchema.safeParse({
      type: 'scene.pasteComponent',
      sceneId: current.id,
      newId,
      component: clipboard.component,
      placement,
    })

    if (!result.success) {
      error.textContent = result.error.issues
        .map(({ path, message }) => `${path.join('.')}: ${message}`)
        .join('\n')

      return
    }

    if (result.data.type !== 'scene.pasteComponent') return
    pending = result.data
    error.textContent = ''
    save(result.data)
  }

  function render() {
    fields.replaceChildren()
    const current = scene()

    if (!current) return
    fields.disabled = busy || copying || !view?.game || Boolean(view.diagnostics.length)

    if (componentId && current.components.some(({ id }) => id === componentId)) {
      const button = controls.button(t('clipboard.copy'), () => {
        void copySelected()
      })

      button.setAttribute('aria-keyshortcuts', 'Control+c Meta+c')
      button.title = t('shortcuts.copy')
      fields.append(button)
    }

    if (!clipboard) return
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    status.textContent = t('clipboard.copied', {
      id: sceneComponentSchema.parse(clipboard.component).id,
      scene: sourceScene,
    })
    const help = document.createElement('p')
    help.textContent = t('clipboard.help')
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = t('clipboard.paste')
    button.setAttribute('aria-keyshortcuts', 'Control+v Meta+v')
    button.title = t('shortcuts.paste')
    form.append(
      controls.input(t('clipboard.newId'), newId, (value) => {
        newId = value.trim()
      }),
      ...(['row', 'column', 'rowSpan', 'columnSpan'] as const).map((key) =>
        controls.input(
          t(`clipboard.${key}`),
          String(placement[key]),
          (value) => {
            placement[key] = Number(value)
          },
          'number',
        ),
      ),
      saveBar(document, button),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      paste()
    })
    fields.append(
      status,
      help,
      form,
      controls.button(t('clipboard.discard'), reset),
      controls.button(t('clipboard.clear'), () => {
        clipboard = undefined
        reset()
      }),
    )
  }

  const canNavigate = (nextScene?: string, nextComponent?: string) => {
    if (copying) return false

    if (nextScene === sceneId && nextComponent === componentId) return true

    if (dirty) {
      error.textContent = t('clipboard.discardFirst')

      return false
    }

    return true
  }

  return {
    shortcut(action: 'copy' | 'paste'): boolean {
      if (busy || copying || !view?.game || view.diagnostics.length || !scene()) return false

      if (action === 'copy') {
        if (!componentId || !scene()?.components.some(({ id }) => id === componentId)) return false
        void copySelected()
      } else {
        if (!clipboard) return false
        paste()
      }

      return true
    },
    hasDrafts: () => dirty || copying,
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
      const changedProject = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        pending && replaceFields && state.lastCommand === 'scene.pasteComponent'
          ? pending
          : undefined

      if (!busy) pending = undefined

      if (changedProject) clipboard = undefined

      if (saved) {
        sceneId = saved.sceneId
        componentId = saved.newId
      }

      if (
        changedProject ||
        saved ||
        (replaceFields && !state.preserveDrafts) ||
        (changed && !dirty)
      )
        reset()
      else render()

      if (saved) onSaved(saved)
    },
  }
}
