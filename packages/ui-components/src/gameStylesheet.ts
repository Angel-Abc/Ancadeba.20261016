const localRules = new Set([
  'CSSStyleRule',
  'CSSNestedDeclarations',
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSScopeRule',
])

function hasNestedRules(rule: CSSRule): rule is CSSStyleRule | CSSGroupingRule {
  return 'cssRules' in rule
}

function checkLocalRules(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    if (!localRules.has(rule.constructor.name)) {
      throw new Error(`Game stylesheets cannot use ${rule.constructor.name}`)
    }

    if (hasNestedRules(rule)) checkLocalRules(rule.cssRules)
  }
}

/** Install one implicit scope rooted at the viewport that owns the style element. */
export function mountGameStylesheet(viewport: HTMLElement, css: string): void {
  const style = viewport.ownerDocument.createElement('style')
  style.media = 'not all'
  viewport.append(style)

  try {
    const sheet = style.sheet

    if (!sheet) throw new Error('The game stylesheet is unavailable')

    // insertRule accepts a single rule, so authored text cannot close the scope and add a rule outside it.
    sheet.insertRule(`@scope {\n${css}\n}`, 0)
    checkLocalRules(sheet.cssRules)
    style.media = ''
  } catch (cause) {
    style.remove()
    throw new Error('Could not apply the scoped game stylesheet', { cause })
  }
}
