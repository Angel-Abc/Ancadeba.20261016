import { combatStatNames, levelingBindingFields } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  gameBindingSchema,
  ruleValueType,
  type StatusPanelComponentDefinition,
  type StatusValueDefinition,
} from '@ancadeba/schemas'
import {
  displayLabel,
  placementFields,
  type RuleFormControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'
import { bindingFieldLabel, combatOwnerLabel } from './textBindingChoices.js'

function reorder<T>(entries: T[], index: number, delta: number): void {
  const target = index + delta

  if (target < 0 || target >= entries.length) return
  const [entry] = entries.splice(index, 1)
  entries.splice(target, 0, entry!)
}

export function statusPanelForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: StatusPanelComponentDefinition,
  rerender: () => void,
  existing: boolean,
): HTMLElement[] {
  const { input, select, button, group, translation, t } = controls
  const keys = translationChoices(view, t('metadata.literalText'))

  const visuals = [
    ...new Set([
      ...Object.keys(view.assets?.images ?? {}),
      ...Object.keys(view.assets?.parts ?? {}),
      ...Object.keys(view.assets?.compositions ?? {}),
    ]),
  ]

  const edit = (action: () => void) => {
    action()
    controls.markEdited()
    rerender()
  }

  const bindings = (expected: 'number' | 'value' | 'boolean') => [
    ...Object.entries(view.inventory?.owners ?? {})
      .filter(([, owner]) => owner.combatStats)
      .flatMap(([id]) =>
        (expected === 'boolean' ? ['available', 'locked'] : [...combatStatNames, 'health']).map(
          (stat) =>
            [
              JSON.stringify({ source: 'game.combatStats', path: [id, stat] }),
              t('bindings.combatStat', {
                owner: combatOwnerLabel(view, id),
                field: bindingFieldLabel(stat, t),
              }),
            ] as const,
        ),
      ),
    ...Object.entries(view.leveling ?? {}).flatMap(([id, profile]) =>
      Object.entries(levelingBindingFields)
        .filter(([, type]) => (expected === 'value' ? type !== 'boolean' : type === expected))
        .map(
          ([key]) =>
            [
              JSON.stringify({ source: 'game.leveling', path: [id, key] }),
              t('bindings.character', {
                profile: displayLabel(view, id, profile),
                field: bindingFieldLabel(key, t),
              }),
            ] as const,
        ),
    ),
    ...(view.rules?.state ?? [])
      .filter((field) =>
        expected === 'value'
          ? ruleValueType(field.value) !== 'boolean'
          : ruleValueType(field.value) === expected,
      )
      .map(
        (field) =>
          [
            JSON.stringify({ source: 'game.state', path: field.path }),
            statePath(field.path),
          ] as const,
      ),
    ...(expected === 'boolean'
      ? []
      : (
          [
            ['turn', t('status.turn')],
            ['worldTimeMs', t('status.worldTime')],
          ] as const
        ).map(
          ([key, name]) =>
            [
              JSON.stringify({ source: 'game.progression', path: [key] }),
              t('bindings.gameTime', { name }),
            ] as const,
        )),
  ]

  const source = (
    title: string,
    current: StatusValueDefinition,
    numeric: boolean,
    update: (value: StatusValueDefinition) => void,
  ): HTMLElement[] => {
    const value = typeof current === 'object' ? JSON.stringify(current) : ''

    const result = [
      select(
        t('status.sourceOf', { title }),
        value,
        [['', t('form.constant')], ...bindings(numeric ? 'number' : 'value')],
        (next) =>
          edit(() => update(next ? gameBindingSchema.parse(JSON.parse(next)) : numeric ? 0 : '')),
      ),
    ]

    if (typeof current !== 'object') {
      if (!numeric)
        result.push(
          select(
            t('status.constantType', { title }),
            typeof current === 'number' ? 'number' : 'text',
            ['text', 'number'],
            (next) => edit(() => update(next === 'number' ? 0 : '')),
          ),
        )
      result.push(
        input(
          title,
          String(current),
          (next) =>
            update(
              numeric || typeof current === 'number' ? (next === '' ? NaN : Number(next)) : next,
            ),
          numeric || typeof current === 'number' ? 'number' : 'text',
        ),
      )
    }

    return result
  }

  const nextId = (prefix: string, entries: { id: string }[]) => {
    let number = 1

    while (entries.some((entry) => entry.id === `${prefix}-${number}`)) number++

    return `${prefix}-${number}`
  }

  const identity = group(
    t('status.panel'),
    ...(existing
      ? []
      : [
          input(t('status.componentId'), draft.id, (value) => {
            draft.id = value.trim()
          }),
        ]),
    input(t('status.title'), draft.label, (value) => {
      draft.label = value
    }),
    translation(t('status.titleTranslation'), draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    input(t('status.characterName'), draft.name, (value) => {
      draft.name = value
    }),
    translation(t('status.characterNameTranslation'), draft.nameKey ?? '', keys, (value) => {
      draft.nameKey = value || undefined
    }),
    select(
      t('form.portrait'),
      draft.portrait ?? '',
      [['', t('form.none')], ...visuals],
      (value) => {
        draft.portrait = value || undefined
      },
    ),
  )

  const rows = draft.rows.map((row, index) => {
    const title = t('status.row', { number: index + 1 })

    return group(
      title,
      input(t('status.idOf', { title }), row.id, (value) => {
        row.id = value.trim()
      }),
      input(t('status.labelOf', { title }), row.label, (value) => {
        row.label = value
      }),
      translation(t('status.translationOf', { title }), row.labelKey ?? '', keys, (value) => {
        row.labelKey = value || undefined
      }),
      ...source(t('status.valueOf', { title }), row.value, row.type === 'bar', (value) => {
        if (row.type === 'value' || typeof value !== 'string') row.value = value
      }),
      ...(row.type === 'bar'
        ? [
            ...source(t('status.maximumOf', { title }), row.maximum, true, (value) => {
              if (typeof value !== 'string') row.maximum = value
            }),
            input(t('status.colorOf', { title }), row.color ?? '', (value) => {
              row.color = value || undefined
            }),
          ]
        : []),
      button(
        t('status.moveRowUp', { number: index + 1 }),
        () => edit(() => reorder(draft.rows, index, -1)),
        index === 0,
      ),
      button(
        t('status.moveRowDown', { number: index + 1 }),
        () => edit(() => reorder(draft.rows, index, 1)),
        index === draft.rows.length - 1,
      ),
      button(t('status.removeRow', { number: index + 1 }), () =>
        edit(() => {
          draft.rows.splice(index, 1)
        }),
      ),
    )
  })

  const effects = draft.effects.map((effect, index) => {
    const title = t('form.effectNumber', { number: index + 1 })

    return group(
      title,
      input(`${title} ID`, effect.id, (value) => {
        effect.id = value.trim()
      }),
      input(t('status.labelOf', { title }), effect.label, (value) => {
        effect.label = value
      }),
      translation(t('status.translationOf', { title }), effect.labelKey ?? '', keys, (value) => {
        effect.labelKey = value || undefined
      }),
      input(t('status.descriptionOf', { title }), effect.description, (value) => {
        effect.description = value
      }),
      translation(
        t('status.descriptionTranslationOf', { title }),
        effect.descriptionKey ?? '',
        keys,
        (value) => {
          effect.descriptionKey = value || undefined
        },
      ),
      select(
        t('status.iconOf', { title }),
        effect.icon ?? '',
        [['', t('form.none')], ...visuals],
        (value) => {
          effect.icon = value || undefined
        },
      ),
      select(
        t('status.visibilityOf', { title }),
        effect.visibleWhen ? JSON.stringify(effect.visibleWhen) : '',
        [['', t('status.alwaysVisible')], ...bindings('boolean')],
        (value) => {
          effect.visibleWhen = value ? gameBindingSchema.parse(JSON.parse(value)) : undefined
        },
      ),
      button(
        t('status.moveEffectUp', { number: index + 1 }),
        () => edit(() => reorder(draft.effects, index, -1)),
        index === 0,
      ),
      button(
        t('status.moveEffectDown', { number: index + 1 }),
        () => edit(() => reorder(draft.effects, index, 1)),
        index === draft.effects.length - 1,
      ),
      button(t('status.removeEffect', { number: index + 1 }), () =>
        edit(() => {
          draft.effects.splice(index, 1)
        }),
      ),
    )
  })

  return [
    identity,
    group(
      t('status.rows'),
      ...rows,
      button(t('status.addValue'), () =>
        edit(() => {
          draft.rows.push({
            id: nextId('value', draft.rows),
            type: 'value',
            label: 'Value',
            value: '',
          })
        }),
      ),
      button(t('status.addBar'), () =>
        edit(() => {
          draft.rows.push({
            id: nextId('bar', draft.rows),
            type: 'bar',
            label: 'Resource',
            value: 0,
            maximum: 100,
          })
        }),
      ),
    ),
    group(
      t('status.effects'),
      ...effects,
      button(t('status.addEffect'), () =>
        edit(() => {
          draft.effects.push({
            id: nextId('effect', draft.effects),
            label: 'Effect',
            description: '',
          })
        }),
      ),
    ),
    group(
      t('status.placement'),
      ...placementFields(t).map(([key, label]) =>
        input(
          t('status.placementField', { field: label.toLowerCase() }),
          String(draft.placement[key]),
          (value) => {
            draft.placement[key] = Number(value)
          },
          'number',
        ),
      ),
    ),
  ]
}
