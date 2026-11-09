import type { GraphicAppearance, SlotAppearance } from '@ancadeba/schemas'
import { object } from './project.js'

/** Preserves extensions at stable paths while cleared overrides and bindings stay cleared. */
export function mergeGraphicAppearance(previous: unknown, appearance: GraphicAppearance) {
  const mergeBinding = (old: unknown, binding: SlotAppearance['partBinding']) =>
    binding ? { ...object(old), ...binding } : undefined

  const mergeSelection = (
    old: Record<string, unknown>,
    selection: Pick<SlotAppearance, 'colors' | 'palette' | 'visible' | 'bindings'>,
  ) => ({
    ...old,
    ...selection,
    palette: selection.palette,
    bindings: selection.bindings
      ? {
          ...object(old.bindings),
          palette: mergeBinding(object(old.bindings).palette, selection.bindings.palette),
          visible: mergeBinding(object(old.bindings).visible, selection.bindings.visible),
          colors: Object.fromEntries(
            Object.entries(selection.bindings.colors).map(([id, binding]) => [
              id,
              mergeBinding(object(object(old.bindings).colors)[id], binding),
            ]),
          ),
        }
      : undefined,
  })

  const old = object(previous)

  return {
    ...mergeSelection(old, appearance),
    slots: Object.fromEntries(
      Object.entries(appearance.slots).map(([id, selection]) => {
        const before = object(object(old.slots)[id])

        return [
          id,
          {
            ...mergeSelection(before, selection),
            part: selection.part,
            partBinding: mergeBinding(before.partBinding, selection.partBinding),
          },
        ]
      }),
    ),
  }
}
