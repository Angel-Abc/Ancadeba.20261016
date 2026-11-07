import { levelingBindingFields } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  gameBindingSchema,
  ruleValueType,
  type StatusPanelComponentDefinition,
  type StatusValueDefinition,
} from '@ancadeba/schemas'
import {
  placementFields,
  type RuleFormControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'

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
  const { input, select, button, group, translation } = controls
  const keys = translationChoices(view, 'Use literal text')

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
    ...Object.keys(view.leveling ?? {}).flatMap((id) =>
      Object.entries(levelingBindingFields)
        .filter(([, type]) => (expected === 'value' ? type !== 'boolean' : type === expected))
        .map(
          ([key]) =>
            [
              JSON.stringify({ source: 'game.leveling', path: [id, key] }),
              `Character · ${id} · ${key}`,
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
      : ['turn', 'worldTimeMs'].map(
          (key) =>
            [
              JSON.stringify({ source: 'game.progression', path: [key] }),
              `Progression · ${key}`,
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
        `${title} source`,
        value,
        [['', 'Constant'], ...bindings(numeric ? 'number' : 'value')],
        (next) =>
          edit(() => update(next ? gameBindingSchema.parse(JSON.parse(next)) : numeric ? 0 : '')),
      ),
    ]

    if (typeof current !== 'object') {
      if (!numeric)
        result.push(
          select(
            `${title} constant type`,
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
    'Panel',
    ...(existing
      ? []
      : [
          input('Status component ID', draft.id, (value) => {
            draft.id = value.trim()
          }),
        ]),
    input('Status panel title', draft.label, (value) => {
      draft.label = value
    }),
    translation('Status title translation', draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    input('Character name', draft.name, (value) => {
      draft.name = value
    }),
    translation('Character name translation', draft.nameKey ?? '', keys, (value) => {
      draft.nameKey = value || undefined
    }),
    select('Portrait', draft.portrait ?? '', [['', 'None'], ...visuals], (value) => {
      draft.portrait = value || undefined
    }),
  )

  const rows = draft.rows.map((row, index) => {
    const title = `Row ${index + 1}`

    return group(
      title,
      input(`${title} ID`, row.id, (value) => {
        row.id = value.trim()
      }),
      input(`${title} label`, row.label, (value) => {
        row.label = value
      }),
      translation(`${title} translation`, row.labelKey ?? '', keys, (value) => {
        row.labelKey = value || undefined
      }),
      ...source(`${title} value`, row.value, row.type === 'bar', (value) => {
        if (row.type === 'value' || typeof value !== 'string') row.value = value
      }),
      ...(row.type === 'bar'
        ? [
            ...source(`${title} maximum`, row.maximum, true, (value) => {
              if (typeof value !== 'string') row.maximum = value
            }),
            input(`${title} color`, row.color ?? '', (value) => {
              row.color = value || undefined
            }),
          ]
        : []),
      button(
        `Move row ${index + 1} up`,
        () => edit(() => reorder(draft.rows, index, -1)),
        index === 0,
      ),
      button(
        `Move row ${index + 1} down`,
        () => edit(() => reorder(draft.rows, index, 1)),
        index === draft.rows.length - 1,
      ),
      button(`Remove row ${index + 1}`, () =>
        edit(() => {
          draft.rows.splice(index, 1)
        }),
      ),
    )
  })

  const effects = draft.effects.map((effect, index) => {
    const title = `Effect ${index + 1}`

    return group(
      title,
      input(`${title} ID`, effect.id, (value) => {
        effect.id = value.trim()
      }),
      input(`${title} label`, effect.label, (value) => {
        effect.label = value
      }),
      translation(`${title} translation`, effect.labelKey ?? '', keys, (value) => {
        effect.labelKey = value || undefined
      }),
      input(`${title} description`, effect.description, (value) => {
        effect.description = value
      }),
      translation(
        `${title} description translation`,
        effect.descriptionKey ?? '',
        keys,
        (value) => {
          effect.descriptionKey = value || undefined
        },
      ),
      select(`${title} icon`, effect.icon ?? '', [['', 'None'], ...visuals], (value) => {
        effect.icon = value || undefined
      }),
      select(
        `${title} visibility`,
        effect.visibleWhen ? JSON.stringify(effect.visibleWhen) : '',
        [['', 'Always visible'], ...bindings('boolean')],
        (value) => {
          effect.visibleWhen = value ? gameBindingSchema.parse(JSON.parse(value)) : undefined
        },
      ),
      button(
        `Move effect ${index + 1} up`,
        () => edit(() => reorder(draft.effects, index, -1)),
        index === 0,
      ),
      button(
        `Move effect ${index + 1} down`,
        () => edit(() => reorder(draft.effects, index, 1)),
        index === draft.effects.length - 1,
      ),
      button(`Remove effect ${index + 1}`, () =>
        edit(() => {
          draft.effects.splice(index, 1)
        }),
      ),
    )
  })

  return [
    identity,
    group(
      'Values and resource bars',
      ...rows,
      button('Add value row', () =>
        edit(() => {
          draft.rows.push({
            id: nextId('value', draft.rows),
            type: 'value',
            label: 'Value',
            value: '',
          })
        }),
      ),
      button('Add resource bar', () =>
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
      'Status effects',
      ...effects,
      button('Add status effect', () =>
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
      'Status panel placement',
      ...placementFields.map(([key, label]) =>
        input(
          `Status ${label.toLowerCase()}`,
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
