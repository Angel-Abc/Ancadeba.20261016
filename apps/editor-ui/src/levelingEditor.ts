import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  levelingProfileSchema,
  levelingFieldSchema,
  levelingTextSchema,
  characterProgressionComponentSchema,
  type LevelingProfile,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import {
  displayLabel,
  placementFields,
  ruleFormControls,
  saveBar,
  translationChoices,
} from './ruleFormControls.js'
import { sceneChoices } from './choiceLabels.js'

/** Readable names for the profile's display texts, keyed by schema key. */
const textNames = {
  level: 'Level label',
  xp: 'XP label',
  next: 'Next level label',
  capped: 'Maximum level label',
  unavailable: 'Unavailable message',
  gained: 'Level-up message',
  stat: 'Stat gain message',
  unlocked: 'Unlocked move message',
} satisfies Record<string, string>

export function bindLevelingEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let profileId = ''
  let componentId = ''
  let draft: LevelingProfile | undefined
  let component: ReturnType<typeof characterProgressionComponentSchema.parse> | undefined
  let dirty = false
  let busy = false
  let submitted: EditorCommand | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const reset = () => {
    const scene = view?.scenes.find((scene) => scene.id === sceneId)

    const displays =
      scene?.components.filter((entry) => entry.type === 'character-progression') ?? []

    const found =
      displays.find(
        (entry) => entry.id === componentId && (!profileId || entry.profile === profileId),
      ) ?? displays.find((entry) => !profileId || entry.profile === profileId)

    if (!profileId || !view?.leveling?.[profileId])
      profileId = found?.profile ?? Object.keys(view?.leveling ?? {})[0] ?? ''
    draft = view?.leveling?.[profileId] ? structuredClone(view.leveling[profileId]) : undefined
    component = draft
      ? found?.profile === profileId
        ? structuredClone(found)
        : characterProgressionComponentSchema.parse({
            id: `progression-${draft.id}`,
            type: 'character-progression',
            profile: draft.id,
            placement: { row: 1, column: 1 },
          })
      : undefined
    componentId = component?.id ?? ''
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (id?: string, nextProfile?: string, nextComponent?: string) => {
    if (
      (id === undefined || id === sceneId) &&
      (nextProfile === undefined || nextProfile === profileId) &&
      (nextComponent === undefined || nextComponent === componentId)
    )
      return true

    if (dirty) {
      error.textContent = 'Save or discard the leveling draft before switching targets.'

      return false
    }

    sceneId = id ?? sceneId
    profileId = nextProfile ?? ''
    componentId = nextComponent ?? ''
    reset()

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      submitted = structuredClone(parsed.data)
      save(parsed.data)
    }
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)
    const { input, select, button, group } = controls

    const picker = select(
      'Leveling game scene',
      sceneId,
      sceneChoices(view, 'game'),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    picker.className = 'context-picker'

    const profiles = select(
      'Leveling profile',
      profileId,
      ['', ...Object.keys(view.leveling ?? {})],
      (value) => {
        if (!navigate(sceneId, value)) profiles.querySelector('select')!.value = profileId
      },
      false,
    )

    profiles.className = 'context-picker'

    const addProfile = button('Add leveling profile', () => {
      if (dirty) {
        error.textContent = 'Save or discard the leveling draft first.'

        return
      }

      let id = 'player'
      let index = 1

      while (view?.leveling?.[id]) id = `player-${index++}`

      const path = (name: string) =>
        view?.rules?.state.find((field) => field.path.at(-1)?.toLowerCase() === name)?.path ?? [
          name,
        ]

      draft = levelingProfileSchema.parse({
        'schema-version': '1.0.0',
        id,
        label: 'Player progression',
        xp: { source: 'game.state', path: path('experience') },
        level: { source: 'game.state', path: path('level') },
        levels: [{ xp: 0 }, { xp: 10 }],
      })
      profileId = id
      component = characterProgressionComponentSchema.parse({
        id: `progression-${id}`,
        type: 'character-progression',
        profile: id,
        placement: { row: 1, column: 1 },
      })
      componentId = component.id
      dirty = true
      render()
    })

    addProfile.className = 'context-picker'

    fields.append(picker, profiles, addProfile)

    const displays =
      scene?.components.filter(
        (entry) => entry.type === 'character-progression' && entry.profile === profileId,
      ) ?? []

    if (displays.length > 1) {
      const display = select(
        'Level display',
        componentId,
        displays.map((entry) => entry.id),
        (value) => {
          if (!navigate(sceneId, profileId, value))
            display.querySelector('select')!.value = componentId
        },
        false,
      )

      display.className = 'context-picker'
      fields.append(display)
    }

    if (!draft || !component || !scene) return
    const current = draft
    const currentView = component

    const choices = (view.rules?.state ?? [])
      .filter((field) => typeof field.value === 'number')
      .map(
        (field) =>
          [
            JSON.stringify({ source: 'game.state', path: field.path }),
            field.path.join('.'),
          ] as const,
      )

    const keys = translationChoices(view, 'Use the literal text')

    const field = (
      title: string,
      value: LevelingProfile['xp'],
      update: (value: LevelingProfile['xp']) => void,
    ) =>
      select(title, JSON.stringify(value), choices, (value) =>
        update(levelingFieldSchema.parse(JSON.parse(value))),
      )

    const form = document.createElement('form')
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save character levels'
    form.append(
      saveBar(document, saveButton, button('Discard leveling draft', reset)),
      input('Profile ID', current.id, (value) => {
        current.id = value.trim()
      }),
      input('Profile label', current.label, (value) => {
        current.label = value
      }),
      controls.translation('Profile label translation', current.labelKey ?? '', keys, (value) => {
        current.labelKey = value || undefined
      }),
      field('Total XP field', current.xp, (value) => {
        current.xp = value
      }),
      field('Level field', current.level, (value) => {
        current.level = value
      }),
    )
    const preview = document.createElement('ol')
    preview.className = 'level-table'
    preview.setAttribute('aria-label', 'Level table')

    const updatePreview = () => {
      preview.replaceChildren(
        ...current.levels.map((row, index) => {
          const item = document.createElement('li')

          const gains = row.gains.map(
            (gain) => `${displayLabel(view!, gain.id, gain)} +${gain.amount}`,
          )

          item.textContent = [`Level ${index + 1}`, `${row.xp} XP`, ...gains].join(' · ')

          return item
        }),
      )
    }

    updatePreview()
    form.append(preview)
    current.levels.forEach((row, index) => {
      const start = document.createElement('p')
      start.className = 'help'
      start.textContent = 'The first level always starts at 0 XP and has no stat gains.'

      const box = group(
        `Level ${index + 1}`,
        index === 0
          ? start
          : input(
              'Total XP needed',
              String(row.xp),
              (value) => {
                row.xp = Number(value)
                updatePreview()
              },
              'number',
            ),
      )

      row.gains.forEach((gain, position) =>
        box.append(
          group(
            `Level ${index + 1} · stat gain ${position + 1}`,
            input('Stat ID', gain.id, (value) => {
              gain.id = value.trim()
            }),
            input('Stat label', gain.label, (value) => {
              gain.label = value
              updatePreview()
            }),
            controls.translation('Stat label translation', gain.labelKey ?? '', keys, (value) => {
              gain.labelKey = value || undefined
              updatePreview()
            }),
            field('Increases state field', gain.field, (value) => {
              gain.field = value
            }),
            input(
              'Amount added',
              String(gain.amount),
              (value) => {
                gain.amount = Number(value)
                updatePreview()
              },
              'number',
            ),
            button(`Remove level ${index + 1} gain ${position + 1}`, () => {
              row.gains.splice(position, 1)
              controls.markEdited()
              render()
            }),
          ),
        ),
      )

      if (index > 0)
        box.append(
          button(`Add level ${index + 1} stat gain`, () => {
            let id = 'stat'
            let number = 1

            while (row.gains.some((gain) => gain.id === id)) id = `stat-${number++}`
            row.gains.push({
              id,
              label: 'Maximum health',
              amount: 5,
              field: {
                source: 'game.state',
                path: view?.rules?.state.find((field) => field.path.at(-1) === 'maximumHealth')
                  ?.path ?? ['maximumHealth'],
              },
            })
            controls.markEdited()
            render()
          }),
        )
      form.append(box)
    })
    form.append(
      button('Add level', () => {
        current.levels.push({ xp: current.levels.at(-1)!.xp + 10, gains: [] })
        controls.markEdited()
        render()
      }),
      button(
        'Remove last level',
        () => {
          if (current.levels.length > 1) current.levels.pop()
          controls.markEdited()
          render()
        },
        current.levels.length <= 1,
      ),
      select(
        'Health on level-up',
        current.health ? 'yes' : 'no',
        [
          ['no', 'Leave health unchanged'],
          ['yes', 'Adjust health when maximum health grows'],
        ],
        (value) => {
          current.health =
            value === 'yes'
              ? {
                  current: {
                    source: 'game.state',
                    path: view?.rules?.state.find((field) => field.path.at(-1) === 'health')
                      ?.path ?? ['health'],
                  },
                  maximum: {
                    source: 'game.state',
                    path: view?.rules?.state.find((field) => field.path.at(-1) === 'maximumHealth')
                      ?.path ?? ['maximumHealth'],
                  },
                  policy: 'preserve',
                }
              : undefined
          render()
        },
      ),
    )

    if (current.health) {
      const health = current.health
      form.append(
        field('Current health field', health.current, (value) => {
          health.current = value
        }),
        field('Maximum health field', health.maximum, (value) => {
          health.maximum = value
        }),
        select(
          'Current health after a level-up',
          health.policy,
          [
            ['preserve', 'Keep current health'],
            ['increase', 'Add the maximum health gain'],
            ['restore', 'Restore to full health'],
          ],
          (value) => {
            health.policy = value
          },
        ),
      )
    }

    form.append(
      group(
        'Level display in this scene',
        input('Display component ID', currentView.id, (value) => {
          currentView.id = value.trim()
        }),
        select(
          'Show level-up messages in',
          currentView.textTarget ?? '',
          [
            ['', 'Only the level display'],
            ...scene.components
              .filter((component) => component.type === 'text')
              .map((component) => component.id),
          ],
          (value) => {
            currentView.textTarget = value || undefined
          },
        ),
        ...placementFields.map(([key, label]) =>
          input(
            label,
            String(currentView.placement[key]),
            (value) => {
              currentView.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      ),
    )
    const messages = document.createElement('details')
    const heading = document.createElement('summary')
    heading.textContent = 'Display text and translations'
    messages.append(heading)

    for (const key of levelingTextSchema.keyof().options)
      messages.append(
        group(
          textNames[key],
          input('Text', current.messages[key], (value) => {
            current.messages[key] = value
          }),
          controls.translation('Translation', current.messageKeys[key] ?? '', keys, (value) => {
            if (value) current.messageKeys[key] = value
            else delete current.messageKeys[key]
          }),
        ),
      )
    form.append(messages)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit({
        type: 'game.upsertLeveling',
        profile: current,
        scene: { id: sceneId, component: { ...currentView, profile: current.id } },
      })
    })
    fields.append(
      form,
      button('Remove level display from scene', () =>
        submit({ type: 'scene.removeLevelingView', sceneId, componentId: currentView.id }),
      ),
      button('Delete leveling profile', () =>
        submit({ type: 'game.removeLeveling', profileId: current.id }),
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
        submitted && replaceFields && !busy && !state.error && state.lastCommand === submitted.type
          ? submitted
          : undefined

      if (!busy) submitted = undefined

      if (saved?.type === 'game.upsertLeveling') {
        profileId = saved.profile.id
        componentId = saved.scene?.component.id ?? ''
      } else if (saved?.type === 'game.removeLeveling') {
        profileId = ''
        componentId = ''
      } else if (saved?.type === 'scene.removeLevelingView') componentId = ''

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        profileId = ''
        componentId = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
