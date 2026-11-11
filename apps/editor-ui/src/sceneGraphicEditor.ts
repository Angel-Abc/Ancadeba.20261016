import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
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
  languageWatcher,
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
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const fields = document.createElement('fieldset')
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const previewRoot = document.createElement('div')
  previewRoot.className = 'scene-graphic-preview'
  previewRoot.setAttribute('aria-label', t('graphic.previewLabel'))
  const previewStatus = document.createElement('p')
  previewStatus.setAttribute('role', 'status')
  previewStatus.setAttribute('aria-label', t('graphic.previewStatus'))
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
      previewStatus.textContent = t('graphic.artFirst')

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

      const mode = startingValues ? t('graphic.startingValues') : t('graphic.staticValues')

      const summary = resolution.visible
        ? t('graphic.statusPieces', { mode, count: resolution.pieces.length })
        : t('graphic.statusHidden', { mode })

      const diagnostics = resolution.diagnostics
        .map((entry) => `${entry.target}: ${entry.message}`)
        .join('; ')

      previewStatus.textContent = diagnostics ? `${summary} ${diagnostics}` : summary
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

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(document, edited, t)

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
      fields.append(t('graphic.selectHelp'))

      return
    }

    const current = draft
    const { input, select, button, group, translation } = controls
    const form = document.createElement('form')
    form.className = 'scene-graphic-form'
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = t('graphic.save')

    const identity = input(t('graphic.componentId'), current.id, (value) => {
      if (creating) current.id = value.trim()
    })

    identity.querySelector('input')!.readOnly = !creating
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = t('graphic.help')
    const assets = view.assets

    const visuals = [
      ...Object.keys(assets?.images ?? {}),
      ...Object.keys(assets?.parts ?? {}),
      ...Object.keys(assets?.compositions ?? {}),
    ]

    form.append(
      saveBar(document, submit, button(t('graphic.discard'), reset)),
      help,
      identity,
      select(t('graphic.visual'), current.visual, visuals, (value) =>
        change(() => {
          current.visual = value
          current.appearance = graphicAppearanceSchema.parse({})
        }),
      ),
      input(t('graphic.alt'), current.alt, (value) => {
        current.alt = value
      }),
      translation(
        t('graphic.altTranslation'),
        current.altKey ?? '',
        translationChoices(view, t('metadata.literalText')),
        (value) => {
          current.altKey = value || undefined
        },
      ),
      select(
        t('graphic.fit'),
        current.fit,
        [
          ['contain', t('assets.contain')],
          ['cover', t('assets.cover')],
        ],
        (value) => {
          current.fit = value
        },
      ),
      group(
        t('graphic.preview'),
        select(
          t('graphic.previewValues'),
          startingValues ? 'starting' : 'static',
          [
            ['static', t('graphic.staticValues')],
            ['starting', t('graphic.startingValues')],
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
        t('graphic.placement'),
        ...placementFields(t).map(([key, label]) =>
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
        error.textContent = t('graphic.artFirst')

        return
      }

      if (creating && scene.components.some((component) => component.id === current.id)) {
        error.textContent = t('form.componentExists')

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
        button(t('graphic.remove'), () => {
          if (!busy) {
            submitted = { type: 'scene.removeGraphic', sceneId, componentId }
            save(submitted)
          }
        }),
      )
    fields.disabled = busy || Boolean(view.diagnostics.length)
    updatePreview()
  }

  registerEditorDraft(
    root,
    'scene-graphic',
    z.object({
      sceneId: z.string(),
      componentId: z.string(),
      draft: graphicComponentSchema.optional(),
      creating: z.boolean(),
    }),
    () => (dirty ? { sceneId, componentId, draft, creating } : undefined),
    (saved) => {
      sceneId = saved.sceneId
      componentId = saved.componentId
      draft = saved.draft
      creating = saved.creating
      dirty = true
      render()
    },
  )

  return {
    hasDrafts: () => dirty,
    navigate(nextScene: string, nextComponent = '') {
      if (nextScene === sceneId && nextComponent === componentId) return true

      if (dirty) {
        error.textContent = t('graphic.saveFirst')

        return false
      }

      sceneId = nextScene
      componentId = nextComponent
      startingValues = false
      reset()

      return true
    },
    render(state: ProjectEditorState, replace: boolean) {
      const translated = languageChanged()
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
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
    dispose: clearPreview,
  }
}
