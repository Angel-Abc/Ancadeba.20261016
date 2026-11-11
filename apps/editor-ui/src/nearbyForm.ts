import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import { nearbyComponentSchema } from '@ancadeba/schemas'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { gameBindingSchema, gameIdSchema, type NearbyComponentDefinition } from '@ancadeba/schemas'
import {
  placementFields,
  type RuleFormControls,
  ruleFormControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'
import { sceneChoices } from './choiceLabels.js'

/** Edits scene targets separately from the action-bar slots that display their commands. */
export function nearbyForm(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
  initialScene?: string,
  { componentId, onDiscard }: { componentId?: string; onDiscard?: () => void } = {},
): HTMLElement {
  const { t } = controls
  const root = controls.group(t('nearby.heading'))
  const scenes = view.scenes.filter((scene) => scene.type === 'game')

  if (!scenes.length) {
    root.append(t('nearby.sceneFirst'))

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

  const fields = ruleFormControls(
    root.ownerDocument,
    () => {
      dirty = true
      controls.markEdited()
    },
    t,
  )

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

  const keys = translationChoices(view, t('metadata.literalText'))
  const actionIds = Object.keys(view.rules?.actions ?? {})

  const condition = (
    label: string,
    current: unknown,
    update: (value: ReturnType<typeof gameBindingSchema.parse> | undefined) => void,
  ) =>
    select(
      label,
      current ? JSON.stringify(current) : '',
      [['', t('form.always')], ...conditions],
      (value) => update(value ? gameBindingSchema.parse(JSON.parse(value)) : undefined),
    )

  function render() {
    const scene = scenes.find((scene) => scene.id === sceneId)!
    const form = create('form')
    const existing = scene.components.some((component) => component.id === draft.id)

    if (!existing)
      form.append(
        input(t('nearby.componentId'), draft.id, (value) => {
          draft.id = value.trim()
        }),
      )
    form.append(
      input(t('nearby.title'), draft.label, (value) => {
        draft.label = value
      }),
      translation(t('nearby.titleTranslation'), draft.labelKey ?? '', keys, (value) => {
        draft.labelKey = value || undefined
      }),
      select(
        t('nearby.descriptionComponent'),
        draft.descriptionTarget,
        scene.components.filter((component) => component.type === 'text').map(({ id }) => id),
        (value) => {
          draft.descriptionTarget = value
        },
      ),
      group(
        t('nearby.placement'),
        ...placementFields(t).map(([key, label]) =>
          input(
            t('nearby.placementField', { field: label.toLowerCase() }),
            String(draft.placement[key]),
            (value) => {
              draft.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
      select(
        t('nearby.target'),
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
      label.append(t('nearby.targetDescription'), description)
      form.append(
        select(t('nearby.targetKind'), entry.kind, ['character', 'object'], (value) => {
          entry.kind = value
        }),
        input(t('nearby.targetLabel'), entry.label, (value) => {
          entry.label = value
        }),
        translation(t('nearby.targetLabelTranslation'), entry.labelKey ?? '', keys, (value) => {
          entry.labelKey = value || undefined
        }),
        label,
        translation(
          t('nearby.targetDescriptionTranslation'),
          entry.descriptionKey ?? '',
          keys,
          (value) => {
            entry.descriptionKey = value || undefined
          },
        ),
        select(
          t('nearby.dialogue'),
          entry.dialogue ?? '',
          ['', ...Object.keys(view.dialogues ?? {})],
          (value) => {
            entry.dialogue = value || undefined

            if (!value) entry.conversationId = undefined
          },
        ),
        input(t('nearby.conversationId'), entry.conversationId ?? '', (value) => {
          entry.conversationId = value || undefined
        }),
        condition(t('nearby.visibleWhen'), entry.visibleWhen, (value) => {
          entry.visibleWhen = value
        }),
      )

      for (const [id, action] of Object.entries(entry.actions))
        form.append(
          group(
            t('nearby.action', { id }),
            select(t('nearby.requestedAction', { id }), action.action, actionIds, (value) => {
              action.action = value
            }),
            condition(t('nearby.enableWhen', { id }), action.enabledWhen, (value) => {
              action.enabledWhen = value
            }),
            button(t('nearby.removeAction', { id }), () => {
              delete entry.actions[id]
              dirty = true
              controls.markEdited()
              render()
            }),
          ),
        )
      form.append(
        input(t('nearby.newActionId'), newAction, (value) => {
          newAction = value.trim()
        }),
        button(t('nearby.addAction'), () => {
          if (
            !gameIdSchema.safeParse(newAction).success ||
            Object.hasOwn(entry.actions, newAction)
          ) {
            error.textContent = t('nearby.uniqueActionId')

            return
          }

          entry.actions = { ...entry.actions, [newAction]: { action: actionIds[0] ?? '' } }
          newAction = ''
          dirty = true
          controls.markEdited()
          render()
        }),
        button(t('nearby.removeTarget'), () => {
          delete draft.entries[selected]
          selected = Object.keys(draft.entries)[0] ?? ''
          dirty = true
          controls.markEdited()
          render()
        }),
      )
    }

    form.append(
      input(t('nearby.newTargetId'), newTarget, (value) => {
        newTarget = value.trim()
      }),
      button(t('nearby.addTarget'), () => {
        if (!gameIdSchema.safeParse(newTarget).success || Object.hasOwn(draft.entries, newTarget)) {
          error.textContent = t('nearby.uniqueTargetId')

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
    submit.textContent = t('nearby.save')
    form.append(
      submit,
      button(t('nearby.discard'), () => {
        reset()
        onDiscard?.()
      }),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      save({ type: 'scene.upsertNearby', sceneId, component: draft })
    })
    area.replaceChildren(form)
  }

  function reset() {
    const scene = scenes.find((scene) => scene.id === sceneId)!

    const previous = scene.components.find(
      (component): component is NearbyComponentDefinition =>
        component.type === 'nearby' && (componentId === undefined || component.id === componentId),
    )

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
    t('nearby.gameScene'),
    sceneId,
    sceneChoices(view, 'game'),
    (value) => {
      if (dirty) {
        picker.querySelector('select')!.value = sceneId
        error.textContent = t('nearby.saveFirst')

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

  registerEditorDraft(
    root,
    `nearby:${initialScene ?? 'rules'}:${componentId ?? ''}`,
    z.object({
      sceneId: z.string(),
      draft: nearbyComponentSchema,
      selected: z.string(),
      newTarget: z.string(),
      newAction: z.string(),
    }),
    () => (dirty ? { sceneId, draft, selected, newTarget, newAction } : undefined),
    (saved) => {
      sceneId = saved.sceneId
      draft = saved.draft
      selected = saved.selected
      newTarget = saved.newTarget
      newAction = saved.newAction
      dirty = true
      controls.markEdited()
      render()
    },
  )

  return root
}
