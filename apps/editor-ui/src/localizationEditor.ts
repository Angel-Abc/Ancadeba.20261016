import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { languageTagSchema, translationKeySchema, type LanguageCatalog } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'

type LocalizationCommand = Extract<EditorCommand, { type: 'game.updateLocalization' }>

/** Languages and their source catalogs share a single draft and save transaction. */
export function bindLocalizationEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
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
  let dirty = false
  let busy = false
  let submitted: LocalizationCommand | undefined

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const keys = () => [...new Set(Object.values(catalogs).flatMap(Object.keys))].sort()

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
    submit.textContent = 'Save localization'
    submit.disabled = !languages.available.length
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent =
      'Add languages, then create translation keys and edit their text. Missing translations use the default language. Save to make keys available in other editors and restart the preview.'
    form.append(saveBar(document, submit, button('Discard localization draft', reset)), help)
    form.append(
      group(
        'Languages',
        input('New language tag', newLanguage, (value) => {
          newLanguage = value.trim()
        }),
        button('Add language', () => {
          if (
            !languageTagSchema.safeParse(newLanguage).success ||
            languages.available.some((tag) => tag.toLowerCase() === newLanguage.toLowerCase())
          ) {
            error.textContent = 'Enter a unique language tag, such as en, nl or en-US.'

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
              select('Default language', languages.default, languages.available, (value) =>
                change(() => makeDefault(value)),
              ),
            ]
          : []),
        ...languages.available.map((language) =>
          group(
            language === languages.default ? `${language} (default)` : language,
            button(
              `Remove language ${language}`,
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
        'Translation keys',
        input('New translation key', newKey, (value) => {
          newKey = value.trim()
        }),
        button(
          'Add translation key',
          () => {
            if (!translationKeySchema.safeParse(newKey).success || keys().includes(newKey)) {
              error.textContent =
                'Enter an unused key using letters, digits, underscores, hyphens and dot-separated segments.'

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
        select(
          'Translation key',
          selected,
          [['', 'Choose a key'], ...keys()],
          (value) => {
            selected = value
            render()
          },
          false,
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
              `Text source (${language})`,
              fallback ? 'default' : 'translated',
              [
                ['default', `Use ${languages.default} text`],
                ['translated', 'Translated text'],
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
        label.append(`Translation text (${language})`, text)
        parts.push(label)
        form.append(
          group(
            language === languages.default
              ? `${language} — default text`
              : `${language} — translation`,
            ...parts,
          ),
        )
      }

      form.append(
        button('Remove translation key', () =>
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
        error.textContent =
          'Add or clear the pending language tag or translation key before saving.'

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
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
