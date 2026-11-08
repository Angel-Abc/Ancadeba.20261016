import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  dialogueSchema,
  questSchema,
  questLogComponentSchema,
  type QuestLogComponentDefinition,
  type DialogueDefinition,
  type QuestDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import {
  ruleFormControls,
  saveBar,
  translationChoices,
  placementFields,
} from './ruleFormControls.js'
import { dialogueForm, questForm } from './storyForms.js'

type Draft =
  | { kind: 'dialogue'; data: DialogueDefinition }
  | { kind: 'quest'; data: QuestDefinition }

export function bindStoryEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let draft: Draft | undefined
  let selection = ''
  let dirty = false
  let journalDirty = false
  let busy = false
  let submitted: EditorCommand | undefined
  let journalScene = ''
  let journalId = ''
  let journal: QuestLogComponentDefinition | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const journalControls = ruleFormControls(document, () => {
    journalDirty = true
  })

  const resetJournal = () => {
    const existing = view?.scenes
      .find((scene) => scene.id === journalScene)
      ?.components.find(
        (component) => component.type === 'quest-log' && (!journalId || component.id === journalId),
      )

    journalId = existing?.id ?? ''
    journal =
      existing?.type === 'quest-log'
        ? structuredClone(existing)
        : journalScene
          ? questLogComponentSchema.parse({
              id: 'quests',
              type: 'quest-log',
              placement: { row: 1, column: 1 },
            })
          : undefined
    journalDirty = false
  }

  const reset = () => {
    const [kind, id] = selection.split(':')
    const data = kind === 'dialogue' ? view?.dialogues?.[id ?? ''] : view?.quests?.[id ?? '']
    draft = data
      ? kind === 'dialogue'
        ? { kind, data: dialogueSchema.parse(structuredClone(data)) }
        : { kind: 'quest', data: questSchema.parse(structuredClone(data)) }
      : undefined
    dirty = false
    error.textContent = ''
    render()
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

  const add = (kind: Draft['kind']) => {
    if (dirty) {
      error.textContent = 'Save or discard the current dialogue or quest draft first.'

      return
    }

    let id: string = kind
    let number = 1

    while (view?.dialogues?.[id] || view?.quests?.[id]) id = `${kind}-${number++}`
    selection = `${kind}:${id}`
    draft =
      kind === 'dialogue'
        ? {
            kind,
            data: dialogueSchema.parse({
              'schema-version': '1.0.0',
              id,
              label: 'Conversation',
              entry: 'start',
              nodes: { start: { terminal: true, lines: [{ text: 'Welcome.' }] } },
            }),
          }
        : {
            kind,
            data: questSchema.parse({
              'schema-version': '1.0.0',
              id,
              label: 'Quest',
              stages: [
                {
                  id: 'first',
                  label: 'First stage',
                  objectives: [
                    {
                      id: 'visit',
                      label: 'Visit the destination',
                      when: [
                        {
                          type: 'scene-is',
                          scene: view?.scenes.find((scene) => scene.type === 'game')?.id ?? '',
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          }
    dirty = true
    render()
  }

  function render(): void {
    fields.replaceChildren()

    if (!view?.game) return

    const picker = controls.select(
      'Dialogue or quest',
      selection,
      [
        ['', 'Choose a definition'],
        ...Object.keys(view.dialogues ?? {}).map(
          (id) => [`dialogue:${id}`, `Dialogue: ${id}`] as const,
        ),
        ...Object.keys(view.quests ?? {}).map((id) => [`quest:${id}`, `Quest: ${id}`] as const),
      ],
      (value) => {
        if (dirty) {
          picker.querySelector('select')!.value = selection
          error.textContent = 'Save or discard this draft before switching definitions.'

          return
        }

        selection = value
        reset()
      },
      false,
    )

    fields.append(
      picker,
      controls.button('Add dialogue', () => add('dialogue')),
      controls.button('Add quest', () => add('quest')),
    )
    const journals = journalControls.group('Quest journal placement')
    journals.append(
      journalControls.select(
        'Journal scene',
        journalScene,
        ['', ...view.scenes.filter((scene) => scene.type === 'game').map((scene) => scene.id)],
        (value) => {
          if (journalDirty && value !== journalScene) {
            const picker = journals.querySelector('select')

            if (picker) picker.value = journalScene
            error.textContent = 'Save or discard the journal draft first.'

            return
          }

          journalScene = value
          journalId = ''
          resetJournal()
          render()
        },
        false,
      ),
    )

    if (journal && journalScene) {
      const current = journal
      const form = document.createElement('form')
      const button = document.createElement('button')
      button.type = 'submit'
      button.textContent = 'Save quest journal'
      form.append(
        saveBar(document, button),
        journalControls.input('Journal component ID', current.id, (value) => {
          current.id = value
        }),
        journalControls.input('Journal label', current.label, (value) => {
          current.label = value
        }),
        journalControls.translation(
          'Journal label translation',
          current.labelKey ?? '',
          translationChoices(view),
          (value) => {
            current.labelKey = value || undefined
          },
        ),
        journalControls.select(
          'Journal main text',
          current.textTarget ?? '',
          [
            '',
            ...(view.scenes
              .find((scene) => scene.id === journalScene)
              ?.components.filter((component) => component.type === 'text')
              .map((component) => component.id) ?? []),
          ],
          (value) => {
            current.textTarget = value || undefined
          },
        ),
        journalControls.input(
          'Journal quest IDs (empty means all)',
          current.quests?.join(', ') ?? '',
          (value) => {
            current.quests = value.trim() ? value.split(',').map((id) => id.trim()) : undefined
          },
        ),
        ...(['not-started', 'active', 'ready', 'completed'] as const).map((status) =>
          journalControls.select(
            `Journal show ${status}`,
            String(current.statuses.includes(status)),
            ['true', 'false'],
            (value) => {
              current.statuses =
                value === 'true'
                  ? [...new Set([...current.statuses, status])]
                  : current.statuses.filter((entry) => entry !== status)
            },
          ),
        ),
        ...placementFields.map(([key, label]) =>
          journalControls.input(
            `Journal ${label}`,
            String(current.placement[key]),
            (value) => {
              current.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      )
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        submit({ type: 'scene.upsertComponent', sceneId: journalScene, component: current })
      })
      journals.append(
        form,
        journalControls.button('Discard journal draft', () => {
          resetJournal()
          error.textContent = ''
          render()
        }),
      )
    }

    fields.append(journals)

    if (!draft) return
    const current = draft
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = current.kind === 'dialogue' ? 'Save dialogue' : 'Save quest'
    form.append(
      saveBar(document, button, controls.button('Discard story draft', reset)),
      controls.input('Definition ID', current.data.id, (value) => {
        current.data.id = value.trim()
      }),
      ...(current.kind === 'dialogue'
        ? dialogueForm(controls, view, current.data, render)
        : questForm(controls, view, current.data, render)),
    )
    const messages = controls.group('Feedback and translations')
    const values: Record<string, string> = current.data.messages
    const keys: Record<string, string | undefined> = current.data.messageKeys

    for (const [key, value] of Object.entries(values))
      messages.append(
        controls.input(`Message ${key}`, value, (value) => {
          values[key] = value
        }),
        controls.translation(
          `Message ${key} translation`,
          keys[key] ?? '',
          translationChoices(view),
          (value) => {
            if (value) keys[key] = value
            else delete keys[key]
          },
        ),
      )
    form.append(messages)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit(
        current.kind === 'dialogue'
          ? { type: 'game.upsertDialogue', dialogue: current.data }
          : { type: 'game.upsertQuest', quest: current.data },
      )
    })
    fields.append(
      form,
      controls.button('Delete definition', () =>
        submit(
          current.kind === 'dialogue'
            ? { type: 'game.removeDialogue', dialogueId: current.data.id }
            : { type: 'game.removeQuest', questId: current.data.id },
        ),
      ),
    )
  }

  return {
    hasDrafts: () => dirty || journalDirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && !busy && replaceFields && !state.error && state.lastCommand === submitted.type
          ? submitted
          : undefined

      if (!busy) submitted = undefined

      const storySaved =
        saved?.type === 'game.upsertDialogue' ||
        saved?.type === 'game.upsertQuest' ||
        saved?.type === 'game.removeDialogue' ||
        saved?.type === 'game.removeQuest'

      const journalSaved =
        saved?.type === 'scene.upsertComponent' && saved.component.type === 'quest-log'

      if (saved?.type === 'game.upsertDialogue') selection = `dialogue:${saved.dialogue.id}`
      else if (saved?.type === 'game.upsertQuest') selection = `quest:${saved.quest.id}`
      else if (saved?.type === 'game.removeDialogue' || saved?.type === 'game.removeQuest')
        selection = ''

      if (saved?.type === 'scene.upsertComponent' && journalSaved) {
        journalScene = saved.sceneId
        journalId = saved.component.id
      }

      if (projectChanged) {
        selection = ''
        journalScene = ''
        journalId = ''
        journal = undefined
        journalDirty = false
        submitted = undefined
      }

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields || journalSaved || (changed && !journalDirty)) resetJournal()

      if (resetFields || storySaved || (changed && !dirty)) reset()
      else if (changed || journalSaved) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
