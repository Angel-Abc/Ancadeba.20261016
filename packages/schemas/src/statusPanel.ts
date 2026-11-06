import { assertGraphicReference, graphicAppearanceSchema, type AssetCatalog } from './assets.js'
import type { GameBindingDefinition } from './bindings.js'
import type { StatusPanelComponentDefinition } from './scene.js'

export function statusPanelBindings(
  panel: StatusPanelComponentDefinition,
): { binding: GameBindingDefinition; expected: 'number' | 'value' | 'boolean' }[] {
  const result: ReturnType<typeof statusPanelBindings> = []

  for (const row of panel.rows) {
    if (typeof row.value === 'object')
      result.push({ binding: row.value, expected: row.type === 'bar' ? 'number' : 'value' })

    if (row.type === 'bar' && typeof row.maximum === 'object')
      result.push({ binding: row.maximum, expected: 'number' })
  }

  for (const effect of panel.effects)
    if (effect.visibleWhen) result.push({ binding: effect.visibleWhen, expected: 'boolean' })

  return result
}

/** Shared startup, editor, and export checks for optional status artwork. */
export function statusPanelIssues(
  panel: StatusPanelComponentDefinition,
  assets?: AssetCatalog,
): { path: (string | number)[]; message: string }[] {
  const references = [
    ...(panel.portrait ? [{ visual: panel.portrait, path: ['portrait'] }] : []),
    ...panel.effects.flatMap((effect, index) =>
      effect.icon ? [{ visual: effect.icon, path: ['effects', index, 'icon'] }] : [],
    ),
  ]

  return references.flatMap(({ visual, path }) => {
    try {
      if (!assets) throw new Error('Status artwork requires an asset catalogue')
      assertGraphicReference(assets, visual, graphicAppearanceSchema.parse({}))

      return []
    } catch (error) {
      return [{ path, message: error instanceof Error ? error.message : String(error) }]
    }
  })
}
