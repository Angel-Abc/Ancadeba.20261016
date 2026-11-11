import type { Translate } from '@ancadeba/utilities'
import type { MapDraft } from './mapDraft.js'
import type { RuleFormControls } from './ruleFormControls.js'
import type { GameRulesDefinition } from '@ancadeba/schemas'
import { mapObjectStatesEditor } from './mapObjectStatesEditor.js'

export interface MapObjectEditorState {
  selected: number
}

export function mapObjectEditor(
  draft: MapDraft,
  actions: string[],
  controls: RuleFormControls,
  t: Translate,
  change: (operation: () => void) => void,
  state: MapObjectEditorState,
  repaint: () => void,
  spawns: ReadonlySet<string>,
  fields: GameRulesDefinition['state'],
) {
  const element = controls.group(t('maps.objects'))
  const help = controls.create('p')
  help.className = 'help'
  help.textContent = t('maps.objectHelp')
  element.append(help)
  const rows: HTMLElement[] = []

  const highlight = () => {
    rows.forEach((row, index) =>
      row.classList.toggle('map-entry-trigger-selected', state.selected === index),
    )
    repaint()
  }

  const objects = draft.data.objects ?? []

  for (const [index, object] of objects.entries()) {
    const row = controls.group(
      object.id,
      controls.input(t('maps.objectId'), object.id, (value) => {
        object.id = value.trim()
        highlight()
      }),
      controls.input(t('maps.objectLabel'), object.label, (value) => {
        object.label = value
        highlight()
      }),
      ...(['x', 'y'] as const).map((key) =>
        controls.input(
          t(key === 'x' ? 'maps.objectX' : 'maps.objectY'),
          String(object[key]),
          (value) => {
            object[key] = Number(value)
            highlight()
          },
          'number',
        ),
      ),
      controls.select(
        t('maps.objectAppearance'),
        object.terrain,
        Object.keys(draft.data.terrain),
        (value) => {
          object.terrain = value
          highlight()
        },
      ),
      controls.select(t('maps.objectAction'), object.action, actions, (value) => {
        object.action = value
        highlight()
      }),
      controls.select(
        t('maps.objectBlocking'),
        object.blocking === false ? 'no' : 'yes',
        [
          ['yes', t('maps.yes')],
          ['no', t('maps.no')],
        ],
        (value) => {
          object.blocking = value === 'yes'
          highlight()
        },
      ),
      controls.select(
        t('maps.objectVisible'),
        object.visible === false ? 'no' : 'yes',
        [
          ['yes', t('maps.yes')],
          ['no', t('maps.no')],
        ],
        (value) => {
          object.visible = value === 'yes'
          highlight()
        },
      ),
      controls.button(t('maps.removeObject'), () =>
        change(() => {
          draft.data.objects = objects.filter((entry) => entry !== object)
          state.selected = -1
        }),
      ),
      mapObjectStatesEditor(
        object,
        Object.keys(draft.data.terrain),
        fields,
        controls,
        change,
        highlight,
      ),
    )

    rows.push(row)
    row.classList.add('map-entry-trigger-row')
    row.classList.toggle('map-entry-trigger-selected', index === state.selected)

    for (const field of [...row.querySelectorAll('input'), ...row.querySelectorAll('select')])
      field.addEventListener('focus', () => {
        state.selected = index
        highlight()
      })

    for (const field of row.querySelectorAll('input'))
      if (field.type === 'number') {
        field.min = '0'
        field.step = '1'
      }

    element.append(row)
  }

  const available = () => {
    for (let y = 0; y < draft.data.height; y++)
      for (let x = 0; x < draft.data.width; x++)
        if (
          !spawns.has(`${x},${y}`) &&
          !objects.some((entry) => entry.x === x && entry.y === y) &&
          draft.data.terrain[draft.data.tiles[y]![x]!]!.walkable !== false
        )
          return { x, y }

    return undefined
  }

  element.append(
    controls.button(
      t('maps.addObject'),
      () =>
        change(() => {
          const point = available()
          const terrain = Object.keys(draft.data.terrain)[0]

          if (point && actions[0] && terrain)
            state.selected = draft.addObject(
              point,
              actions[0],
              terrain,
              t('maps.objectDefaultLabel'),
            )
        }),
      !actions.length || !available(),
    ),
  )

  if (!actions.length) element.append(t('maps.entryRuleFirst'))

  return {
    element,
    focusSelected: () => rows[state.selected]?.querySelector<HTMLInputElement>('input')?.focus(),
  }
}
