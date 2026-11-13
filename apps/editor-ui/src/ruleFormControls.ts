import type { ProjectView } from '@ancadeba/editor-core'
import type { RuleValue } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'

/** A translation key with its default-language text; an empty key means "no translation". */
export type TranslationChoice = readonly [key: string, text: string]

/** Translation keys for pickers, optionally led by an empty choice with the given label. */
export function translationChoices(
  view: ProjectView,
  empty: string | false = '',
): TranslationChoice[] {
  return [
    ...(empty === false ? [] : [['', empty] as const]),
    ...(view.translationKeys ?? []).map((key) => [key, view.translations?.[key] ?? ''] as const),
  ]
}

/** A readable name for a definition: its literal label, else its translated text, else its ID. */
export function displayLabel(
  view: ProjectView,
  id: string,
  definition: { label?: string | undefined; labelKey?: string | undefined },
): string {
  const translated = definition.labelKey ? view.translations?.[definition.labelKey] : undefined

  return definition.label?.trim() || translated || id
}

let suggestionLists = 0

/** Remembers which folded sections an author opened, so re-rendering a form keeps them open. */
export interface FoldMemory {
  get(key: string): boolean | undefined
  set(key: string, open: boolean): void
}

export function foldMemory(): FoldMemory {
  const opened = new Map<string, boolean>()

  return {
    get: (key) => opened.get(key),
    set(key, open) {
      opened.set(key, open)
    },
  }
}

function foldControls(document: Document, folds: FoldMemory) {
  /** A disclosure for a long section; it stays as the author left it across re-renders. */
  const fold = (key: string, title: string, openByDefault: boolean, ...children: HTMLElement[]) => {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = title
    details.className = 'fold'
    details.open = folds.get(key) ?? openByDefault
    details.append(summary, ...children)
    details.addEventListener('toggle', () => folds.set(key, details.open))

    return details
  }

  /** Opens a fold before it is rendered, such as the entry an author has just added. */
  const unfold = (key: string) => folds.set(key, true)

  return { fold, unfold, folds }
}

export function ruleFormControls(
  document: Document,
  onEdit: () => void,
  t: Translate = editorLocalization().t,
  folds: FoldMemory = foldMemory(),
) {
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
      options.unshift([value, value || t('form.choose')])

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

      update(typeof selected === 'string' ? selected : selected[0])

      if (edit) onEdit()
    })

    return label(title, control)
  }

  /** A searchable key field that previews the default-language text of the chosen key. */
  const translation = (
    title: string,
    value: string,
    choices: readonly TranslationChoice[],
    update: (value: string) => void,
  ) => {
    const control = create('input')
    const preview = create('small')
    const texts = new Map(choices)
    const emptyLabel = texts.get('')
    const list = create('datalist')
    list.id = `translation-keys-${++suggestionLists}`

    for (const [key, text] of choices) {
      if (!key) continue
      const option = create('option')
      option.value = key
      option.label = text
      list.append(option)
    }

    control.value = value
    control.autocomplete = 'off'
    control.spellcheck = false
    control.placeholder = emptyLabel || t('form.searchKeys')
    control.setAttribute('list', list.id)
    preview.className = 'translation-preview'

    const show = () => {
      const known = texts.has(control.value)
      control.setAttribute('aria-invalid', String(!known))
      preview.textContent = known
        ? texts.get(control.value) || (control.value ? t('metadata.emptyTranslation') : '')
        : t('form.unknownKey')
    }

    control.addEventListener('input', () => {
      show()

      if (!texts.has(control.value)) return
      onEdit()
      update(control.value)
    })
    show()

    const wrapper = label(title, control)
    wrapper.append(list, preview)

    return wrapper
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

  return {
    create,
    input,
    select,
    translation,
    button,
    group,
    ...foldControls(document, folds),
    document,
    markEdited: onEdit,
    t,
  }
}

export type RuleFormControls = ReturnType<typeof ruleFormControls>

/** Controls that remember their folds separately, for a form that repeats inside one editor. */
export function scopedFolds(controls: RuleFormControls, scope: string): RuleFormControls {
  const folds: FoldMemory = {
    get: (key) => controls.folds.get(`${scope}/${key}`),
    set: (key, open) => controls.folds.set(`${scope}/${key}`, open),
  }

  return { ...controls, ...foldControls(controls.document, folds) }
}

/** Reports, once per change, that the editor language differs from the previous check. */
export function languageWatcher(t: Translate) {
  let sample = t('form.choose')

  return () => {
    const previous = sample
    sample = t('form.choose')

    return sample !== previous
  }
}

/** Groups a panel form's save action (and optional companions) into a bar that stays in view. */
export function saveBar(document: Document, ...actions: HTMLElement[]) {
  const bar = document.createElement('div')
  bar.className = 'save-bar'
  bar.append(...actions)

  return bar
}

/** Readable choices for pickers that store `true`/`false`. */
export const yesNoChoices = (t: Translate) =>
  [
    ['false', t('form.no')],
    ['true', t('form.yes')],
  ] as const

/** Readable choices for optional features stored as `enabled`/`disabled`. */
export const onOffChoices = (t: Translate) =>
  [
    ['disabled', t('form.off')],
    ['enabled', t('form.on')],
  ] as const

const valueTypeLabels = new Map<string, string>([
  ['text', 'form.literalText'],
  ['number', 'form.number'],
  ['boolean', 'form.yesOrNo'],
  ['translation', 'form.translationKey'],
])

const placementFieldLabels = [
  ['row', 'form.row'],
  ['column', 'form.column'],
  ['rowSpan', 'form.rowSpan'],
  ['columnSpan', 'form.columnSpan'],
] as const

/** Grid placement fields in form order, with their field labels. */
export const placementFields = (t: Translate) =>
  placementFieldLabels.map(([field, label]) => [field, t(label)] as const)

/** Turns a camelCase or kebab-case code such as `insufficientPlayerFunds` into a sentence-case label. */
export const humanizeCode = (code: string) => {
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const statePath = (path: string[]) => path.join('.')
export const parseStatePath = (path: string) => path.trim().split('.')

export function ruleValueControls(
  controls: RuleFormControls,
  title: string,
  value: RuleValue,
  keys: readonly TranslationChoice[],
  update: (value: RuleValue) => void,
  rerender: () => void,
  types = ['text', 'number', 'boolean', 'translation'],
): HTMLElement[] {
  const { input, select, translation, t } = controls

  const type =
    typeof value === 'object' ? 'translation' : typeof value === 'string' ? 'text' : typeof value

  const field =
    type === 'translation'
      ? translation(title, typeof value === 'object' ? value.textKey : '', keys, (textKey) =>
          update({ textKey }),
        )
      : type === 'boolean'
        ? select(
            title,
            String(typeof value === 'boolean' && value),
            [
              ['true', t('form.true')],
              ['false', t('form.false')],
            ],
            (next) => update(next === 'true'),
          )
        : input(
            title,
            typeof value === 'object' || Number.isNaN(value) ? '' : String(value),
            (next) => update(type === 'number' ? (next === '' ? NaN : Number(next)) : next),
            type === 'number' ? 'number' : 'text',
          )

  const typeChoices = types.map(
    (choice) =>
      [choice, valueTypeLabels.has(choice) ? t(valueTypeLabels.get(choice)!) : choice] as const,
  )

  const chooseType = select(t('form.valueType'), type, typeChoices, (next) => {
    if (next === 'translation') update({ textKey: keys.find(([key]) => key)?.[0] ?? '' })
    else if (next === 'boolean') update(false)
    else if (next === 'number') update(0)
    else update('')
    rerender()
  })

  return types.length > 1 ? [chooseType, field] : [field]
}
