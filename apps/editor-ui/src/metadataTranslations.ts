import type { ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'

/** Searchable metadata keys retain raw drafts while catalogs and editor language change. */
export function bindMetadataTranslations(
  root: HTMLElement,
  prefix: string,
  t: Translate,
  edited: () => void,
) {
  const find = <T extends HTMLElement>(id: string) => {
    const control = root.querySelector<T>(`#${prefix}-${id}`)

    if (!control) throw new Error(`Missing metadata translation control: ${prefix}-${id}`)

    return control
  }

  const title = find<HTMLInputElement>('title')
  const titleKey = find<HTMLInputElement>('title-key')
  const descriptionKey = find<HTMLInputElement>('description-key')
  const options = find<HTMLDataListElement>('metadata-keys')
  let view: ProjectView | undefined
  const abort = new AbortController()
  const key = (control: HTMLInputElement) => control.value.trim()

  const known = (control: HTMLInputElement) =>
    !key(control) || Boolean(view?.translationKeys?.includes(key(control)))

  const validTitle = () =>
    !key(titleKey) ||
    [
      view?.translations?.[key(titleKey)],
      ...Object.values(view?.languageCatalogs ?? {}).flatMap((catalog) =>
        Object.hasOwn(catalog, key(titleKey)) ? [catalog[key(titleKey)]] : [],
      ),
    ].every((value) => typeof value === 'string' && Boolean(value.trim()))

  const refresh = () => {
    for (const [name, control] of [
      ['title', titleKey],
      ['description', descriptionKey],
    ] as const) {
      control.setAttribute(
        'aria-invalid',
        String(!known(control) || (name === 'title' && !validTitle())),
      )
      find(`${name}-key-preview`).textContent = key(control)
        ? known(control)
          ? view?.translations?.[key(control)] || t('metadata.emptyTranslation')
          : t('metadata.unknownKey')
        : t('metadata.literalText')
    }

    title.required = !key(titleKey)
    title.placeholder = key(titleKey) ? t('metadata.titleFromKey', { key: key(titleKey) }) : ''
  }

  for (const control of [titleKey, descriptionKey])
    control.addEventListener(
      'input',
      () => {
        refresh()
        edited()
      },
      { signal: abort.signal },
    )

  return {
    render(
      next: ProjectView | undefined,
      source: { titleKey?: string | undefined; descriptionKey?: string | undefined } | undefined,
      replace: boolean,
    ) {
      view = next
      options.replaceChildren(
        ...(view?.translationKeys ?? []).map((id) => {
          const option = root.ownerDocument.createElement('option')
          option.value = id
          option.label = view?.translations?.[id] ?? ''

          return option
        }),
      )

      if (replace) {
        titleKey.value = source?.titleKey ?? ''
        descriptionKey.value = source?.descriptionKey ?? ''
      }

      refresh()
    },
    read: () => ({ titleKey: key(titleKey) || null, descriptionKey: key(descriptionKey) || null }),
    validate() {
      refresh()

      if (!known(titleKey) || !known(descriptionKey)) return t('metadata.unknownKey')

      if (!validTitle()) return t('metadata.emptyTitleTranslation')

      return undefined
    },
    dispose: () => abort.abort(),
  }
}
