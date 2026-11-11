import type { GameRulesDefinition, MapObject } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function mapObjectStatesEditor(
  object: MapObject,
  terrain: string[],
  fields: GameRulesDefinition['state'],
  controls: RuleFormControls,
  change: (operation: () => void) => void,
  edited: () => void,
) {
  const { t, group, input, select, button, create } = controls
  const element = group(t('maps.objectStates'))
  const help = create('p')
  help.className = 'help'
  help.textContent = t('maps.objectStatesHelp')
  element.append(help)
  const flags = fields.filter(({ value }) => typeof value === 'boolean')
  const states = object.states ?? []

  for (const [index, state] of states.entries()) {
    element.append(
      group(
        state.id,
        input(t('maps.objectStateId'), state.id, (value) => {
          state.id = value.trim()
          edited()
        }),
        select(
          t('maps.objectStateFlag'),
          JSON.stringify(state.when.path),
          flags.map(({ path }) => [JSON.stringify(path), path.join('.')] as const),
          (value) => {
            state.when.path = JSON.parse(value)
            edited()
          },
        ),
        select(
          t('maps.objectStateValue'),
          String(state.when.value),
          [
            ['true', t('maps.yes')],
            ['false', t('maps.no')],
          ],
          (value) => {
            state.when.value = value === 'true'
            edited()
          },
        ),
        select(
          t('maps.objectStateAppearance'),
          state.terrain ?? '',
          [['', t('maps.inheritObject')], ...terrain],
          (value) => {
            if (value) state.terrain = value
            else delete state.terrain
            edited()
          },
        ),
        input(t('maps.objectStateLabel'), state.label ?? '', (value) => {
          if (value.trim()) state.label = value
          else delete state.label
          edited()
        }),
        select(
          t('maps.objectStateBlocking'),
          state.blocking === undefined ? '' : String(state.blocking),
          [
            ['', t('maps.inheritObject')],
            ['true', t('maps.yes')],
            ['false', t('maps.no')],
          ],
          (value) => {
            if (value) state.blocking = value === 'true'
            else delete state.blocking
            edited()
          },
        ),
        select(
          t('maps.objectStateVisible'),
          state.visible === undefined ? '' : String(state.visible),
          [
            ['', t('maps.inheritObject')],
            ['true', t('maps.yes')],
            ['false', t('maps.no')],
          ],
          (value) => {
            if (value) state.visible = value === 'true'
            else delete state.visible
            edited()
          },
        ),
        button(
          t('maps.objectStateUp'),
          () =>
            change(() => {
              states.splice(index - 1, 0, states.splice(index, 1)[0]!)
            }),
          index === 0,
        ),
        button(
          t('maps.objectStateDown'),
          () =>
            change(() => {
              states.splice(index + 1, 0, states.splice(index, 1)[0]!)
            }),
          index === states.length - 1,
        ),
        button(t('maps.removeObjectState'), () =>
          change(() => {
            object.states = states.filter((entry) => entry !== state)
          }),
        ),
      ),
    )
  }

  element.append(
    button(
      t('maps.addObjectState'),
      () =>
        change(() => {
          if (!flags[0]) return
          let id = 'state'
          let suffix = 2

          while (states.some((state) => state.id === id)) id = `state-${suffix++}`
          object.states = [
            ...states,
            { id, when: { path: [...flags[0].path], value: true }, terrain: object.terrain },
          ]
        }),
      !flags.length,
    ),
  )

  if (!flags.length) element.append(t('maps.objectFlagFirst'))

  return element
}
