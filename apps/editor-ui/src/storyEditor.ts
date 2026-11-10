import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
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
  displayLabel,
  yesNoChoices,
  ruleFormControls,
  saveBar,
  translationChoices,
  placementFields,
  languageWatcher,
} from './ruleFormControls.js'
import { dialogueForm, questForm } from './storyForms.js'
import { questChoices, questStatusLabels, sceneChoices } from './choiceLabels.js'

type Draft =
  | { kind: 'dialogue'; data: DialogueDefinition }
  | { kind: 'quest'; data: QuestDefinition }

export function bindStoryEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
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

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const journalControls = ruleFormControls(
    document,
    () => {
      journalDirty = true
    },
    t,
  )

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
      error.textContent = t('story.saveFirst')

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
    const project = view

    const picker = controls.select(
      t('story.picker'),
      selection,
      [
        ['', t('form.chooseDefinition')],
        ...Object.entries(view.dialogues ?? {}).map(
          ([id, dialogue]) =>
            [
              `dialogue:${id}`,
              t('story.dialogueTitle', { name: displayLabel(project, id, dialogue) }),
            ] as const,
        ),
        ...questChoices(view).map(
          ([id, name]) => [`quest:${id}`, t('story.questTitle', { name })] as const,
        ),
      ],
      (value) => {
        if (dirty) {
          picker.querySelector('select')!.value = selection
          error.textContent = t('story.saveFirstSwitch')

          return
        }

        selection = value
        reset()
      },
      false,
    )

    fields.append(
      picker,
      controls.button(t('story.addDialogue'), () => add('dialogue')),
      controls.button(t('story.addQuest'), () => add('quest')),
    )
    const journals = journalControls.group(t('story.journalPlacement'))
    journals.append(
      journalControls.select(
        t('story.journalScene'),
        journalScene,
        [['', t('story.noJournal')], ...sceneChoices(view, 'game')],
        (value) => {
          if (journalDirty && value !== journalScene) {
            const picker = journals.querySelector('select')

            if (picker) picker.value = journalScene
            error.textContent = t('story.journalSaveFirst')

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
      button.textContent = t('story.saveJournal')
      form.append(
        saveBar(document, button),
        journalControls.input(t('story.journalId'), current.id, (value) => {
          current.id = value
        }),
        journalControls.input(t('story.journalLabel'), current.label, (value) => {
          current.label = value
        }),
        journalControls.translation(
          t('story.journalLabelTranslation'),
          current.labelKey ?? '',
          translationChoices(view),
          (value) => {
            current.labelKey = value || undefined
          },
        ),
        journalControls.select(
          t('story.journalMainText'),
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
          t('story.journalQuestIds'),
          current.quests?.join(', ') ?? '',
          (value) => {
            current.quests = value.trim() ? value.split(',').map((id) => id.trim()) : undefined
          },
        ),
        ...(['not-started', 'active', 'ready', 'completed'] as const).map((status) =>
          journalControls.select(
            t('story.showQuests', {
              status: t(questStatusLabels.get(status) ?? status).toLowerCase(),
            }),
            String(current.statuses.includes(status)),
            yesNoChoices(t),
            (value) => {
              current.statuses =
                value === 'true'
                  ? [...new Set([...current.statuses, status])]
                  : current.statuses.filter((entry) => entry !== status)
            },
          ),
        ),
        ...placementFields(t).map(([key, label]) =>
          journalControls.input(
            t('story.journalField', { field: label }),
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
        journalControls.button(t('story.discardJournal'), () => {
          resetJournal()
          error.textContent = ''
          render()
        }),
      )
    }

    // The journal applies to quests, so it follows the chosen definition.
    if (!draft) {
      fields.append(journals)

      return
    }

    const current = draft
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent =
      current.kind === 'dialogue' ? t('story.saveDialogue') : t('story.saveQuest')
    form.append(
      saveBar(document, button, controls.button(t('story.discard'), reset)),
      controls.input(t('story.definitionId'), current.data.id, (value) => {
        current.data.id = value.trim()
      }),
      ...(current.kind === 'dialogue'
        ? dialogueForm(controls, view, current.data, render)
        : questForm(controls, view, current.data, render)),
    )
    const messages = controls.group(t('story.feedback'))
    const values: Record<string, string> = current.data.messages
    const keys: Record<string, string | undefined> = current.data.messageKeys

    for (const [key, value] of Object.entries(values))
      messages.append(
        controls.input(t('story.message', { key }), value, (value) => {
          values[key] = value
        }),
        controls.translation(
          t('story.messageTranslation', { key }),
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
      controls.button(t('story.deleteDefinition'), () =>
        submit(
          current.kind === 'dialogue'
            ? { type: 'game.removeDialogue', dialogueId: current.data.id }
            : { type: 'game.removeQuest', questId: current.data.id },
        ),
      ),
      journals,
    )
  }

  return {
    hasDrafts: () => dirty || journalDirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
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
      else if (changed || journalSaved || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
