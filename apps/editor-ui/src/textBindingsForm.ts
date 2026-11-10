import {
  bindingAliasSchema,
  gameBindingSchema,
  textPlaceholders,
  type TextComponentDefinition,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { yesNoChoices, type RuleFormControls } from './ruleFormControls.js'
import { previewTextBindings, textBindingChoices, textBindingId } from './textBindingChoices.js'

export interface TextBindingPending {
  alias: string
  value: string
}

const sourceNames = {
  'game.state': 'bindings.source.state',
  'game.progression': 'bindings.source.time',
  'game.quests': 'bindings.source.quests',
  'game.leveling': 'leveling.heading',
  'game.combatStats': 'bindings.source.combat',
} as const

/** Text placeholders opt into binding explicitly; removing a row never silently makes them literal. */
export function textBindingsForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: TextComponentDefinition,
  pending: TextBindingPending,
  gameScene: boolean,
  rerender: () => void,
  append: (placeholder: string) => void,
) {
  const { group, create, input, select, button, t } = controls
  const root = group(t('bindings.dynamic'))
  const error = create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const preview = create('output')
  preview.className = 'text-binding-preview'
  preview.setAttribute('aria-label', t('bindings.previewLabel'))
  const diagnostics = create('p')
  diagnostics.className = 'help'
  diagnostics.setAttribute('aria-live', 'polite')
  const help = create('p')
  help.className = 'help'
  help.textContent = gameScene ? t('bindings.help') : t('bindings.staticOnly')
  const choices = textBindingChoices(view, t)

  const mode = select(
    t('bindings.mode'),
    draft.bindings === undefined ? 'static' : 'dynamic',
    [
      ['static', t('bindings.staticText')],
      ['dynamic', t('bindings.placeholders')],
    ],
    (value) => {
      draft.bindings = value === 'dynamic' ? {} : undefined
      pending.alias = ''
      pending.value = ''
      controls.markEdited()
      rerender()
    },
  )

  mode.querySelector('select')!.disabled = !gameScene
  root.append(help, mode, error)

  const change = (operation: () => void) => {
    operation()
    controls.markEdited()
    rerender()
  }

  const heading = create('strong')
  heading.textContent = t('bindings.preview')
  root.append(heading, preview, diagnostics)

  if (draft.bindings !== undefined && gameScene) {
    for (const [alias, binding] of Object.entries(draft.bindings)) {
      const selected = choices.some((choice) => choice.id === textBindingId(binding))
        ? textBindingId(binding)
        : 'custom'

      const box = group(
        t('bindings.binding', { alias }),
        select(
          t('bindings.boundValue'),
          selected,
          [
            ...choices.map((choice) => [choice.id, choice.label] as const),
            ['custom', t('bindings.customPath')],
          ],
          (value) =>
            change(() => {
              const choice = choices.find((choice) => choice.id === value)

              if (choice)
                draft.bindings = {
                  ...draft.bindings,
                  [alias]: {
                    ...structuredClone(choice.binding),
                    ...(binding.fallback !== undefined ? { fallback: binding.fallback } : {}),
                  },
                }
              else
                draft.bindings = {
                  ...draft.bindings,
                  [alias]: {
                    source: 'game.state',
                    path: [''],
                    ...(binding.fallback !== undefined ? { fallback: binding.fallback } : {}),
                  },
                }
            }),
        ),
      )

      if (selected === 'custom') {
        box.append(
          select(
            t('bindings.sourceLabel'),
            binding.source,
            gameBindingSchema.shape.source.options.map(
              (source) => [source, t(sourceNames[source])] as const,
            ),
            (value) => {
              binding.source = value
              refresh()
            },
          ),
        )
        binding.path.forEach((segment, index) =>
          box.append(
            group(
              t('bindings.pathSegment', { number: index + 1 }),
              select(
                t('bindings.segmentType'),
                typeof segment === 'number' ? 'index' : 'key',
                [
                  ['key', t('bindings.objectKey')],
                  ['index', t('bindings.arrayIndex')],
                ],
                (value) =>
                  change(() => {
                    binding.path[index] = value === 'index' ? 0 : ''
                  }),
              ),
              input(
                typeof segment === 'number' ? t('bindings.arrayIndex') : t('bindings.pathKey'),
                String(segment),
                (value) => {
                  binding.path[index] =
                    typeof segment === 'number' ? (value === '' ? NaN : Number(value)) : value
                  refresh()
                },
                typeof segment === 'number' ? 'number' : 'text',
              ),
              button(
                t('bindings.removeSegment', { number: index + 1 }),
                () =>
                  change(() => {
                    binding.path.splice(index, 1)
                  }),
                binding.path.length <= 1,
              ),
            ),
          ),
        )
        box.append(
          button(t('bindings.addSegment'), () =>
            change(() => {
              binding.path.push('')
            }),
          ),
        )
      }

      box.append(
        select(
          t('bindings.useFallback'),
          String(binding.fallback !== undefined),
          yesNoChoices(t),
          (value) =>
            change(() => {
              if (value === 'true') binding.fallback = ''
              else delete binding.fallback
            }),
        ),
        ...(binding.fallback !== undefined
          ? [
              input(t('bindings.fallbackText'), binding.fallback, (value) => {
                binding.fallback = value
                refresh()
              }),
            ]
          : []),
        button(
          t('bindings.append', { alias }),
          () => {
            append(`{{${alias}}}`)
            controls.markEdited()
            refresh()
          },
          Boolean(draft.textKey),
        ),
        button(t('bindings.removeBinding', { alias }), () =>
          change(() => {
            if (draft.bindings) Reflect.deleteProperty(draft.bindings, alias)
          }),
        ),
      )
      root.append(box)
    }

    const value = choices.some((choice) => choice.id === pending.value)
      ? pending.value
      : choices[0]!.id

    root.append(
      input(t('bindings.newName'), pending.alias, (value) => {
        pending.alias = value.trim()
      }),
      select(
        t('bindings.newValue'),
        value,
        choices.map((choice) => [choice.id, choice.label] as const),
        (value) => {
          pending.value = value
        },
        false,
      ),
      button(t('form.addTextBinding'), () => {
        if (
          !bindingAliasSchema.safeParse(pending.alias).success ||
          Object.hasOwn(draft.bindings ?? {}, pending.alias)
        ) {
          error.textContent = t('bindings.invalidName')

          return
        }

        const choice =
          choices.find((choice) => choice.id === pending.value) ??
          choices.find((choice) => choice.id === value)

        if (!choice) return
        change(() => {
          draft.bindings = { ...draft.bindings, [pending.alias]: structuredClone(choice.binding) }
          pending.alias = ''
          pending.value = ''
        })
      }),
    )
  }

  function refresh() {
    const resolution = previewTextBindings(view, draft)
    preview.textContent = resolution.text

    const effective = draft.textKey
      ? (view.translations?.[draft.textKey] ?? draft.text)
      : draft.text

    const placeholders = [
      ...new Set(
        [...textPlaceholders(draft.text), ...textPlaceholders(effective)].map(
          (value) => value.alias,
        ),
      ),
    ]

    const missing =
      draft.bindings !== undefined
        ? placeholders.filter(
            (alias) =>
              !Object.hasOwn(draft.bindings ?? {}, alias) ||
              !bindingAliasSchema.safeParse(alias).success,
          )
        : []

    diagnostics.textContent = [
      ...(missing.length ? [t('bindings.unbound', { names: missing.join(', ') })] : []),
      ...(resolution.diagnostics.some((diagnostic) => diagnostic.reason !== 'undeclared-binding')
        ? [t('bindings.playOnly')]
        : []),
      ...(draft.textKey ? [t('bindings.fromLocalization')] : []),
    ].join(' ')
  }

  refresh()

  return { element: root, refresh }
}
