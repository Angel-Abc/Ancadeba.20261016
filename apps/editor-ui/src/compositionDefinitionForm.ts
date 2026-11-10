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
  const { group, input, select, button, t } = controls
  const parts = Object.keys(catalog.parts)

  return [
    boundsForm(context, composition),
    group(
      t('definitions.layers'),
      ...composition.layers.map((id, index) =>
        group(
          t('definitions.layerNumber', { number: index + 1 }),
          input(t('definitions.layerId'), id, (value) => {
            composition.layers[index] = value.trim()
            edited()
          }),
          button(
            t('definitions.moveLayerBack', { id }),
            () => change(() => moveDefinitionEntry(composition.layers, index, -1)),
            index === 0,
          ),
          button(
            t('definitions.moveLayerForward', { id }),
            () => change(() => moveDefinitionEntry(composition.layers, index, 1)),
            index === composition.layers.length - 1,
          ),
          button(
            t('definitions.removeLayer', { id }),
            () =>
              change(() => {
                composition.layers.splice(index, 1)
              }),
            composition.layers.length <= 1,
          ),
        ),
      ),
      input(t('definitions.newLayerId'), pending.layer, (value) => {
        pending.layer = value.trim()
      }),
      button(t('definitions.addLayer'), () =>
        change(() => {
          requireDefinitionId(pending.layer, composition.layers, t)
          composition.layers.push(pending.layer)
          pending.layer = ''
        }),
      ),
    ),
    group(
      t('definitions.destinationAnchors'),
      ...Object.entries(composition.anchors).map(([id, point]) =>
        group(
          t('definitions.anchor', { id }),
          ...(['x', 'y'] as const).map((key) =>
            input(
              t('definitions.anchorAxis', { axis: key }),
              String(point[key]),
              (value) => {
                point[key] = Number(value)
                edited()
              },
              'number',
            ),
          ),
          button(t('definitions.removeAnchor', { id }), () =>
            change(() => {
              delete composition.anchors[id]
            }),
          ),
        ),
      ),
      input(t('definitions.newAnchorId'), pending.anchor, (value) => {
        pending.anchor = value.trim()
      }),
      button(t('definitions.addAnchor'), () =>
        change(() => {
          requireDefinitionId(pending.anchor, Object.keys(composition.anchors), t)
          composition.anchors[pending.anchor] = { x: 0, y: 0 }
          pending.anchor = ''
        }),
      ),
    ),
    group(
      t('definitions.slots'),
      ...Object.entries(composition.slots).map(([id, slot]) =>
        group(
          t('form.slot', { id }),
          ...parts.map((part) =>
            select(
              t('definitions.allowPart', { part }),
              String(slot.parts.includes(part)),
              yesNoChoices(t),
              (value) =>
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
          select(
            t('definitions.defaultPart'),
            slot.default ?? '',
            [['', t('form.none')], ...slot.parts],
            (value) => {
              slot.default = value || null
              edited()
            },
          ),
          button(t('definitions.removeSlot', { id }), () =>
            change(() => {
              delete composition.slots[id]
            }),
          ),
        ),
      ),
      input(t('form.newSlotId'), pending.slot, (value) => {
        pending.slot = value.trim()
      }),
      button(
        t('definitions.addSlot'),
        () =>
          change(() => {
            requireDefinitionId(pending.slot, Object.keys(composition.slots), t)
            const part = parts[0]

            if (!part) throw new Error(t('definitions.partFirst'))
            composition.slots[pending.slot] = { parts: [part], default: part }
            includePart(composition, part, catalog)
            pending.slot = ''
          }),
        !parts.length,
      ),
    ),
  ]
}
