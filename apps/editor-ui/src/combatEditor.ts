import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  combatDefinitionSchema,
  combatComponentSchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { placementFields, ruleFormControls, saveBar } from './ruleFormControls.js'
import { combatForm } from './combatForm.js'

export function bindCombatEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let encounterId = ''
  let draft: CombatDefinition | undefined
  let component: ReturnType<typeof combatComponentSchema.parse> | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const reset = () => {
    const scene = view?.scenes.find((scene) => scene.id === sceneId)
    const found = scene?.components.find((component) => component.type === 'combat')
    encounterId = encounterId || (found?.type === 'combat' ? found.encounter : '')
    draft =
      encounterId && view?.combat?.[encounterId]
        ? structuredClone(view.combat[encounterId])
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
      error.textContent = 'Save or discard the combat draft before switching targets.'

      return false
    }

    sceneId = id ?? sceneId
    encounterId = nextEncounter ?? ''
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
      if (parsed.data.type === 'game.upsertCombat') encounterId = parsed.data.encounter.id
      save(parsed.data)
    }
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)

    const picker = controls.select(
      'Combat game scene',
      sceneId,
      view.scenes.filter((scene) => scene.type === 'game').map((scene) => scene.id),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    const encounters = controls.select(
      'Combat encounter',
      encounterId,
      [['', 'Choose…'], ...Object.keys(view.combat ?? {})],
      (value) => {
        if (!navigate(sceneId, value)) encounters.querySelector('select')!.value = encounterId
      },
      false,
    )

    fields.append(
      picker,
      encounters,
      controls.button('Add encounter', () => {
        if (dirty) {
          error.textContent = 'Save or discard the combat draft first.'

          return
        }

        let id = 'training'
        let number = 1

        while (view?.combat?.[id]) id = `training-${number++}`

        const health = view?.rules?.state.find(
          (field) => typeof field.value === 'number' && field.path.at(-1) === 'health',
        )?.path ??
          view?.rules?.state.find((field) => typeof field.value === 'number')?.path ?? ['health']

        draft = combatDefinitionSchema.parse({
          'schema-version': '1.0.0',
          id,
          label: 'Training',
          player: {
            id: 'player',
            label: 'Player',
            health: { source: 'game.state', path: health },
            maximumHealth: 40,
            moves: ['attack', 'guard'],
          },
          enemies: [
            {
              id: 'opponent',
              label: 'Opponent',
              health: { source: 'game.state', path: ['enemyHealth'] },
              maximumHealth: 20,
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
    button.textContent = 'Save combat encounter'
    form.append(
      saveBar(document, button),
      ...combatForm(controls, view, draft, render),
      controls.group(
        'Combat view',
        controls.input('Combat component ID', current.id, (value) => {
          current.id = value.trim()
        }),
        controls.select(
          'Combat main text target',
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
          'Combat loot inventory',
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
        ...placementFields.map(([key, label]) =>
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
          scene: { id: sceneId, component: { ...component, encounter: draft.id } },
        })
    })
    fields.append(
      form,
      controls.button('Discard combat draft', reset),
      controls.button('Remove combat view', () =>
        submit({ type: 'scene.setCombat', sceneId, component: null }),
      ),
      controls.button('Delete encounter definition', () => {
        if (draft) submit({ type: 'game.removeCombat', encounterId: draft.id })
      }),
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
        ['game.upsertCombat', 'game.removeCombat', 'scene.setCombat'].includes(
          state.lastCommand ?? '',
        )

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        encounterId = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
