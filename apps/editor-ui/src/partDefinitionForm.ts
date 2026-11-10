import { partPieceSchema, type AssetCatalog, type GraphicPart } from '@ancadeba/schemas'
import {
  boundsForm,
  partColorsForm,
  moveDefinitionEntry,
  requireDefinitionId,
  type GraphicDefinitionControls,
} from './graphicDefinitionForms.js'

/** A part groups image pieces, transforms and color mappings into one selectable object. */
export function partDefinitionForm(
  context: GraphicDefinitionControls,
  catalog: AssetCatalog,
  part: GraphicPart,
): HTMLElement[] {
  const { controls, pending, change, edited } = context
  const { group, input, select, button, t } = controls

  return [
    boundsForm(context, part),
    group(
      t('definitions.pieces'),
      ...part.pieces.map((piece, index) =>
        group(
          t('definitions.piece', { id: piece.id }),
          select(t('definitions.pieceImage'), piece.image, Object.keys(catalog.images), (value) =>
            change(() => {
              piece.image = value
              piece.slots = Object.fromEntries(
                Object.entries(piece.slots).filter(([id]) =>
                  Object.hasOwn(catalog.images[value]?.colors ?? {}, id),
                ),
              )
            }),
          ),
          input(t('definitions.pieceLayer'), piece.layer, (value) => {
            piece.layer = value.trim()
            edited()
          }),
          input(t('definitions.destinationAnchor'), piece.anchor, (value) => {
            piece.anchor = value.trim()
            edited()
          }),
          ...(['x', 'y'] as const).map((key) =>
            input(
              t('definitions.sourceAnchor', { axis: key }),
              String(piece.sourceAnchor[key]),
              (value) => {
                piece.sourceAnchor[key] = Number(value)
                edited()
              },
              'number',
            ),
          ),
          input(
            t('definitions.pieceScale'),
            String(piece.scale),
            (value) => {
              piece.scale = Number(value)
              edited()
            },
            'number',
          ),
          input(
            t('definitions.pieceRotation'),
            String(piece.rotation),
            (value) => {
              piece.rotation = Number(value)
              edited()
            },
            'number',
          ),
          ...Object.keys(catalog.images[piece.image]?.colors ?? {}).map((id) =>
            select(
              t('definitions.mapColor', { id }),
              piece.slots[id] ?? '',
              [['', t('definitions.imageDefault')], ...Object.keys(part.colors)],
              (value) => {
                if (value) piece.slots[id] = value
                else delete piece.slots[id]
                edited()
              },
            ),
          ),
          button(
            t('definitions.movePieceUp', { id: piece.id }),
            () => change(() => moveDefinitionEntry(part.pieces, index, -1)),
            index === 0,
          ),
          button(
            t('definitions.movePieceDown', { id: piece.id }),
            () => change(() => moveDefinitionEntry(part.pieces, index, 1)),
            index === part.pieces.length - 1,
          ),
          button(t('definitions.removePiece', { id: piece.id }), () =>
            change(() => {
              part.pieces.splice(index, 1)
            }),
          ),
        ),
      ),
      input(t('definitions.newPieceId'), pending.piece, (value) => {
        pending.piece = value.trim()
      }),
      button(
        t('definitions.addPiece'),
        () =>
          change(() => {
            requireDefinitionId(
              pending.piece,
              part.pieces.map((piece) => piece.id),
              t,
            )
            const image = Object.keys(catalog.images)[0]

            if (!image) throw new Error(t('definitions.imageFirst'))
            part.pieces.push(partPieceSchema.parse({ id: pending.piece, image, layer: 'body' }))
            pending.piece = ''
          }),
        !Object.keys(catalog.images).length,
      ),
    ),
    partColorsForm(context, part),
  ]
}
