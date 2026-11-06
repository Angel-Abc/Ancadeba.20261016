import type { RuleValue } from '@ancadeba/schemas'

export function ruleFormControls(document: Document, onEdit: () => void) {
  const create = <T extends keyof HTMLElementTagNameMap>(tag: T) => document.createElement(tag)

  const label = (title: string, control: HTMLElement) => {
    const wrapper = create('label')
    wrapper.append(title, control)

    return wrapper
  }

  const input = (title: string, value: string, update: (value: string) => void, type = 'text') => {
    const control = create('input')
    control.type = type

    if (type === 'number') control.step = 'any'
    control.value = value
    control.addEventListener('input', () => {
      update(control.value)
      onEdit()
    })

    return label(title, control)
  }

  const select = <T extends string>(
    title: string,
    value: T,
    choices: readonly (T | readonly [T, string])[],
    update: (value: T) => void,
    edit = true,
  ) => {
    const control = create('select')
    const options: (T | readonly [T, string])[] = [...choices]

    if (!options.some((choice) => (typeof choice === 'string' ? choice : choice[0]) === value))
      options.unshift([value, value || 'Choose…'])

    for (const choice of options) {
      const option = create('option')
      option.value = typeof choice === 'string' ? choice : choice[0]
      option.textContent = typeof choice === 'string' ? choice : choice[1]
      control.append(option)
    }

    control.value = value
    control.addEventListener('change', () => {
      const selected = options.find(
        (choice) => (typeof choice === 'string' ? choice : choice[0]) === control.value,
      )

      if (selected === undefined) return

      if (edit) onEdit()
      update(typeof selected === 'string' ? selected : selected[0])
    })

    return label(title, control)
  }

  const button = (title: string, action: () => void, disabled = false) => {
    const control = create('button')
    control.type = 'button'
    control.textContent = title
    control.disabled = disabled
    control.addEventListener('click', action)

    return control
  }

  const group = (title: string, ...children: (Node | string)[]) => {
    const box = create('fieldset')
    const heading = create('legend')
    heading.textContent = title
    box.append(heading, ...children)

    return box
  }

  return { create, input, select, button, group, markEdited: onEdit }
}

export type RuleFormControls = ReturnType<typeof ruleFormControls>

/** Grid placement fields in form order, with their field labels. */
export const placementFields = [
  ['row', 'Row'],
  ['column', 'Column'],
  ['rowSpan', 'Row span'],
  ['columnSpan', 'Column span'],
] as const

/** Turns a camelCase schema code such as `insufficientPlayerFunds` into a sentence-case label. */
export const humanizeCode = (code: string) => {
  const words = code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const statePath = (path: string[]) => path.join('.')
export const parseStatePath = (path: string) => path.trim().split('.')

export function ruleValueControls(
  controls: RuleFormControls,
  title: string,
  value: RuleValue,
  keys: string[],
  update: (value: RuleValue) => void,
  rerender: () => void,
  types = ['text', 'number', 'boolean', 'translation'],
): HTMLElement[] {
  const { input, select } = controls

  const type =
    typeof value === 'object' ? 'translation' : typeof value === 'string' ? 'text' : typeof value

  const field =
    type === 'translation'
      ? select(title, typeof value === 'object' ? value.textKey : '', keys, (textKey) =>
          update({ textKey }),
        )
      : type === 'boolean'
        ? select(
            title,
            String(typeof value === 'boolean' && value),
            [
              ['true', 'True'],
              ['false', 'False'],
            ],
            (next) => update(next === 'true'),
          )
        : input(
            title,
            typeof value === 'object' || Number.isNaN(value) ? '' : String(value),
            (next) => update(type === 'number' ? (next === '' ? NaN : Number(next)) : next),
            type === 'number' ? 'number' : 'text',
          )

  const chooseType = select('Value type', type, types, (next) => {
    if (next === 'translation') update({ textKey: keys[0] ?? '' })
    else if (next === 'boolean') update(false)
    else if (next === 'number') update(0)
    else update('')
    rerender()
  })

  return types.length > 1 ? [chooseType, field] : [field]
}
