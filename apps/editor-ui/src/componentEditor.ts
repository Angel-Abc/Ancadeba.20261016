import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type {
  ButtonComponentDefinition,
  LanguageSelectComponentDefinition,
  MapViewComponentDefinition,
  TextComponentDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { nearbyForm } from './nearbyForm.js'
import {
  placementFields,
  ruleFormControls,
  saveBar,
  translationChoices,
  type RuleFormControls,
} from './ruleFormControls.js'

type BasicComponent =
  | TextComponentDefinition
  | ButtonComponentDefinition
  | LanguageSelectComponentDefinition
  | MapViewComponentDefinition

type ButtonAction = NonNullable<ButtonComponentDefinition['action']>

/** Component types this editor authors; other types keep their own editors or stay read-only. */
export const editableComponentTypes: readonly string[] = [
  'text',
  'button',
  'language-select',
  'map-view',
  'nearby',
]

const isBasic = (component: { type: string }): component is BasicComponent =>
  ['text', 'button', 'language-select', 'map-view'].includes(component.type)

/** Edits one scene component selected in the project explorer. */
export function bindComponentEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
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
  let draft: BasicComponent | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const scene = () => view?.scenes.find((scene) => scene.id === sceneId)
  const component = () => scene()?.components.find((component) => component.id === componentId)

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('\n')

    if (parsed.success) save(parsed.data)
  }

  const reset = () => {
    const current = component()
    draft = current && isBasic(current) ? structuredClone(current) : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  const render = () => {
    fields.replaceChildren()
    const current = component()

    if (!view || !current) return

    if (current.type === 'nearby') {
      fields.append(nearbyForm(controls, view, submit, sceneId))

      return
    }

    if (!draft) return
    const form = document.createElement('form')
    form.className = 'component-form'
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save component'
    form.append(
      saveBar(document, saveButton, controls.button('Discard component draft', reset)),
      ...componentFields(controls, view, sceneId, draft, render),
      controls.group(
        'Placement',
        ...placementFields.map(([key, label]) =>
          controls.input(
            label,
            String(draft!.placement[key]),
            (value) => {
              draft!.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (draft) submit({ type: 'scene.upsertComponent', sceneId, component: draft })
    })
    fields.append(form)
  }

  return {
    hasDrafts: () => dirty,
    /** Shows a component; refuses to leave another component with unsaved changes. */
    navigate(nextScene: string | undefined, nextComponent: string | undefined) {
      if (nextScene === sceneId && nextComponent === componentId) return true

      if (dirty) {
        error.textContent = 'Save or discard the component draft first.'

        return false
      }

      sceneId = nextScene ?? ''
      componentId = nextComponent ?? ''
      reset()

      return true
    },
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        replaceFields &&
        ['scene.upsertComponent', 'scene.upsertNearby'].includes(state.lastCommand ?? '')

      const replace = projectChanged || (replaceFields && !state.preserveDrafts)

      if (replace || saved || (changed && !dirty)) reset()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}

function componentFields(
  controls: RuleFormControls,
  view: ProjectView,
  sceneId: string,
  draft: BasicComponent,
  render: () => void,
): HTMLElement[] {
  const { input, select, translation, create } = controls

  const literal = (title: string, emptyLabel: string) =>
    translation(
      title,
      draft.type === 'text' ? (draft.textKey ?? '') : (draft.labelKey ?? ''),
      translationChoices(view, emptyLabel),
      (value) => {
        if (draft.type === 'text') draft.textKey = value || undefined
        else draft.labelKey = value || undefined
      },
    )

  if (draft.type === 'text') {
    const text = create('textarea')
    text.rows = 4
    text.value = draft.text
    text.addEventListener('input', () => {
      draft.text = text.value
      controls.markEdited()
    })
    const textField = create('label')
    textField.append('Text', text)
    const aliases = Object.keys(draft.bindings ?? {})
    const bindings = create('p')
    bindings.className = 'help'
    bindings.textContent = aliases.length
      ? `Placeholders bound to game values: ${aliases.map((alias) => `{${alias}}`).join(', ')}. They are kept when you save.`
      : ''

    return [
      textField,
      ...(aliases.length ? [bindings] : []),
      literal('Text translation', 'Use literal text'),
      select(
        'Style',
        draft.presentation.variant,
        [
          ['body', 'Body text'],
          ['heading', 'Heading'],
        ],
        (value) => {
          draft.presentation.variant = value
        },
      ),
      select(
        'Alignment',
        draft.presentation.align,
        [
          ['start', 'Start'],
          ['center', 'Center'],
          ['end', 'End'],
        ],
        (value) => {
          draft.presentation.align = value
        },
      ),
    ]
  }

  const label = [
    input('Label', draft.label, (value) => {
      draft.label = value
    }),
    literal('Label translation', 'Use literal label'),
  ]

  if (draft.type === 'language-select') return label

  if (draft.type === 'map-view') {
    const viewport = draft.viewport

    return [
      ...label,
      select('Map', draft.map, view.game?.maps ?? [], (value) => {
        draft.map = value
      }),
      select(
        'Interactive',
        String(draft.interactive !== false),
        [
          ['true', 'Yes, the player moves on this map'],
          ['false', 'No, display only'],
        ],
        (value) => {
          draft.interactive = value === 'true' ? undefined : false
        },
      ),
      controls.group(
        'Visible area',
        ...(
          [
            ['columns', 'Columns'],
            ['rows', 'Rows'],
            ['x', 'Left column'],
            ['y', 'Top row'],
          ] as const
        ).map(([key, title]) =>
          input(
            title,
            String(viewport[key]),
            (value) => {
              viewport[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
    ]
  }

  const scenes = view.scenes.map((scene) => scene.id)
  const actions = Object.keys(view.rules?.actions ?? {})

  const mapViews =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'map-view')
      .map((component) => component.id) ?? []

  const action = draft.action

  const defaults = (type: string): ButtonAction | undefined =>
    type === 'new-game' || type === 'enter-scene'
      ? { type, scene: scenes[0] ?? '' }
      : type === 'request-action'
        ? { type, action: actions[0] ?? '' }
        : type === 'move-map'
          ? { type, mapView: mapViews[0] ?? '', direction: 'north' }
          : undefined

  return [
    ...label,
    select(
      'Action',
      action?.type ?? '',
      [
        ['', 'No action (button is disabled)'],
        ['new-game', 'Start a new game'],
        ['enter-scene', 'Go to a scene'],
        ['request-action', 'Run a rule action'],
        ['move-map', 'Move on a map'],
      ],
      (value) => {
        draft.action = defaults(value)
        render()
      },
    ),
    ...(action?.type === 'new-game' || action?.type === 'enter-scene'
      ? [
          select('Target scene', action.scene, scenes, (value) => {
            action.scene = value
          }),
        ]
      : action?.type === 'request-action'
        ? [
            select('Rule action', action.action, actions, (value) => {
              action.action = value
            }),
          ]
        : action?.type === 'move-map'
          ? [
              select('Map view', action.mapView, mapViews, (value) => {
                action.mapView = value
              }),
              select(
                'Direction',
                action.direction,
                [
                  ['north', 'North'],
                  ['east', 'East'],
                  ['south', 'South'],
                  ['west', 'West'],
                ],
                (value) => {
                  action.direction = value
                },
              ),
            ]
          : []),
  ]
}
