import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { resolveMapView, type ButtonComponentDefinition } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import {
  createComponentDraft,
  creatableComponentTypes,
  type BasicComponent,
  type CreatableComponentType,
} from './componentDrafts.js'
import type { ProjectEditorState } from './projectController.js'
import { nearbyForm } from './nearbyForm.js'
import { textBindingsForm, type TextBindingPending } from './textBindingsForm.js'
import {
  placementFields,
  ruleFormControls,
  saveBar,
  translationChoices,
  type RuleFormControls,
} from './ruleFormControls.js'

type ButtonAction = NonNullable<ButtonComponentDefinition['action']>

/** Component types this editor authors; other types keep their own editors or stay read-only. */
export const editableComponentTypes: readonly string[] = [
  'text',
  'button',
  'language-select',
  'map-view',
  'nearby',
  'quest-log',
]

const isBasic = (component: { type: string }): component is BasicComponent =>
  ['text', 'button', 'language-select', 'map-view', 'quest-log'].includes(component.type)

/** Edits one scene component selected in the project explorer. */
export function bindComponentEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  {
    t = editorLocalization().t,
    onCreated,
    onCancel,
  }: {
    t?: Translate
    onCreated?: (sceneId: string, componentId: string) => void
    onCancel?: (sceneId: string) => void
  } = {},
) {
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
  let creating = false
  let newType: CreatableComponentType = 'text'
  let submitted: { type: EditorCommand['type']; sceneId: string; componentId: string } | undefined
  let addLabel = t('component.add')
  const bindingPending: TextBindingPending = { alias: '', value: '' }

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

    if (parsed.success) {
      if (command.type === 'scene.upsertComponent' || command.type === 'scene.upsertNearby')
        submitted = {
          type: command.type,
          sceneId: command.sceneId,
          componentId: command.component.id,
        }
      save(parsed.data)
    }
  }

  const reset = () => {
    const current = component()
    draft =
      creating && view
        ? createComponentDraft(view, sceneId, newType)
        : current && isBasic(current)
          ? structuredClone(current)
          : undefined
    dirty = false
    bindingPending.alias = ''
    bindingPending.value = ''
    error.textContent = ''
    render()
  }

  const render = () => {
    fields.replaceChildren()
    const current = component()

    if (!view || !scene()) return

    if (!creating && current?.type === 'nearby') {
      fields.append(
        nearbyForm(controls, view, submit, sceneId, {
          componentId,
          onDiscard: () => {
            dirty = false
            error.textContent = ''
          },
        }),
      )

      return
    }

    if (!draft) return
    const form = document.createElement('form')
    form.className = 'component-form'
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = t(creating ? 'component.create' : 'component.save')
    saveButton.disabled = draft.type === 'map-view' && !view.game?.maps?.length

    if (creating) {
      const picker = controls.select(
        t('component.type'),
        newType,
        creatableComponentTypes.map((type) => [type, t(`tree.${type}`)] as const),
        (type) => {
          if (dirty) {
            picker.querySelector('select')!.value = newType
            error.textContent = t('component.discardFirst')

            return
          }

          newType = type
          reset()
        },
        false,
      )

      form.append(
        picker,
        controls.input(t('component.id'), draft.id, (id) => {
          draft!.id = id.trim()
        }),
      )
    }

    if (draft.type === 'language-select' && !view.game?.languages) {
      const help = document.createElement('p')
      help.className = 'help'
      help.textContent = t('component.languageHelp')
      form.append(help)
    }

    if (draft.type === 'map-view' && !view.game?.maps?.length) {
      const help = document.createElement('p')
      help.className = 'help'
      help.textContent = t('component.mapHelp')
      form.append(help)
    }

    form.append(
      saveBar(
        document,
        saveButton,
        controls.button(t('component.discard'), reset),
        ...(creating
          ? [
              controls.button(t('component.cancel'), () => {
                reset()
                onCancel?.(sceneId)
              }),
            ]
          : []),
      ),
      ...componentFields(controls, view, sceneId, draft, render, bindingPending),
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

      if (!draft) return
      const target = scene()

      if (!target) {
        error.textContent = t('component.sceneMissing')

        return
      }

      if (draft.type === 'text' && bindingPending.alias) {
        error.textContent = 'Add or clear the pending text binding before saving.'

        return
      }

      if (creating && target.components.some(({ id }) => id === draft!.id)) {
        error.textContent = t('component.duplicateId')

        return
      }

      if (draft.type === 'map-view') {
        try {
          resolveMapView(
            new Map(Object.entries(view?.maps ?? {})),
            draft.map,
            draft.viewport,
            draft.playerSpawn,
          )
        } catch (cause) {
          error.textContent = cause instanceof Error ? cause.message : String(cause)

          return
        }
      }

      submit({
        type: 'scene.upsertComponent',
        sceneId,
        component: draft,
        ...(creating ? { createOnly: true } : {}),
      })
    })
    fields.append(form)
  }

  return {
    hasDrafts: () => dirty,
    /** Shows a component; refuses to leave another component with unsaved changes. */
    navigate(nextScene: string | undefined, nextComponent: string | undefined, add = false) {
      if (nextScene === sceneId && (nextComponent ?? '') === componentId && add === creating)
        return true

      if (dirty) {
        error.textContent = t('component.discardFirst')

        return false
      }

      sceneId = nextScene ?? ''
      componentId = nextComponent ?? ''
      creating = add
      submitted = undefined
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
        replaceFields && submitted?.type === state.lastCommand && submitted !== undefined

      const created = saved && creating ? submitted : undefined

      if (created) {
        creating = false
        componentId = created.componentId
      }

      if (!state.busy) submitted = undefined

      const replace = projectChanged || (replaceFields && !state.preserveDrafts)

      const languageChanged = addLabel !== t('component.add')
      addLabel = t('component.add')

      if (replace || saved || (changed && !dirty)) reset()
      else if (draft && (languageChanged || (changed && draft.type === 'text'))) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)

      if (created) onCreated?.(created.sceneId, created.componentId)
    },
  }
}

function componentFields(
  controls: RuleFormControls,
  view: ProjectView,
  sceneId: string,
  draft: BasicComponent,
  render: () => void,
  bindingPending: TextBindingPending,
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

    const bindings = textBindingsForm(
      controls,
      view,
      draft,
      bindingPending,
      view.scenes.find((scene) => scene.id === sceneId)?.type === 'game',
      render,
      (placeholder) => {
        draft.text += `${draft.text && !/\s$/.test(draft.text) ? ' ' : ''}${placeholder}`
        text.value = draft.text
      },
    )

    text.addEventListener('input', () => {
      draft.text = text.value
      controls.markEdited()
      bindings.refresh()
    })
    const textField = create('label')
    textField.append('Text', text)

    return [
      textField,
      translation(
        'Text translation',
        draft.textKey ?? '',
        translationChoices(view, 'Use literal text'),
        (value) => {
          draft.textKey = value || undefined
          bindings.refresh()
        },
      ),
      bindings.element,
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

  if (draft.type === 'quest-log')
    return [
      ...label,
      input('Quest IDs (empty means all)', draft.quests?.join(', ') ?? '', (value) => {
        draft.quests = value.trim() ? value.split(',').map((id) => id.trim()) : undefined
      }),
      select(
        'Main text target',
        draft.textTarget ?? '',
        [
          '',
          ...(view.scenes
            .find((scene) => scene.id === sceneId)
            ?.components.filter((component) => component.type === 'text')
            .map((component) => component.id) ?? []),
        ],
        (value) => {
          draft.textTarget = value || undefined
        },
      ),
      ...(['not-started', 'active', 'ready', 'completed'] as const).map((status) =>
        select(
          `Show ${status}`,
          String(draft.statuses.includes(status)),
          ['true', 'false'],
          (value) => {
            draft.statuses =
              value === 'true'
                ? [...new Set([...draft.statuses, status])]
                : draft.statuses.filter((entry) => entry !== status)
          },
        ),
      ),
    ]

  if (draft.type === 'language-select') return label

  if (draft.type === 'map-view') {
    const viewport = draft.viewport

    return [
      ...label,
      select('Map', draft.map, view.game?.maps ?? [], (value) => {
        draft.map = value
        const map = view.maps?.[value]

        if (map) {
          viewport.columns = Math.min(viewport.columns, map.width)
          viewport.rows = Math.min(viewport.rows, map.height)
        }

        render()
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
      controls.group(
        'Player marker',
        select(
          'Show player',
          String(Boolean(draft.playerSpawn)),
          [
            ['false', 'No, pan the map'],
            ['true', 'Yes, move a player'],
          ],
          (value) => {
            draft.playerSpawn = value === 'true' ? { x: 0, y: 0 } : undefined
            render()
          },
        ),
        ...(draft.playerSpawn
          ? (['x', 'y'] as const).map((key) =>
              input(
                key === 'x' ? 'Player column' : 'Player row',
                String(draft.playerSpawn![key]),
                (value) => {
                  draft.playerSpawn![key] = Number(value)
                },
                'number',
              ),
            )
          : []),
      ),
    ]
  }

  const scenes = view.scenes.map((scene) => scene.id)
  const gameScenes = view.scenes.filter((scene) => scene.type === 'game').map((scene) => scene.id)
  const actions = Object.keys(view.rules?.actions ?? {})

  const mapViews =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter(
        (component) =>
          component.type === 'map-view' && component.playerSpawn && component.interactive !== false,
      )
      .map((component) => component.id) ?? []

  const action = draft.action

  const defaults = (type: string): ButtonAction | undefined =>
    type === 'save-game' || type === 'load-game'
      ? { type }
      : type === 'new-game' || type === 'enter-scene'
        ? { type, scene: (type === 'new-game' ? gameScenes : scenes)[0] ?? '' }
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
        ['save-game', 'Save progress'],
        ['load-game', 'Load saved progress'],
      ],
      (value) => {
        draft.action = defaults(value)
        render()
      },
    ),
    ...(action?.type === 'new-game' || action?.type === 'enter-scene'
      ? [
          select(
            'Target scene',
            action.scene,
            action.type === 'new-game' ? gameScenes : scenes,
            (value) => {
              action.scene = value
            },
          ),
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
