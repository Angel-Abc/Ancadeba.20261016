import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  levelingProfileSchema,
  levelingFieldSchema,
  levelingTextSchema,
  characterProgressionComponentSchema,
  type LevelingProfile,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'

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
  let draft: LevelingProfile | undefined
  let component: ReturnType<typeof characterProgressionComponentSchema.parse> | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const reset = () => {
    const scene = view?.scenes.find((scene) => scene.id === sceneId)

    const found = scene?.components.find(
      (component) =>
        component.type === 'character-progression' &&
        (!profileId || component.profile === profileId),
    )

    profileId =
      profileId ||
      (found?.type === 'character-progression'
        ? found.profile
        : (Object.keys(view?.leveling ?? {})[0] ?? ''))
    draft = view?.leveling?.[profileId] ? structuredClone(view.leveling[profileId]) : undefined
    component = draft
      ? found?.type === 'character-progression'
        ? structuredClone(found)
        : characterProgressionComponentSchema.parse({
            id: `progression-${draft.id}`,
            type: 'character-progression',
            profile: draft.id,
            placement: { row: 1, column: 1 },
          })
      : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (id?: string, nextProfile?: string) => {
    if (
      (id === undefined || id === sceneId) &&
      (nextProfile === undefined || nextProfile === profileId)
    )
      return true

    if (dirty) {
      error.textContent = 'Save or discard the leveling draft before switching targets.'

      return false
    }

    sceneId = id ?? sceneId
    profileId = nextProfile ?? ''
    reset()

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) save(parsed.data)
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)
    const { input, select, button, group } = controls

    const picker = select(
      'Leveling game scene',
      sceneId,
      view.scenes.filter((scene) => scene.type === 'game').map((scene) => scene.id),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    const profiles = select(
      'Leveling profile',
      profileId,
      ['', ...Object.keys(view.leveling ?? {})],
      (value) => {
        if (!navigate(sceneId, value)) profiles.querySelector('select')!.value = profileId
      },
      false,
    )

    fields.append(
      picker,
      profiles,
      button('Add leveling profile', () => {
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
        dirty = true
        render()
      }),
    )

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

    const keys = ['', ...(view.translationKeys ?? [])]

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
    saveButton.textContent = 'Save character progression'
    form.append(
      saveBar(document, saveButton, button('Discard leveling draft', reset)),
      input('Profile ID', current.id, (value) => {
        current.id = value.trim()
      }),
      input('Profile label', current.label, (value) => {
        current.label = value
      }),
      select('Profile label translation', current.labelKey ?? '', keys, (value) => {
        current.labelKey = value || undefined
      }),
      field('Total XP field', current.xp, (value) => {
        current.xp = value
      }),
      field('Level field', current.level, (value) => {
        current.level = value
      }),
    )
    const preview = document.createElement('p')

    const updatePreview = () => {
      preview.textContent = current.levels
        .map(
          (row, index) =>
            `Level ${index + 1}: ${row.xp} XP${row.gains.length ? ` · ${row.gains.map((gain) => `${gain.label || gain.id} +${gain.amount}`).join(', ')}` : ''}`,
        )
        .join(' | ')
    }

    updatePreview()
    form.append(preview)
    current.levels.forEach((row, index) => {
      const box = group(
        `Level ${index + 1}`,
        input(
          `Level ${index + 1} total XP threshold`,
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
            `Stat gain ${position + 1}`,
            input(`Level ${index + 1} gain ${position + 1} ID`, gain.id, (value) => {
              gain.id = value.trim()
            }),
            input(`Level ${index + 1} gain ${position + 1} label`, gain.label, (value) => {
              gain.label = value
              updatePreview()
            }),
            select(
              `Level ${index + 1} gain ${position + 1} translation`,
              gain.labelKey ?? '',
              keys,
              (value) => {
                gain.labelKey = value || undefined
              },
            ),
            field(`Level ${index + 1} gain ${position + 1} field`, gain.field, (value) => {
              gain.field = value
            }),
            input(
              `Level ${index + 1} gain ${position + 1} amount`,
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
      select('Configure health recovery', current.health ? 'yes' : 'no', ['no', 'yes'], (value) => {
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
      }),
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
          'Level-up health policy',
          health.policy,
          ['preserve', 'increase', 'restore'],
          (value) => {
            health.policy = value
          },
        ),
      )
    }

    form.append(
      group(
        'Progression view',
        input('Progression component ID', currentView.id, (value) => {
          currentView.id = value.trim()
        }),
        select(
          'Progression main text target',
          currentView.textTarget ?? '',
          [
            '',
            ...scene.components
              .filter((component) => component.type === 'text')
              .map((component) => component.id),
          ],
          (value) => {
            currentView.textTarget = value || undefined
          },
        ),
        ...(['row', 'column', 'rowSpan', 'columnSpan'] as const).map((key) =>
          input(
            `Progression ${key}`,
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
    heading.textContent = 'Progression text and translations'
    messages.append(heading)

    for (const key of levelingTextSchema.keyof().options)
      messages.append(
        input(`${key} progression text`, current.messages[key], (value) => {
          current.messages[key] = value
        }),
        select(`${key} progression translation`, current.messageKeys[key] ?? '', keys, (value) => {
          if (value) current.messageKeys[key] = value
          else delete current.messageKeys[key]
        }),
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
      button('Remove progression view', () =>
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
        replaceFields &&
        [
          'game.upsertLeveling',
          'game.removeLeveling',
          'scene.upsertLevelingView',
          'scene.removeLevelingView',
        ].includes(state.lastCommand ?? '')

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        profileId = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
