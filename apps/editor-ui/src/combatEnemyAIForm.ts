import type {
  CombatActorDefinition,
  CombatEnemyCondition,
  CombatMechanicsDefinition,
} from '@ancadeba/schemas'
import { combatConditionsForm } from './combatConditionsForm.js'
import type { RuleFormControls } from './ruleFormControls.js'

/** Enemy-local priorities refer to the encounter's effective shared or inline mechanics. */
export function combatEnemyAIForm(
  controls: RuleFormControls,
  actor: Pick<CombatActorDefinition, 'id' | 'ai' | 'moves'>,
  actors: readonly Pick<CombatActorDefinition, 'id' | 'label'>[],
  mechanics: CombatMechanicsDefinition | undefined,
  statuses: readonly string[],
  render: () => void,
  options: { allowRemoval?: boolean; freeReferences?: boolean } = {},
): HTMLElement {
  const { group, input, select, button, t } = controls
  const text = (key: string) => t(`combat.ai.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const ai = actor.ai

  if (!ai)
    return group(
      text('heading'),
      button(
        text('enable'),
        edit(() => {
          actor.ai = { rules: [], fallback: 'rotation' }
        }),
      ),
    )

  const actorChoices = actors.map((actor) => [actor.id, actor.label || actor.id] as const)
  const resources = Object.keys(mechanics?.resources ?? {})
  const phases = Object.keys(mechanics?.phases ?? {})

  const conditionForm = (conditions: CombatEnemyCondition[]) =>
    combatConditionsForm(
      controls,
      conditions,
      {
        actors: actorChoices,
        resources,
        phases,
        statuses: [...statuses],
        defaultActor: actor.id,
        freeReferences: options.freeReferences,
      },
      render,
      'combat.ai',
      false,
    )

  const help = controls.create('p')
  help.textContent = text('help')

  return group(
    text('heading'),
    help,
    select(
      text('fallback'),
      ai.fallback,
      [
        ['rotation', text('rotation')],
        ['wait', text('wait')],
      ],
      (value) => {
        ai.fallback = value
      },
    ),
    ...ai.rules.map((rule, index) =>
      group(
        `${text('rule')} ${index + 1}`,
        input(text('ruleId'), rule.id, (value) => {
          rule.id = value.trim()
        }),
        select(text('move'), rule.move, actor.moves, (value) => {
          rule.move = value
        }),
        input(
          text('maxUses'),
          String(rule.maxUses),
          (value) => {
            rule.maxUses = Number(value)
          },
          'number',
        ),
        ...conditionForm(rule.conditions),
        button(
          text('addCondition'),
          edit(() => {
            rule.conditions.push({ type: 'health', actor: actor.id, operator: 'lte', value: 10 })
          }),
        ),
        button(
          text('moveUp'),
          edit(() => {
            if (index)
              [ai.rules[index - 1], ai.rules[index]] = [ai.rules[index]!, ai.rules[index - 1]!]
          }),
          index === 0,
        ),
        button(
          text('removeRule'),
          edit(() => {
            ai.rules.splice(index, 1)
          }),
        ),
      ),
    ),
    button(
      text('addRule'),
      edit(() => {
        let id = 'rule'
        let index = 1

        while (ai.rules.some((rule) => rule.id === id)) id = `rule-${index++}`
        ai.rules.push({ id, move: actor.moves[0] ?? 'move', maxUses: 1, conditions: [] })
      }),
    ),
    ...(options.allowRemoval === false
      ? []
      : [
          button(
            text('disable'),
            edit(() => {
              actor.ai = undefined
            }),
          ),
        ]),
  )
}
