import type { ProjectView } from '@ancadeba/editor-core'
import {
  gameBindingSchema,
  levelingBindingFields,
  type GameBindingDefinition,
} from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'
import { textBindingChoices, textBindingId } from './textBindingChoices.js'

type VisualBinding = Omit<GameBindingDefinition, 'fallback'>

const sources = {
  'game.state': 'Game state',
  'game.progression': 'Game time',
  'game.quests': 'Quest progress',
  'game.leveling': 'Character levels',
  'game.combatStats': 'Combat stats',
} as const

/** Binds a typed appearance property while its static value remains the fallback. */
export function graphicBindingForm(
  controls: RuleFormControls,
  view: ProjectView,
  title: string,
  binding: VisualBinding | undefined,
  expected: 'string' | 'boolean',
  update: (binding: VisualBinding | undefined) => void,
  change: (operation: () => void) => void,
  edited: () => void,
) {
  const { group, select, input, button } = controls

  const choices = textBindingChoices(view).filter((choice) => {
    if (choice.initial !== undefined) return typeof choice.initial === expected

    if (choice.binding.source === 'game.leveling')
      return Object.entries(levelingBindingFields).some(
        ([field, type]) => field === choice.binding.path[1] && type === expected,
      )

    return (
      expected === 'boolean' && ['available', 'locked'].includes(String(choice.binding.path[1]))
    )
  })

  const selected = binding
    ? choices.some((choice) => choice.id === textBindingId(binding))
      ? textBindingId(binding)
      : 'custom'
    : ''

  const box = group(
    `${title} binding`,
    select(
      'Bound value',
      selected,
      [
        ['', 'Use static value'],
        ...choices.map((choice) => [choice.id, choice.label] as const),
        ['custom', 'Custom path'],
      ],
      (value) =>
        change(() => {
          const choice = choices.find((choice) => choice.id === value)
          update(
            choice
              ? structuredClone(choice.binding)
              : value
                ? { source: 'game.state', path: [''] }
                : undefined,
          )
        }),
    ),
  )

  if (binding && selected === 'custom') {
    box.append(
      select(
        'Binding source',
        binding.source,
        gameBindingSchema.shape.source.options.map((source) => [source, sources[source]] as const),
        (value) => {
          binding.source = value
          edited()
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
              edited()
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

  return box
}
