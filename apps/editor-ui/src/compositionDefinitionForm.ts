import type { AssetCatalog, GraphicComposition } from '@ancadeba/schemas'
import {
  boundsForm,
  moveDefinitionEntry,
  requireDefinitionId,
  type GraphicDefinitionControls,
} from './graphicDefinitionForms.js'
import { yesNoChoices } from './ruleFormControls.js'

/** Include the chosen part's attachment requirements without moving existing anchors. */
function includePart(composition: GraphicComposition, id: string, catalog: AssetCatalog) {
  for (const piece of catalog.parts[id]?.pieces ?? []) {
    if (!composition.layers.includes(piece.layer)) composition.layers.push(piece.layer)

    if (!Object.hasOwn(composition.anchors, piece.anchor))
      composition.anchors[piece.anchor] = { ...piece.sourceAnchor }
  }
}

export function compositionDefinitionForm(
  context: GraphicDefinitionControls,
  catalog: AssetCatalog,
  composition: GraphicComposition,
): HTMLElement[] {
  const { controls, pending, change, edited } = context
  const { group, input, select, button } = controls
  const parts = Object.keys(catalog.parts)

  return [
    boundsForm(context, composition),
    group(
      'Layers — back to front',
      ...composition.layers.map((id, index) =>
        group(
          `Layer ${index + 1}`,
          input('Layer ID', id, (value) => {
            composition.layers[index] = value.trim()
            edited()
          }),
          button(
            `Move layer ${id} back`,
            () => change(() => moveDefinitionEntry(composition.layers, index, -1)),
            index === 0,
          ),
          button(
            `Move layer ${id} forward`,
            () => change(() => moveDefinitionEntry(composition.layers, index, 1)),
            index === composition.layers.length - 1,
          ),
          button(
            `Remove layer ${id}`,
            () =>
              change(() => {
                composition.layers.splice(index, 1)
              }),
            composition.layers.length <= 1,
          ),
        ),
      ),
      input('New layer ID', pending.layer, (value) => {
        pending.layer = value.trim()
      }),
      button('Add layer', () =>
        change(() => {
          requireDefinitionId(pending.layer, composition.layers)
          composition.layers.push(pending.layer)
          pending.layer = ''
        }),
      ),
    ),
    group(
      'Destination anchors',
      ...Object.entries(composition.anchors).map(([id, point]) =>
        group(
          `Anchor ${id}`,
          ...(['x', 'y'] as const).map((key) =>
            input(
              `Anchor ${key}`,
              String(point[key]),
              (value) => {
                point[key] = Number(value)
                edited()
              },
              'number',
            ),
          ),
          button(`Remove anchor ${id}`, () =>
            change(() => {
              delete composition.anchors[id]
            }),
          ),
        ),
      ),
      input('New anchor ID', pending.anchor, (value) => {
        pending.anchor = value.trim()
      }),
      button('Add anchor', () =>
        change(() => {
          requireDefinitionId(pending.anchor, Object.keys(composition.anchors))
          composition.anchors[pending.anchor] = { x: 0, y: 0 }
          pending.anchor = ''
        }),
      ),
    ),
    group(
      'Selectable slots',
      ...Object.entries(composition.slots).map(([id, slot]) =>
        group(
          `Slot ${id}`,
          ...parts.map((part) =>
            select(`Allow part ${part}`, String(slot.parts.includes(part)), yesNoChoices, (value) =>
              change(() => {
                if (value === 'true') {
                  slot.parts = [...new Set([...slot.parts, part])]
                  includePart(composition, part, catalog)
                } else {
                  slot.parts = slot.parts.filter((value) => value !== part)

                  if (slot.default === part) slot.default = null
                }
              }),
            ),
          ),
          select('Default part', slot.default ?? '', [['', 'None'], ...slot.parts], (value) => {
            slot.default = value || null
            edited()
          }),
          button(`Remove slot ${id}`, () =>
            change(() => {
              delete composition.slots[id]
            }),
          ),
        ),
      ),
      input('New slot ID', pending.slot, (value) => {
        pending.slot = value.trim()
      }),
      button(
        'Add composition slot',
        () =>
          change(() => {
            requireDefinitionId(pending.slot, Object.keys(composition.slots))
            const part = parts[0]

            if (!part) throw new Error('Create a part before adding a slot.')
            composition.slots[pending.slot] = { parts: [part], default: part }
            includePart(composition, part, catalog)
            pending.slot = ''
          }),
        !parts.length,
      ),
    ),
  ]
}
