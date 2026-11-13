import type { CombatScaling } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatScalingForm(
  controls: RuleFormControls,
  title: string,
  scaling: CombatScaling | undefined,
  change: (value: CombatScaling | undefined) => void,
  render: () => void,
  resources: readonly string[],
  statuses: readonly string[],
): HTMLElement {
  const { group, input, select, button, t } = controls
  const text = (key: string) => t(`combat.scaling.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const help = controls.create('p')
  help.textContent = text('help')

  return group(
    title,
    select(
      text('enabled'),
      String(Boolean(scaling)),
      [
        ['false', t('form.no')],
        ['true', t('form.yes')],
      ],
      (value) => {
        change(
          value === 'true'
            ? { terms: [{ type: 'resource', resource: resources[0] ?? 'resource', factor: 1 }] }
            : undefined,
        )
        render()
      },
    ),
    ...(scaling
      ? [
          help,
          select(
            text('mode'),
            scaling.mode ?? 'add',
            [
              ['add', text('add')],
              ['percent', text('percent')],
            ],
            (value) => {
              scaling.mode = value
            },
          ),
          select(
            text('rounding'),
            scaling.rounding ?? '',
            [
              ['', text('default')],
              ['floor', text('floor')],
              ['ceil', text('ceil')],
              ['nearest', text('nearest')],
            ],
            (value) => {
              scaling.rounding = value || undefined
            },
          ),
          ...(['minimum', 'maximum'] as const).map((key) =>
            input(
              text(key),
              scaling[key] === undefined ? '' : String(scaling[key]),
              (value) => {
                scaling[key] = value === '' ? undefined : Number(value)
              },
              'number',
            ),
          ),
          ...scaling.terms.map((term, index) =>
            group(
              t('combat.scaling.term', { number: index + 1 }),
              select(
                text('source'),
                term.type,
                [
                  ['resource', text('resource')],
                  ['status', text('status')],
                ],
                (type) => {
                  scaling.terms[index] =
                    type === 'resource'
                      ? { type, resource: resources[0] ?? 'resource', factor: term.factor }
                      : {
                          type,
                          actor: 'self',
                          status: statuses[0] ?? 'status',
                          measure: 'intensity',
                          factor: term.factor,
                        }
                  render()
                },
              ),
              ...(term.type === 'resource'
                ? [
                    input(text('resourceId'), term.resource, (value) => {
                      term.resource = value.trim()
                    }),
                    select(
                      text('measure'),
                      term.measure ?? 'value',
                      [
                        ['value', text('value')],
                        ['percent', text('resourcePercent')],
                      ],
                      (value) => {
                        term.measure = value
                      },
                    ),
                  ]
                : [
                    input(text('actor'), term.actor, (value) => {
                      term.actor = value.trim()
                    }),
                    select(t('form.status'), term.status, statuses, (value) => {
                      term.status = value
                    }),
                    select(
                      text('measure'),
                      term.measure ?? 'intensity',
                      ['stacks', 'intensity', 'remaining'],
                      (value) => {
                        term.measure = value
                      },
                    ),
                  ]),
              input(
                text('factor'),
                String(term.factor),
                (value) => {
                  term.factor = Number(value)
                },
                'number',
              ),
              button(
                text('remove'),
                edit(() => {
                  scaling.terms.splice(index, 1)
                }),
                scaling.terms.length === 1,
              ),
            ),
          ),
          button(
            text('addTerm'),
            edit(() => {
              scaling.terms.push({
                type: 'resource',
                resource: resources[0] ?? 'resource',
                factor: 1,
              })
            }),
            scaling.terms.length >= 20,
          ),
        ]
      : []),
  )
}
