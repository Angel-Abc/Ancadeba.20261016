import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { languageTagSchema, translationKeySchema, type LanguageCatalog } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar, languageWatcher } from './ruleFormControls.js'

type LocalizationCommand = Extract<EditorCommand, { type: 'game.updateLocalization' }>

/** Languages and their source catalogs share a single draft and save transaction. */
export function bindLocalizationEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let languages: LocalizationCommand['languages'] = { default: '', available: [] }
  let catalogs: Record<string, LanguageCatalog> = {}
  let selected = ''
  let newLanguage = 'en'
  let newKey = ''
  let keyFilter = ''
  let onlyMissing = false
  let dirty = false
  let busy = false
  let submitted: LocalizationCommand | undefined

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const keys = () => [...new Set(Object.values(catalogs).flatMap(Object.keys))].sort()

  /** Non-default languages that have no own text for a key and fall back to the default. */
  const missing = (key: string) =>
    languages.available.filter(
      (language) => language !== languages.default && !Object.hasOwn(catalogs[language] ?? {}, key),
    )

  const matches = (key: string) => {
    if (onlyMissing && !missing(key).length) return false
    const text = keyFilter.toLowerCase()

    return (
      !text ||
      key.toLowerCase().includes(text) ||
      Object.values(catalogs).some((catalog) => catalog[key]?.toLowerCase().includes(text))
    )
  }

  /** The key picker filters as you type without redrawing, so the search field keeps focus. */
  const keyPicker = () => {
    const label = document.createElement('label')
    const picker = document.createElement('select')
    const count = document.createElement('p')
    count.className = 'help'

    const fill = () => {
      const shown = keys().filter((key) => matches(key) || key === selected)

      const options = [
        ['', t('localization.chooseKey')] as const,
        ...shown.map((key) => {
          const absent = missing(key)

          return [
            key,
            absent.length
              ? t('localization.keyMissing', { key, languages: absent.join(', ') })
              : key,
          ] as const
        }),
      ]

      picker.replaceChildren(
        ...options.map(([value, text]) => {
          const option = document.createElement('option')
          option.value = value
          option.textContent = text

          return option
        }),
      )
      picker.value = selected
      const gaps = keys().filter((key) => missing(key).length).length

      const status = gaps
        ? t('localization.gaps', { count: gaps, language: languages.default })
        : t('localization.complete')

      count.textContent = t('localization.showing', {
        shown: keys().filter(matches).length,
        total: keys().length,
        status,
      })
    }

    const search = document.createElement('input')
    search.type = 'search'
    search.value = keyFilter
    search.placeholder = t('localization.keyOrText')
    search.addEventListener('input', () => {
      keyFilter = search.value.trim()
      fill()
    })
    const searchLabel = document.createElement('label')
    searchLabel.append(t('localization.find'), search)
    const scope = document.createElement('select')

    for (const [value, text] of [
      ['all', t('localization.allKeys')],
      ['missing', t('localization.missingKeys')],
    ] as const) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      scope.append(option)
    }

    scope.value = onlyMissing ? 'missing' : 'all'
    scope.addEventListener('change', () => {
      onlyMissing = scope.value === 'missing'
      fill()
    })
    const scopeLabel = document.createElement('label')
    scopeLabel.append(t('localization.show'), scope)
    picker.addEventListener('change', () => {
      selected = picker.value
      render()
    })
    label.append(t('form.translationKey'), picker)
    fill()

    return [searchLabel, scopeLabel, label, count]
  }

  const reset = () => {
    languages = structuredClone(view?.game?.languages ?? { default: '', available: [] })
    catalogs = structuredClone(view?.languageCatalogs ?? {})

    if (!keys().includes(selected)) selected = keys()[0] ?? ''
    newLanguage = languages.available.length ? '' : 'en'
    newKey = ''
    dirty = false
    error.textContent = ''
    render()
  }

  const change = (operation: () => void) => {
    operation()
    dirty = true
    error.textContent = ''
    render()
  }

  const makeDefault = (language: string) => {
    // Carry fallback entries into the new default so existing translation references remain valid.
    catalogs[language] = { ...catalogs[languages.default], ...catalogs[language] }
    languages.default = language
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const { input, select, button, group } = controls
    const form = document.createElement('form')
    form.className = 'localization-editor-form'
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = t('localization.save')
    submit.disabled = !languages.available.length
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = t('localization.help')
    form.append(saveBar(document, submit, button(t('localization.discard'), reset)), help)
    form.append(
      group(
        t('localization.languages'),
        input(t('localization.newTag'), newLanguage, (value) => {
          newLanguage = value.trim()
        }),
        button(t('localization.addLanguage'), () => {
          if (
            !languageTagSchema.safeParse(newLanguage).success ||
            languages.available.some((tag) => tag.toLowerCase() === newLanguage.toLowerCase())
          ) {
            error.textContent = t('localization.invalidTag')

            return
          }

          change(() => {
            languages.available.push(newLanguage)
            catalogs[newLanguage] = {}

            if (!languages.default) languages.default = newLanguage
            newLanguage = ''
          })
        }),
        ...(languages.available.length
          ? [
              select(
                t('localization.defaultLanguage'),
                languages.default,
                languages.available,
                (value) => change(() => makeDefault(value)),
              ),
            ]
          : []),
        ...languages.available.map((language) =>
          group(
            language === languages.default
              ? t('localization.languageDefault', { language })
              : language,
            button(
              t('localization.removeLanguage', { language }),
              () =>
                change(() => {
                  languages.available = languages.available.filter((tag) => tag !== language)

                  if (languages.default === language) makeDefault(languages.available[0]!)
                  delete catalogs[language]

                  if (!keys().includes(selected)) selected = keys()[0] ?? ''
                }),
              languages.available.length <= 1,
            ),
          ),
        ),
      ),
      group(
        t('localization.keys'),
        ...keyPicker(),
        input(t('localization.newKey'), newKey, (value) => {
          newKey = value.trim()
        }),
        button(
          t('localization.addKey'),
          () => {
            if (!translationKeySchema.safeParse(newKey).success || keys().includes(newKey)) {
              error.textContent = t('localization.invalidKey')

              return
            }

            change(() => {
              catalogs[languages.default] = { ...catalogs[languages.default], [newKey]: '' }
              selected = newKey
              newKey = ''
            })
          },
          !languages.available.length,
        ),
      ),
    )

    if (selected) {
      const inherited: HTMLTextAreaElement[] = []

      for (const language of languages.available) {
        const catalog = catalogs[language] ?? {}
        const fallback = language !== languages.default && !Object.hasOwn(catalog, selected)
        const parts: HTMLElement[] = []

        if (language !== languages.default)
          parts.push(
            select(
              t('localization.textSource', { language }),
              fallback ? 'default' : 'translated',
              [
                ['default', t('localization.useDefault', { language: languages.default })],
                ['translated', t('localization.translated')],
              ],
              (value) =>
                change(() => {
                  if (value === 'default') delete catalogs[language]![selected]
                  else
                    catalogs[language] = {
                      ...catalog,
                      [selected]: catalogs[languages.default]?.[selected] ?? '',
                    }
                }),
            ),
          )
        const label = document.createElement('label')
        const text = document.createElement('textarea')
        text.rows = 4
        text.disabled = fallback
        text.value = (fallback ? catalogs[languages.default]?.[selected] : catalog[selected]) ?? ''

        if (fallback) inherited.push(text)
        text.addEventListener('input', () => {
          catalogs[language] = { ...catalogs[language], [selected]: text.value }

          if (language === languages.default)
            for (const control of inherited) control.value = text.value
          dirty = true
        })
        label.append(t('localization.translationText', { language }), text)
        parts.push(label)
        form.append(
          group(
            language === languages.default
              ? t('localization.defaultText', { language })
              : t('localization.languageTranslation', { language }),
            ...parts,
          ),
        )
      }

      form.append(
        button(t('localization.removeKey'), () =>
          change(() => {
            for (const catalog of Object.values(catalogs)) delete catalog[selected]
            selected = keys()[0] ?? ''
          }),
        ),
      )
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (busy) return

      if (newLanguage || newKey) {
        error.textContent = t('localization.pendingSave')

        return
      }

      const command = commandSchema.safeParse({
        type: 'game.updateLocalization',
        languages,
        catalogs,
      })

      if (!command.success) {
        error.textContent = command.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')

        return
      }

      if (command.data.type !== 'game.updateLocalization') return
      submitted = structuredClone(command.data)
      error.textContent = ''
      save(command.data)
    })
    fields.append(form)
    fields.disabled = busy || Boolean(view.diagnostics.length)
  }

  return {
    hasDrafts: () => dirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && replaceFields && !busy && !state.error && state.lastCommand === submitted.type

      if (!busy) submitted = undefined

      if (projectChanged) selected = ''

      if (
        projectChanged ||
        saved ||
        (replaceFields && !state.preserveDrafts) ||
        (changed && !dirty)
      )
        reset()
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
