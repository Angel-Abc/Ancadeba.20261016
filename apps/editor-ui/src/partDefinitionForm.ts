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
  const { group, input, select, button } = controls

  return [
    boundsForm(context, part),
    group(
      'Image pieces',
      ...part.pieces.map((piece, index) =>
        group(
          `Piece ${piece.id}`,
          select('Piece image', piece.image, Object.keys(catalog.images), (value) =>
            change(() => {
              piece.image = value
              piece.slots = Object.fromEntries(
                Object.entries(piece.slots).filter(([id]) =>
                  Object.hasOwn(catalog.images[value]?.colors ?? {}, id),
                ),
              )
            }),
          ),
          input('Piece layer', piece.layer, (value) => {
            piece.layer = value.trim()
            edited()
          }),
          input('Destination anchor', piece.anchor, (value) => {
            piece.anchor = value.trim()
            edited()
          }),
          ...(['x', 'y'] as const).map((key) =>
            input(
              `Source anchor ${key}`,
              String(piece.sourceAnchor[key]),
              (value) => {
                piece.sourceAnchor[key] = Number(value)
                edited()
              },
              'number',
            ),
          ),
          input(
            'Piece scale',
            String(piece.scale),
            (value) => {
              piece.scale = Number(value)
              edited()
            },
            'number',
          ),
          input(
            'Piece rotation',
            String(piece.rotation),
            (value) => {
              piece.rotation = Number(value)
              edited()
            },
            'number',
          ),
          ...Object.keys(catalog.images[piece.image]?.colors ?? {}).map((id) =>
            select(
              `Map image color ${id}`,
              piece.slots[id] ?? '',
              [['', 'Use image default'], ...Object.keys(part.colors)],
              (value) => {
                if (value) piece.slots[id] = value
                else delete piece.slots[id]
                edited()
              },
            ),
          ),
          button(
            `Move piece ${piece.id} up`,
            () => change(() => moveDefinitionEntry(part.pieces, index, -1)),
            index === 0,
          ),
          button(
            `Move piece ${piece.id} down`,
            () => change(() => moveDefinitionEntry(part.pieces, index, 1)),
            index === part.pieces.length - 1,
          ),
          button(`Remove piece ${piece.id}`, () =>
            change(() => {
              part.pieces.splice(index, 1)
            }),
          ),
        ),
      ),
      input('New piece ID', pending.piece, (value) => {
        pending.piece = value.trim()
      }),
      button(
        'Add image piece',
        () =>
          change(() => {
            requireDefinitionId(
              pending.piece,
              part.pieces.map((piece) => piece.id),
            )
            const image = Object.keys(catalog.images)[0]

            if (!image) throw new Error('Import an image before adding pieces.')
            part.pieces.push(partPieceSchema.parse({ id: pending.piece, image, layer: 'body' }))
            pending.piece = ''
          }),
        !Object.keys(catalog.images).length,
      ),
    ),
    partColorsForm(context, part),
  ]
}
