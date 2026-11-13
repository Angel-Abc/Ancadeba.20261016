import { combatScalingStats, type CombatScaling } from '@ancadeba/schemas'
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
                  ['health', text('health')],
                  ['missing-health', text('missingHealth')],
                  ['stat', text('stat')],
                  ['round', text('round')],
                ],
                (type) => {
                  scaling.terms[index] =
                    type === 'resource'
                      ? { type, resource: resources[0] ?? 'resource', factor: term.factor }
                      : type === 'round'
                        ? { type, factor: term.factor }
                        : type === 'stat'
                          ? { type, actor: 'self', stat: 'attack', factor: term.factor }
                          : type === 'health' || type === 'missing-health'
                            ? { type, actor: 'self', measure: 'value', factor: term.factor }
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
                : term.type === 'round'
                  ? []
                  : [
                      input(text('actor'), term.actor, (value) => {
                        term.actor = value.trim()
                      }),
                      ...(term.type === 'status'
                        ? [
                            select(t('form.status'), term.status, statuses, (value) => {
                              term.status = value
                            }),
                          ]
                        : []),
                      ...(term.type === 'stat'
                        ? [
                            select(text('stat'), term.stat, combatScalingStats, (value) => {
                              term.stat = value
                            }),
                          ]
                        : [
                            select(
                              text('measure'),
                              term.measure ?? (term.type === 'status' ? 'intensity' : 'value'),
                              term.type === 'status'
                                ? ['stacks', 'intensity', 'remaining']
                                : ['value', 'percent'],
                              (value) => {
                                if (
                                  term.type === 'status' &&
                                  ['stacks', 'intensity', 'remaining'].includes(value)
                                )
                                  term.measure =
                                    value === 'stacks'
                                      ? 'stacks'
                                      : value === 'remaining'
                                        ? 'remaining'
                                        : 'intensity'
                                else if (
                                  term.type !== 'status' &&
                                  (value === 'value' || value === 'percent')
                                )
                                  term.measure = value
                              },
                            ),
                          ]),
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
