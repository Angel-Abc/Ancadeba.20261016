import { getMapMovementCostMs } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import type { RuleFormControls } from './ruleFormControls.js'
import type { MapDraft } from './mapDraft.js'

export interface MapEntryTriggerEditorState {
  selected: number
}

export function mapEntryTriggerEditor(
  draft: MapDraft,
  actions: readonly string[],
  controls: RuleFormControls,
  t: Translate,
  change: (operation: () => void) => void,
  state: MapEntryTriggerEditorState,
  repaint: () => void,
) {
  const map = draft.data
  const element = controls.group(t('maps.entryTriggers'))
  const help = controls.create('p')
  help.className = 'help'
  help.textContent = t('maps.entryHelp')
  element.append(help)
  const triggers = map.entryTriggers ?? []
  const rows: HTMLElement[] = []

  const highlight = () => {
    rows.forEach((row, index) =>
      row.classList.toggle('map-entry-trigger-selected', index === state.selected),
    )
    repaint()
  }

  for (const [index, trigger] of triggers.entries()) {
    const row = controls.group(
      trigger.id,
      controls.input(t('maps.entryId'), trigger.id, (value) => {
        trigger.id = value.trim()
        highlight()
      }),
      controls.input(
        t('maps.entryX'),
        String(trigger.x),
        (value) => {
          trigger.x = Number(value)
          highlight()
        },
        'number',
      ),
      controls.input(
        t('maps.entryY'),
        String(trigger.y),
        (value) => {
          trigger.y = Number(value)
          highlight()
        },
        'number',
      ),
      controls.select(t('maps.entryAction'), trigger.action, actions, (value) => {
        trigger.action = value
        highlight()
      }),
      controls.button(t('maps.removeEntryTrigger'), () =>
        change(() => {
          map.entryTriggers = triggers.filter((entry) => entry !== trigger)
          state.selected = -1
        }),
      ),
    )

    rows.push(row)
    row.classList.add('map-entry-trigger-row')
    row.classList.toggle('map-entry-trigger-selected', state.selected === index)

    for (const field of [...row.querySelectorAll('input'), ...row.querySelectorAll('select')])
      field.addEventListener('focus', () => {
        state.selected = index
        highlight()
      })

    for (const input of row.querySelectorAll('input')) {
      if (input.type !== 'number') continue
      input.min = '0'
      input.step = '1'
    }

    element.append(row)
  }

  const availableTile = () => {
    const occupied = new Set(triggers.map(({ x, y }) => `${x},${y}`))

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (getMapMovementCostMs(map, { x, y }) !== undefined && !occupied.has(`${x},${y}`))
          return { x, y }
      }
    }

    return undefined
  }

  element.append(
    controls.button(
      t('maps.addEntryTrigger'),
      () =>
        change(() => {
          const available = availableTile()

          if (!available || !actions[0]) return
          state.selected = draft.addEntryTrigger(available, actions[0])
        }),
      !availableTile() || actions.length === 0,
    ),
  )

  if (!actions.length) {
    const hint = controls.create('p')
    hint.className = 'help'
    hint.textContent = t('maps.entryRuleFirst')
    element.append(hint)
  }

  return {
    element,
    focusSelected: () => rows[state.selected]?.querySelector<HTMLInputElement>('input')?.focus(),
  }
}
