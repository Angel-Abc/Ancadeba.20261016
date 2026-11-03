export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string

/** Plain-text lookup and one-pass substitution; values are never parsed as templates or markup. */
export function createTranslator(
  fallback: Readonly<Record<string, string>>,
  messages: Readonly<Record<string, string>> = {},
): Translate {
  return (key, values = {}) => {
    const template = Object.hasOwn(messages, key)
      ? messages[key]!
      : Object.hasOwn(fallback, key)
        ? fallback[key]!
        : key

    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder: string, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    )
  }
}
