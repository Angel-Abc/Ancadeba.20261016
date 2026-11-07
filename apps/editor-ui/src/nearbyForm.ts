import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { gameBindingSchema, gameIdSchema, type NearbyComponentDefinition } from '@ancadeba/schemas'
import {
  placementFields,
  type RuleFormControls,
  ruleFormControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'

/** Edits scene targets separately from the action-bar slots that display their commands. */
export function nearbyForm(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
  initialScene?: string,
): HTMLElement {
  const root = controls.group('Nearby characters and objects')
  const scenes = view.scenes.filter((scene) => scene.type === 'game')

  if (!scenes.length) {
    root.append('Add a game scene before configuring nearby targets.')

    return root
  }

  let sceneId = scenes.find((scene) => scene.id === initialScene)?.id ?? scenes[0]!.id
  let draft: NearbyComponentDefinition
  let selected = ''
  let dirty = false
  let newTarget = ''
  let newAction = ''
  const area = controls.create('div')
  const error = controls.create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')

  const fields = ruleFormControls(root.ownerDocument, () => {
    dirty = true
    controls.markEdited()
  })

  const { create, input, select, button, group, translation } = fields

  const conditions = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'boolean')
    .map(
      (field) =>
        [
          JSON.stringify({ source: 'game.state', path: field.path }),
          statePath(field.path),
        ] as const,
    )

  const keys = translationChoices(view, 'Use literal text')
  const actionIds = Object.keys(view.rules?.actions ?? {})

  const condition = (
    label: string,
    current: unknown,
    update: (value: ReturnType<typeof gameBindingSchema.parse> | undefined) => void,
  ) =>
    select(
      label,
      current ? JSON.stringify(current) : '',
      [['', 'Always'], ...conditions],
      (value) => update(value ? gameBindingSchema.parse(JSON.parse(value)) : undefined),
    )

  function render() {
    const scene = scenes.find((scene) => scene.id === sceneId)!
    const form = create('form')
    const existing = scene.components.some((component) => component.id === draft.id)

    if (!existing)
      form.append(
        input('Nearby component ID', draft.id, (value) => {
          draft.id = value.trim()
        }),
      )
    form.append(
      input('Nearby title', draft.label, (value) => {
        draft.label = value
      }),
      translation('Nearby title translation', draft.labelKey ?? '', keys, (value) => {
        draft.labelKey = value || undefined
      }),
      select(
        'Description text component',
        draft.descriptionTarget,
        scene.components.filter((component) => component.type === 'text').map(({ id }) => id),
        (value) => {
          draft.descriptionTarget = value
        },
      ),
      group(
        'Nearby panel placement',
        ...placementFields.map(([key, label]) =>
          input(
            `Nearby ${label.toLowerCase()}`,
            String(draft.placement[key]),
            (value) => {
              draft.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
      select(
        'Nearby target',
        selected,
        Object.entries(draft.entries).map(
          ([id, entry]) => [id, `${id} · ${entry.label || entry.labelKey}`] as const,
        ),
        (value) => {
          selected = value
          render()
        },
        false,
      ),
    )
    const entry = Object.hasOwn(draft.entries, selected) ? draft.entries[selected] : undefined

    if (entry) {
      const label = create('label')
      const description = create('textarea')
      description.value = entry.description
      description.addEventListener('input', () => {
        entry.description = description.value
        dirty = true
        controls.markEdited()
      })
      label.append('Target description', description)
      form.append(
        select('Target kind', entry.kind, ['character', 'object'], (value) => {
          entry.kind = value
        }),
        input('Target label', entry.label, (value) => {
          entry.label = value
        }),
        translation('Target label translation', entry.labelKey ?? '', keys, (value) => {
          entry.labelKey = value || undefined
        }),
        label,
        translation('Target description translation', entry.descriptionKey ?? '', keys, (value) => {
          entry.descriptionKey = value || undefined
        }),
        condition('Visible when true', entry.visibleWhen, (value) => {
          entry.visibleWhen = value
        }),
      )

      for (const [id, action] of Object.entries(entry.actions))
        form.append(
          group(
            `Nearby action ${id}`,
            select(`Requested action for ${id}`, action.action, actionIds, (value) => {
              action.action = value
            }),
            condition(`Enable ${id} when true`, action.enabledWhen, (value) => {
              action.enabledWhen = value
            }),
            button(`Remove nearby action ${id}`, () => {
              delete entry.actions[id]
              dirty = true
              controls.markEdited()
              render()
            }),
          ),
        )
      form.append(
        input('New nearby action ID', newAction, (value) => {
          newAction = value.trim()
        }),
        button('Add nearby action', () => {
          if (
            !gameIdSchema.safeParse(newAction).success ||
            Object.hasOwn(entry.actions, newAction)
          ) {
            error.textContent = 'Choose a unique action ID.'

            return
          }

          entry.actions = { ...entry.actions, [newAction]: { action: actionIds[0] ?? '' } }
          newAction = ''
          dirty = true
          controls.markEdited()
          render()
        }),
        button('Remove nearby target', () => {
          delete draft.entries[selected]
          selected = Object.keys(draft.entries)[0] ?? ''
          dirty = true
          controls.markEdited()
          render()
        }),
      )
    }

    form.append(
      input('New nearby target ID', newTarget, (value) => {
        newTarget = value.trim()
      }),
      button('Add nearby target', () => {
        if (!gameIdSchema.safeParse(newTarget).success || Object.hasOwn(draft.entries, newTarget)) {
          error.textContent = 'Choose a unique target ID.'

          return
        }

        draft.entries = {
          ...draft.entries,
          [newTarget]: {
            kind: 'object',
            label: newTarget,
            description: '',
            actions: {},
          },
        }
        selected = newTarget
        newTarget = ''
        dirty = true
        controls.markEdited()
        render()
      }),
    )
    const submit = create('button')
    submit.type = 'submit'
    submit.textContent = 'Save nearby targets'
    form.append(submit, button('Discard nearby draft', reset))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      save({ type: 'scene.upsertNearby', sceneId, component: draft })
    })
    area.replaceChildren(form)
  }

  function reset() {
    const scene = scenes.find((scene) => scene.id === sceneId)!
    const previous = scene.components.find((component) => component.type === 'nearby')
    draft = previous
      ? structuredClone(previous)
      : {
          id: 'nearby',
          type: 'nearby',
          label: 'Nearby',
          placement: { row: 1, column: scene.screen.grid.columns, rowSpan: 1, columnSpan: 1 },
          descriptionTarget:
            scene.components.find(
              (component) => component.id === 'narrative' && component.type === 'text',
            )?.id ??
            scene.components.find((component) => component.type === 'text')?.id ??
            '',
          entries: {},
        }
    selected = Object.keys(draft.entries)[0] ?? ''
    dirty = false
    newTarget = ''
    newAction = ''
    error.textContent = ''
    render()
  }

  const picker = controls.select(
    'Nearby game scene',
    sceneId,
    scenes.map(({ id }) => id),
    (value) => {
      if (dirty) {
        picker.querySelector('select')!.value = sceneId
        error.textContent = 'Save or discard the nearby draft before switching scenes.'

        return
      }

      sceneId = value
      reset()
    },
    false,
  )

  // Opened from a scene in the explorer, the scene is already chosen.
  picker.hidden = Boolean(initialScene)
  root.append(picker, error, area)
  reset()

  return root
}
