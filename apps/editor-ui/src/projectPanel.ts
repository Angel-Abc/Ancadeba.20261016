import type { ProjectView } from '@ancadeba/editor-core'
import { HttpEditorClient } from './editorClient.js'
import { ProjectEditorController } from './projectController.js'

export function bindProjectPanel(root: HTMLElement, fetcher: typeof fetch): () => void {
  const find = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`)

    if (!element) throw new Error(`Missing editor element: ${id}`)

    return element
  }

  const folder = find<HTMLInputElement>('editor-folder')
  const load = find<HTMLButtonElement>('editor-load')
  const reload = find<HTMLButtonElement>('editor-reload')
  const metadata = find<HTMLFormElement>('editor-metadata')
  const layout = find<HTMLFormElement>('scene-layout')
  const sceneMetadata = find<HTMLFormElement>('scene-metadata')
  const create = find<HTMLFormElement>('scene-create')
  const scenes = find<HTMLSelectElement>('editor-scenes')
  const fields = find<HTMLFieldSetElement>('editor-fields')
  const status = find<HTMLElement>('editor-status')
  const error = find<HTMLElement>('editor-error')
  const value = (id: string) => find<HTMLInputElement>(id).value

  const set = (id: string, text: string | number) => {
    find<HTMLInputElement>(id).value = String(text)
  }

  let view: ProjectView | undefined
  const dirtyForms = new Set<string>()
  let loadedPath = ''

  const fillScene = () => {
    const scene = view?.scenes.find((scene) => scene.id === scenes.value)
    sceneMetadata.hidden = !scene
    layout.hidden = !scene

    if (!scene) return

    if (!dirtyForms.has(sceneMetadata.id)) {
      set('scene-title', scene.title)
      set('scene-description', scene.description)
    }

    if (!dirtyForms.has(layout.id)) {
      set('scene-rows', scene.screen.grid.rows)
      set('scene-columns', scene.screen.grid.columns)
    }
  }

  const controller = new ProjectEditorController(
    new HttpEditorClient(fetcher),
    (state, replaceFields) => {
      view = state.view
      loadedPath = state.path
      load.disabled = state.busy
      reload.disabled = state.busy || !view
      folder.disabled = state.busy
      scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)
      fields.disabled = state.busy || !view?.game || Boolean(view.diagnostics.length)
      status.textContent = state.busy
        ? 'Working...'
        : state.conflict
          ? 'Your entries are preserved. Reload latest, then save again to retry.'
          : state.changedElsewhere
            ? 'Saved files changed. Your entries are preserved; reload latest before saving.'
            : view
              ? `Loaded ${view.game?.title ?? 'project with errors'} from ${state.path || 'workspace root'}. Changes save immediately.`
              : ''
      error.textContent =
        state.error ||
        view?.diagnostics
          .map(
            (diagnostic) =>
              `${diagnostic.file} ${diagnostic.path.join('.')}: ${diagnostic.message}`,
          )
          .join('\n') ||
        ''
      error.hidden = !error.textContent

      if (!replaceFields || !view?.game) return

      const savedForm = state.lastCommand
        ? {
            'game.updateMetadata': metadata.id,
            'scene.updateMetadata': sceneMetadata.id,
            'scene.updateLayout': layout.id,
            'scene.create': create.id,
          }[state.lastCommand]
        : undefined

      if (savedForm) dirtyForms.delete(savedForm)
      else if (!state.preserveDrafts) dirtyForms.clear()

      if (!dirtyForms.has(create.id)) create.reset()
      scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)

      if (!dirtyForms.has(metadata.id)) {
        set('editor-title', view.game.title)
        set('editor-description', view.game.description)
        set('editor-version', view.game.version)
      }

      const selected = scenes.value
      scenes.replaceChildren(
        ...view.scenes.map((scene) => {
          const option = root.ownerDocument.createElement('option')
          option.value = scene.id
          option.textContent = `${scene.title} (${scene.id})`

          return option
        }),
      )

      if (
        selected &&
        !view.scenes.some((scene) => scene.id === selected) &&
        (dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id))
      ) {
        // A reload must never attach a removed scene's draft to another scene.
        const missing = root.ownerDocument.createElement('option')
        missing.value = selected
        missing.textContent = `Unavailable scene (${selected})`
        scenes.append(missing)
        scenes.value = selected
        status.textContent =
          'The selected scene is unavailable. Load the project again to discard its drafts.'
      }

      if (view.scenes.some((scene) => scene.id === selected)) scenes.value = selected
      fillScene()
    },
  )

  const listeners: (() => void)[] = []

  const on = (element: EventTarget, event: string, listener: EventListener) => {
    element.addEventListener(event, listener)
    listeners.push(() => element.removeEventListener(event, listener))
  }

  on(load, 'click', () => {
    const path = folder.value.trim()
    void controller.load(path.startsWith('/') ? path : path.replace(/\/+$/, ''))
  })
  on(reload, 'click', () => {
    void controller.load(loadedPath, dirtyForms.size > 0)
  })

  for (const form of [metadata, sceneMetadata, layout, create]) {
    on(form, 'input', () => {
      dirtyForms.add(form.id)
      scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)
    })
  }

  on(scenes, 'change', () => {
    fillScene()
  })

  const submit = (form: HTMLFormElement, action: () => void) =>
    on(form, 'submit', (event) => {
      event.preventDefault()
      action()
    })

  submit(metadata, () => {
    void controller.save({
      type: 'game.updateMetadata',
      title: value('editor-title'),
      description: value('editor-description'),
      version: value('editor-version'),
    })
  })
  submit(sceneMetadata, () => {
    void controller.save({
      type: 'scene.updateMetadata',
      sceneId: scenes.value,
      title: value('scene-title'),
      description: value('scene-description'),
    })
  })
  submit(layout, () => {
    void controller.save({
      type: 'scene.updateLayout',
      sceneId: scenes.value,
      rows: Number(value('scene-rows')),
      columns: Number(value('scene-columns')),
    })
  })
  submit(create, () => {
    void controller.save({
      type: 'scene.create',
      scene: {
        'schema-version': '1.0.0',
        id: value('new-scene-id'),
        title: value('new-scene-title'),
        description: '',
        type: find<HTMLSelectElement>('new-scene-type').value === 'game' ? 'game' : 'stand-alone',
        screen: {
          type: 'grid',
          grid: {
            rows: Number(value('new-scene-rows')),
            columns: Number(value('new-scene-columns')),
          },
        },
        components: [],
      },
    })
  })
  on(root.ownerDocument.defaultView!, 'focus', () => {
    void controller.refresh(() => dirtyForms.size > 0)
  })

  return () => {
    controller.dispose()

    for (const remove of listeners) remove()
  }
}
