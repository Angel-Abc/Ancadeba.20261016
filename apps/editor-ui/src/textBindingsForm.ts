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
  'game.state': 'Game state',
  'game.progression': 'Game time',
  'game.quests': 'Quest progress',
  'game.leveling': 'Character levels',
  'game.combatStats': 'Combat stats',
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
  const { group, create, input, select, button } = controls
  const root = group('Dynamic text bindings')
  const error = create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const preview = create('output')
  preview.className = 'text-binding-preview'
  preview.setAttribute('aria-label', 'Starting-value text preview')
  const diagnostics = create('p')
  diagnostics.className = 'help'
  diagnostics.setAttribute('aria-live', 'polite')
  const help = create('p')
  help.className = 'help'
  help.textContent = gameScene
    ? 'Write {{name}} in text or a translation, then bind that name to a value. Gold is a numeric state field declared in Rules. Quest counters use their objective state fields. This preview uses authored starting values before actions run; other derived values are available during play.'
    : 'Dynamic text bindings require a game scene. Text in this scene stays static.'
  const choices = textBindingChoices(view)

  const mode = select(
    'Text binding mode',
    draft.bindings === undefined ? 'static' : 'dynamic',
    [
      ['static', 'Static text'],
      ['dynamic', 'Dynamic placeholders'],
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
  heading.textContent = 'Starting-value preview'
  root.append(heading, preview, diagnostics)

  if (draft.bindings !== undefined && gameScene) {
    for (const [alias, binding] of Object.entries(draft.bindings)) {
      const selected = choices.some((choice) => choice.id === textBindingId(binding))
        ? textBindingId(binding)
        : 'custom'

      const box = group(
        `Binding ${alias}`,
        select(
          'Bound value',
          selected,
          [
            ...choices.map((choice) => [choice.id, choice.label] as const),
            ['custom', 'Custom path'],
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
            'Binding source',
            binding.source,
            gameBindingSchema.shape.source.options.map(
              (source) => [source, sourceNames[source]] as const,
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
              `Path segment ${index + 1}`,
              select(
                'Path segment type',
                typeof segment === 'number' ? 'index' : 'key',
                [
                  ['key', 'Object key / Map key'],
                  ['index', 'Array index'],
                ],
                (value) =>
                  change(() => {
                    binding.path[index] = value === 'index' ? 0 : ''
                  }),
              ),
              input(
                typeof segment === 'number' ? 'Array index' : 'Path key',
                String(segment),
                (value) => {
                  binding.path[index] =
                    typeof segment === 'number' ? (value === '' ? NaN : Number(value)) : value
                  refresh()
                },
                typeof segment === 'number' ? 'number' : 'text',
              ),
              button(
                `Remove path segment ${index + 1}`,
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
          button('Add path segment', () =>
            change(() => {
              binding.path.push('')
            }),
          ),
        )
      }

      box.append(
        select('Use fallback text', String(binding.fallback !== undefined), yesNoChoices, (value) =>
          change(() => {
            if (value === 'true') binding.fallback = ''
            else delete binding.fallback
          }),
        ),
        ...(binding.fallback !== undefined
          ? [
              input('Fallback text', binding.fallback, (value) => {
                binding.fallback = value
                refresh()
              }),
            ]
          : []),
        button(
          `Append {{${alias}}}`,
          () => {
            append(`{{${alias}}}`)
            controls.markEdited()
            refresh()
          },
          Boolean(draft.textKey),
        ),
        button(`Remove binding ${alias}`, () =>
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
      input('New binding name', pending.alias, (value) => {
        pending.alias = value.trim()
      }),
      select(
        'New binding value',
        value,
        choices.map((choice) => [choice.id, choice.label] as const),
        (value) => {
          pending.value = value
        },
        false,
      ),
      button('Add text binding', () => {
        if (
          !bindingAliasSchema.safeParse(pending.alias).success ||
          Object.hasOwn(draft.bindings ?? {}, pending.alias)
        ) {
          error.textContent =
            'Enter an unused binding name using letters, digits, underscores or hyphens.'

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
      ...(missing.length ? [`Unbound placeholders: ${missing.join(', ')}.`] : []),
      ...(resolution.diagnostics.some((diagnostic) => diagnostic.reason !== 'undeclared-binding')
        ? ['Some values are available only during play; fallback text is shown when provided.']
        : []),
      ...(draft.textKey
        ? [
            'This template comes from Localization. Edit its placeholders there; every language uses these binding names.',
          ]
        : []),
    ].join(' ')
  }

  refresh()

  return { element: root, refresh }
}
