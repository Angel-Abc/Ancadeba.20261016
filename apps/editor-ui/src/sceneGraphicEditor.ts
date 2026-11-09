import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  graphicComponentSchema,
  graphicAppearanceSchema,
  assertGraphicReference,
  type GraphicComponentDefinition,
} from '@ancadeba/schemas'
import { resolveGraphic } from '@ancadeba/game-runtime'
import type { RenderedGraphic } from '@ancadeba/ui-components'
import type { ProjectEditorState } from './projectController.js'
import {
  ruleFormControls,
  placementFields,
  saveBar,
  translationChoices,
} from './ruleFormControls.js'
import { graphicAppearanceForm } from './graphicAppearanceForm.js'
import { startingGameBindings } from './textBindingChoices.js'

export type SceneGraphicPreviewFactory = (
  component: GraphicComponentDefinition,
  view: ProjectView,
  startingValues: boolean,
) => RenderedGraphic | undefined

/** Owns per-instance appearance drafts independently of shared asset definitions. */
export function bindSceneGraphicEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  createPreview?: SceneGraphicPreviewFactory,
) {
  const document = root.ownerDocument
  const fields = document.createElement('fieldset')
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const previewRoot = document.createElement('div')
  previewRoot.className = 'scene-graphic-preview'
  previewRoot.setAttribute('aria-label', 'Scene graphic appearance preview')
  const previewStatus = document.createElement('p')
  previewStatus.setAttribute('role', 'status')
  previewStatus.setAttribute('aria-label', 'Graphic preview status')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let componentId = ''
  let draft: GraphicComponentDefinition | undefined
  let creating = true
  let dirty = false
  let busy = false
  let startingValues = false
  let preview: RenderedGraphic | undefined
  let submitted: EditorCommand | undefined

  const clearPreview = () => {
    preview?.dispose()
    preview = undefined
    previewRoot.replaceChildren()
  }

  const updatePreview = () => {
    clearPreview()

    if (!draft || !view?.assets) {
      previewStatus.textContent = 'Import or register artwork in Assets first.'

      return
    }

    try {
      const parsed = graphicComponentSchema.parse(draft)
      assertGraphicReference(view.assets, parsed.visual, parsed.appearance)

      const component = startingValues
        ? parsed
        : {
            ...parsed,
            appearance: {
              ...parsed.appearance,
              bindings: undefined,
              slots: Object.fromEntries(
                Object.entries(parsed.appearance.slots).map(([id, slot]) => [
                  id,
                  { ...slot, bindings: undefined, partBinding: undefined },
                ]),
              ),
            },
          }

      const resolution = resolveGraphic(
        view.assets,
        component.visual,
        component.appearance,
        startingValues ? startingGameBindings(view) : undefined,
      )

      const mode = startingValues ? 'Starting game values' : 'Static fallback values'
      previewStatus.textContent = `${mode}: ${resolution.visible ? `${resolution.pieces.length} image piece(s)` : 'Graphic hidden'}.${resolution.diagnostics.length ? ` ${resolution.diagnostics.map((entry) => `${entry.target}: ${entry.message}`).join('; ')}` : ''}`
      preview = createPreview?.(component, view, startingValues)

      if (preview) previewRoot.append(preview.element)
    } catch (cause) {
      previewStatus.textContent = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const edited = () => {
    dirty = true
    updatePreview()
  }

  const controls = ruleFormControls(document, edited)

  const change = (operation: () => void) => {
    operation()
    dirty = true
    error.textContent = ''
    render()
  }

  const reset = () => {
    const scene = view?.scenes.find((scene) => scene.id === sceneId)

    const current = scene?.components.find(
      (component) => component.id === componentId && component.type === 'graphic',
    )

    creating = current?.type !== 'graphic'

    if (current?.type === 'graphic') draft = structuredClone(current)
    else if (scene && !componentId) {
      let id = 'graphic'
      let suffix = 2

      while (scene.components.some((component) => component.id === id)) id = `graphic-${suffix++}`
      draft = graphicComponentSchema.parse({
        id,
        type: 'graphic',
        visual:
          Object.keys(view?.assets?.images ?? {})[0] ??
          Object.keys(view?.assets?.parts ?? {})[0] ??
          Object.keys(view?.assets?.compositions ?? {})[0] ??
          'choose-visual',
        alt: '',
        placement: {
          row: 1,
          column: 1,
          rowSpan: Math.min(4, scene.screen.grid.rows),
          columnSpan: Math.min(4, scene.screen.grid.columns),
        },
      })
    } else draft = undefined
    dirty = false
    error.textContent = ''
    render()
  }

  function render() {
    fields.replaceChildren()
    clearPreview()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)

    if (!draft || !scene) {
      fields.append('Select a scene graphic or choose Add graphic in the scene explorer.')

      return
    }

    const current = draft
    const { input, select, button, group, translation } = controls
    const form = document.createElement('form')
    form.className = 'scene-graphic-form'
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Save scene graphic'

    const identity = input('Graphic component ID', current.id, (value) => {
      if (creating) current.id = value.trim()
    })

    identity.querySelector('input')!.readOnly = !creating
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent =
      'Edit this scene instance without changing the shared artwork. Choosing a different visual resets its appearance. Changing a slot part keeps compatible overrides and clears incompatible colors or palettes. Save to update the game preview.'
    const assets = view.assets

    const visuals = [
      ...Object.keys(assets?.images ?? {}),
      ...Object.keys(assets?.parts ?? {}),
      ...Object.keys(assets?.compositions ?? {}),
    ]

    form.append(
      saveBar(document, submit, button('Discard scene graphic draft', reset)),
      help,
      identity,
      select('Graphic visual', current.visual, visuals, (value) =>
        change(() => {
          current.visual = value
          current.appearance = graphicAppearanceSchema.parse({})
        }),
      ),
      input('Graphic alternative text', current.alt, (value) => {
        current.alt = value
      }),
      translation(
        'Graphic alternative text translation',
        current.altKey ?? '',
        translationChoices(view, 'Use literal text'),
        (value) => {
          current.altKey = value || undefined
        },
      ),
      select(
        'Graphic fit',
        current.fit,
        [
          ['contain', 'Contain'],
          ['cover', 'Cover'],
        ],
        (value) => {
          current.fit = value
        },
      ),
      group(
        'Graphic preview',
        select(
          'Preview values',
          startingValues ? 'starting' : 'static',
          [
            ['static', 'Static fallback values'],
            ['starting', 'Starting game values'],
          ],
          (value) => {
            startingValues = value === 'starting'
            updatePreview()
          },
          false,
        ),
        previewStatus,
        previewRoot,
      ),
    )

    if (assets)
      form.append(
        graphicAppearanceForm(
          controls,
          view,
          assets,
          current.visual,
          current.appearance,
          scene.type === 'game',
          change,
          edited,
        ),
      )
    form.append(
      group(
        'Graphic placement',
        ...placementFields.map(([key, label]) =>
          input(
            label,
            String(current.placement[key]),
            (value) => {
              current.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (busy) return

      const parsed = commandSchema.safeParse({
        type: 'scene.upsertGraphic',
        sceneId,
        component: current,
        createOnly: creating,
      })

      if (!parsed.success) {
        error.textContent = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')

        return
      }

      if (!assets) {
        error.textContent = 'Import or register artwork in Assets first.'

        return
      }

      if (creating && scene.components.some((component) => component.id === current.id)) {
        error.textContent = 'A component with this ID already exists. Choose a different ID.'

        return
      }

      try {
        assertGraphicReference(assets, current.visual, current.appearance)
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause)

        return
      }

      error.textContent = ''
      submitted = structuredClone(parsed.data)
      save(parsed.data)
    })
    fields.append(form)

    if (!creating)
      fields.append(
        button('Remove scene graphic', () => {
          if (!busy) {
            submitted = { type: 'scene.removeGraphic', sceneId, componentId }
            save(submitted)
          }
        }),
      )
    fields.disabled = busy || Boolean(view.diagnostics.length)
    updatePreview()
  }

  return {
    hasDrafts: () => dirty,
    navigate(nextScene: string, nextComponent = '') {
      if (nextScene === sceneId && nextComponent === componentId) return true

      if (dirty) {
        error.textContent = 'Save or discard the scene graphic draft before switching targets.'

        return false
      }

      sceneId = nextScene
      componentId = nextComponent
      startingValues = false
      reset()

      return true
    },
    render(state: ProjectEditorState, replace: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && replace && !busy && !state.error && state.lastCommand === submitted.type

      if (saved && submitted?.type === 'scene.upsertGraphic') componentId = submitted.component.id

      if (saved && submitted?.type === 'scene.removeGraphic') componentId = ''

      if (!busy) submitted = undefined

      if (projectChanged) {
        sceneId = ''
        componentId = ''
        startingValues = false
      }

      if (projectChanged || saved || (replace && !state.preserveDrafts) || (changed && !dirty))
        reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
    dispose: clearPreview,
  }
}
