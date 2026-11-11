import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import { combatSourceSchema } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { combatDefinitionSchema, combatComponentSchema, type CombatSource } from '@ancadeba/schemas'
import { bindCombatLibraryEditor } from './combatLibraryEditor.js'
import { sharedCombatForm } from './sharedCombatForm.js'
import type { ProjectEditorState } from './projectController.js'
import { placementFields, ruleFormControls, saveBar, languageWatcher } from './ruleFormControls.js'
import { combatForm } from './combatForm.js'
import { sceneChoices } from './choiceLabels.js'

export function bindCombatEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  const libraryRoot = document.createElement('section')
  root.replaceChildren(error, fields, libraryRoot)
  const libraryEditor = bindCombatLibraryEditor(libraryRoot, save, t)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let encounterId = ''
  let draft: CombatSource | undefined
  let component: ReturnType<typeof combatComponentSchema.parse> | undefined
  let dirty = false
  let busy = false
  let creating = false
  let playerHealth = ''
  let enemyHealth = ''

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const reset = () => {
    const scene = view?.scenes.find((scene) => scene.id === sceneId)
    const found = scene?.components.find((component) => component.type === 'combat')
    encounterId = encounterId || (found?.type === 'combat' ? found.encounter : '')
    draft =
      encounterId && view?.combatSources?.[encounterId]
        ? structuredClone(view.combatSources[encounterId])
        : undefined
    component = draft
      ? found?.type === 'combat'
        ? structuredClone({ ...found, encounter: draft.id })
        : combatComponentSchema.parse({
            id: 'combat',
            type: 'combat',
            encounter: draft.id,
            placement: { row: 1, column: 1 },
          })
      : undefined
    dirty = false
    creating = false
    error.textContent = ''
    render()
  }

  const navigate = (id?: string, nextEncounter?: string) => {
    if (
      (id === undefined || id === sceneId) &&
      (nextEncounter === undefined || nextEncounter === encounterId)
    )
      return true

    if (dirty) {
      error.textContent = t('combat.saveFirstTargets')

      return false
    }

    sceneId = id ?? sceneId
    encounterId = nextEncounter ?? ''
    reset()

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return

    if (
      command.type === 'game.upsertCombat' &&
      creating &&
      (view?.game?.combat ?? []).some(
        (id) => id.toLowerCase() === command.encounter.id.toLowerCase(),
      )
    ) {
      error.textContent = t('combat.encounterExists')

      return
    }

    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      if (parsed.data.type === 'game.upsertCombat') encounterId = parsed.data.encounter.id
      save(parsed.data)
    }
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)

    const healthFields = (view.rules?.state ?? []).flatMap((field) =>
      typeof field.value === 'number' && field.value > 0
        ? [{ path: field.path, value: field.value }]
        : [],
    )

    const fieldId = (path: string[]) => (path.length ? JSON.stringify(path) : '')

    if (!healthFields.some((field) => fieldId(field.path) === playerHealth))
      playerHealth = fieldId(
        (healthFields.find((field) => field.path.at(-1) === 'health') ?? healthFields[0])?.path ??
          [],
      )

    if (
      enemyHealth === playerHealth ||
      !healthFields.some((field) => fieldId(field.path) === enemyHealth)
    )
      enemyHealth = fieldId(
        (
          healthFields.find(
            (field) => field.path.at(-1) === 'enemyHealth' && fieldId(field.path) !== playerHealth,
          ) ?? healthFields.find((field) => fieldId(field.path) !== playerHealth)
        )?.path ?? [],
      )

    const healthChoices = healthFields.map(
      (field) => [fieldId(field.path), `${field.path.join('.')} · ${field.value}`] as const,
    )

    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = t('combat.healthHelp')

    const picker = controls.select(
      t('combat.gameScene'),
      sceneId,
      sceneChoices(view, 'game'),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    picker.className = 'context-picker'

    const encounters = controls.select(
      t('combat.encounter'),
      encounterId,
      [['', t('form.choose')], ...Object.keys(view.combat ?? {})],
      (value) => {
        if (!navigate(sceneId, value)) encounters.querySelector('select')!.value = encounterId
      },
      false,
    )

    encounters.className = 'context-picker'

    fields.append(
      picker,
      encounters,
      controls.group(
        t('combat.newEncounterHealth'),
        help,
        controls.select(
          t('combat.newPlayerHealth'),
          playerHealth,
          healthChoices,
          (value) => {
            playerHealth = value
          },
          false,
        ),
        controls.select(
          t('combat.newEnemyHealth'),
          enemyHealth,
          healthChoices,
          (value) => {
            enemyHealth = value
          },
          false,
        ),
      ),
      controls.button(t('combat.addEncounter'), () => {
        if (dirty) {
          error.textContent = t('combat.saveFirst')

          return
        }

        const playerField = healthFields.find((field) => fieldId(field.path) === playerHealth)
        const enemyField = healthFields.find((field) => fieldId(field.path) === enemyHealth)

        if (
          !scene ||
          scene.type !== 'game' ||
          !playerField ||
          !enemyField ||
          playerHealth === enemyHealth
        ) {
          error.textContent = t('combat.chooseSceneAndHealth')

          return
        }

        error.textContent = ''
        let id = 'training'
        let number = 1

        while (view?.game?.combat?.some((entry) => entry.toLowerCase() === id.toLowerCase()))
          id = `training-${number++}`

        draft = combatDefinitionSchema.parse({
          'schema-version': '1.0.0',
          id,
          label: 'Training',
          player: {
            id: 'player',
            label: 'Player',
            health: { source: 'game.state', path: [...playerField.path] },
            maximumHealth: Math.max(40, playerField.value),
            moves: ['attack', 'guard'],
          },
          enemies: [
            {
              id: 'opponent',
              label: 'Opponent',
              health: { source: 'game.state', path: [...enemyField.path] },
              maximumHealth: Math.max(20, enemyField.value),
              moves: ['attack'],
              rotation: ['attack'],
            },
          ],
          moves: {
            attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 4 } },
            guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 4 },
          },
        })
        encounterId = id
        creating = true
        component = combatComponentSchema.parse({
          id: 'combat',
          type: 'combat',
          encounter: id,
          placement: {
            row: 1,
            column: 1,
            rowSpan: Math.min(5, scene?.screen.grid.rows ?? 1),
            columnSpan: scene?.screen.grid.columns ?? 1,
          },
        })
        dirty = true
        render()
      }),
    )

    if (!draft || !scene || !component) return
    const current = component
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = t('combat.saveEncounter')
    form.append(
      saveBar(document, button),
      sharedCombatForm(
        controls,
        view,
        draft,
        render,
        (library) => libraryEditor.navigate(library),
        (command) => {
          if (dirty) {
            error.textContent = t('combat.saveFirstCopy')

            return
          }

          submit(command)
        },
      ),
      ...combatForm(controls, view, draft, render, creating),
      controls.group(
        t('form.combatView'),
        controls.input(t('combat.componentId'), current.id, (value) => {
          current.id = value.trim()
        }),
        controls.select(
          t('combat.mainTextTarget'),
          current.textTarget ?? '',
          [
            '',
            ...scene.components
              .filter((component) => component.type === 'text')
              .map((component) => component.id),
          ],
          (value) => {
            current.textTarget = value || undefined
          },
        ),
        controls.select(
          t('combat.lootInventory'),
          current.lootInventory ?? '',
          [
            '',
            ...scene.components
              .filter((component) => component.type === 'inventory')
              .map((component) => component.id),
          ],
          (value) => {
            current.lootInventory = value || undefined
          },
        ),
        ...placementFields(t).map(([key, label]) =>
          controls.input(
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

      if (draft && component)
        submit({
          type: 'game.upsertCombat',
          encounter: draft,
          createOnly: creating,
          scene: { id: sceneId, component: { ...component, encounter: draft.id } },
        })
    })
    fields.append(
      form,
      controls.button(t('combat.discard'), reset),
      controls.button(t('combat.removeView'), () =>
        submit({ type: 'scene.setCombat', sceneId, component: null }),
      ),
      controls.button(
        t('combat.deleteEncounter'),
        () => {
          if (draft) submit({ type: 'game.removeCombat', encounterId: draft.id })
        },
        creating,
      ),
    )
  }

  registerEditorDraft(
    root,
    'combat',
    z.object({
      sceneId: z.string(),
      encounterId: z.string(),
      draft: combatSourceSchema.optional(),
      component: combatComponentSchema.optional(),
      creating: z.boolean(),
      playerHealth: z.string(),
      enemyHealth: z.string(),
    }),
    () =>
      dirty
        ? { sceneId, encounterId, draft, component, creating, playerHealth, enemyHealth }
        : undefined,
    (saved) => {
      sceneId = saved.sceneId
      encounterId = saved.encounterId
      draft = saved.draft
      component = saved.component
      creating = saved.creating
      playerHealth = saved.playerHealth
      enemyHealth = saved.enemyHealth
      dirty = true
      render()
    },
  )

  return {
    navigate,
    hasDrafts: () => dirty || libraryEditor.hasDrafts(),
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
      libraryEditor.render(state, replaceFields)
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        replaceFields &&
        [
          'game.upsertCombat',
          'game.removeCombat',
          'scene.setCombat',
          'combat.copySharedEntry',
        ].includes(state.lastCommand ?? '')

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        encounterId = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
