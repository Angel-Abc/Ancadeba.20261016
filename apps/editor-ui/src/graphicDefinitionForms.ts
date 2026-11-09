import { assetIdSchema, type GraphicPart, type GraphicComposition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export interface GraphicDefinitionPending {
  piece: string
  layer: string
  anchor: string
  slot: string
  color: string
  palette: string
}

export interface GraphicDefinitionControls {
  controls: RuleFormControls
  pending: GraphicDefinitionPending
  change: (operation: () => void) => void
  edited: () => void
}

export function requireDefinitionId(id: string, ids: readonly string[]) {
  if (!assetIdSchema.safeParse(id).success || ids.includes(id))
    throw new Error(
      'Choose a valid, unused identifier using letters, digits, underscores or hyphens.',
    )
}

export function boundsForm(
  context: GraphicDefinitionControls,
  definition: GraphicPart | GraphicComposition,
) {
  const { controls, edited } = context

  return controls.group(
    'Preview bounds',
    ...(['x', 'y', 'width', 'height'] as const).map((key) =>
      controls.input(
        `Bounds ${key}`,
        String(definition.bounds[key]),
        (value) => {
          definition.bounds[key] = Number(value)
          edited()
        },
        'number',
      ),
    ),
  )
}

export function moveDefinitionEntry<T>(entries: T[], index: number, offset: number) {
  const target = index + offset

  if (target < 0 || target >= entries.length) return
  const [entry] = entries.splice(index, 1)
  entries.splice(target, 0, entry!)
}

export function partColorsForm(context: GraphicDefinitionControls, part: GraphicPart): HTMLElement {
  const { controls, pending, change, edited } = context
  const { group, input, select, button } = controls
  const colors = Object.keys(part.colors)

  return group(
    'Part colors and palettes',
    ...colors.map((id) =>
      group(
        `Color ${id}`,
        input(
          `Default color ${id}`,
          part.colors[id]!,
          (value) => {
            part.colors[id] = value
            edited()
          },
          'color',
        ),
        button(`Remove color ${id}`, () =>
          change(() => {
            delete part.colors[id]

            for (const palette of Object.values(part.palettes)) delete palette[id]

            for (const piece of part.pieces)
              for (const [slot, value] of Object.entries(piece.slots))
                if (value === id) delete piece.slots[slot]
          }),
        ),
      ),
    ),
    input('New part color ID', pending.color, (value) => {
      pending.color = value.trim()
    }),
    button('Add part color', () =>
      change(() => {
        requireDefinitionId(pending.color, colors)
        part.colors[pending.color] = '#ffffff'
        pending.color = ''
      }),
    ),
    ...Object.entries(part.palettes).map(([id, palette]) =>
      group(
        `Palette ${id}`,
        ...colors.flatMap((color) => [
          select(
            `Palette ${id} overrides ${color}`,
            String(Object.hasOwn(palette, color)),
            ['false', 'true'],
            (value) =>
              change(() => {
                if (value === 'true') palette[color] = part.colors[color]!
                else delete palette[color]
              }),
          ),
          ...(Object.hasOwn(palette, color)
            ? [
                input(
                  `Palette ${id} color ${color}`,
                  palette[color]!,
                  (value) => {
                    palette[color] = value
                    edited()
                  },
                  'color',
                ),
              ]
            : []),
        ]),
        button(`Remove palette ${id}`, () =>
          change(() => {
            delete part.palettes[id]
          }),
        ),
      ),
    ),
    input('New part palette ID', pending.palette, (value) => {
      pending.palette = value.trim()
    }),
    button('Add part palette', () =>
      change(() => {
        requireDefinitionId(pending.palette, Object.keys(part.palettes))
        part.palettes[pending.palette] = {}
        pending.palette = ''
      }),
    ),
  )
}
