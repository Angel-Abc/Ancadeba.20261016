import {
  assertGraphicReference,
  colorSchema,
  type AssetCatalog,
  type GraphicBounds,
  type GraphicAppearance,
  type ImageAsset,
  type GraphicPart,
  type SlotAppearance,
} from '@ancadeba/schemas'
import type { IGameBindings, GameBinding } from './gameBindings.js'

export interface GraphicDiagnostic {
  target: string
  message: string
}

export interface GraphicPiece {
  readonly imageId: string
  readonly image: ImageAsset
  readonly colors: Readonly<Record<string, string>>
  readonly transform: string
  readonly layer: string
}

export interface GraphicResolution {
  readonly bounds: GraphicBounds
  readonly visible: boolean
  readonly pieces: readonly GraphicPiece[]
  readonly diagnostics: readonly GraphicDiagnostic[]
}

/** Resolves data only. Loading, decoding, and DOM composition belong to the host. */
export function resolveGraphic(
  catalog: AssetCatalog,
  visual: string,
  appearance: GraphicAppearance,
  bindings?: IGameBindings,
): GraphicResolution {
  assertGraphicReference(catalog, visual, appearance)
  const diagnostics: GraphicDiagnostic[] = []

  const read = <T>(
    binding: GameBinding | undefined,
    fallback: T,
    accepts: (value: unknown) => value is T,
    target: string,
  ): T => {
    if (!binding) return fallback
    const result = bindings?.read(binding)

    if (result?.status === 'resolved' && accepts(result.value)) return result.value
    diagnostics.push({
      target,
      message:
        result?.status === 'unresolved'
          ? result.diagnostic.reason
          : 'Unavailable or invalid bound appearance value',
    })

    return fallback
  }

  const visible = (selection: Pick<SlotAppearance, 'visible' | 'bindings'>, target: string) =>
    read(
      selection.bindings?.visible,
      selection.visible,
      (value): value is boolean => typeof value === 'boolean',
      `${target}.visible`,
    )

  const palette = (
    asset: ImageAsset | GraphicPart,
    selection: Pick<SlotAppearance, 'colors' | 'palette' | 'bindings'>,
    target: string,
  ) => {
    const selected = read(
      selection.bindings?.palette,
      selection.palette ?? '',
      (value): value is string =>
        typeof value === 'string' && (value === '' || Object.hasOwn(asset.palettes, value)),
      `${target}.palette`,
    )

    const colors = {
      ...asset.colors,
      ...(selected ? asset.palettes[selected] : {}),
      ...selection.colors,
    }

    for (const [slot, binding] of Object.entries(selection.bindings?.colors ?? {})) {
      if (!Object.hasOwn(asset.colors, slot)) {
        diagnostics.push({ target: `${target}.${slot}`, message: 'Unknown color slot' })
        continue
      }

      colors[slot] = read(
        binding,
        colors[slot]!,
        (value): value is string => colorSchema.safeParse(value).success,
        `${target}.${slot}`,
      )
    }

    return colors
  }

  const pieces: GraphicPiece[] = []

  const appendPart = (
    part: GraphicPart,
    selection: SlotAppearance,
    anchors: Readonly<Record<string, { x: number; y: number }>> | undefined,
    target: string,
  ) => {
    if (!visible(selection, target)) return
    const colors = palette(part, selection, target)

    for (const piece of part.pieces) {
      const image = catalog.images[piece.image]!
      const mapped = { ...image.colors }

      for (const [imageSlot, partSlot] of Object.entries(piece.slots))
        mapped[imageSlot] = colors[partSlot]!
      const anchor = anchors?.[piece.anchor] ?? piece.sourceAnchor
      pieces.push({
        imageId: piece.image,
        image,
        colors: mapped,
        layer: piece.layer,
        transform: `translate(${anchor.x} ${anchor.y}) rotate(${piece.rotation}) scale(${piece.scale}) translate(${-piece.sourceAnchor.x} ${-piece.sourceAnchor.y})`,
      })
    }
  }

  const image = catalog.images[visual]
  const part = catalog.parts[visual]
  const composition = catalog.compositions[visual]
  const shown = visible(appearance, visual)

  if (shown) {
    if (image)
      pieces.push({
        imageId: visual,
        image,
        colors: palette(image, appearance, visual),
        transform: '',
        layer: 'image',
      })
    else if (part) appendPart(part, appearance, undefined, visual)
    else if (composition) {
      for (const [slot, definition] of Object.entries(composition.slots)) {
        const selection = appearance.slots[slot] ?? { visible: true, colors: {} }
        const fallback = selection.part === undefined ? definition.default : selection.part

        const selected = read(
          selection.partBinding,
          fallback ?? '',
          (value): value is string =>
            typeof value === 'string' && (value === '' || definition.parts.includes(value)),
          `${slot}.part`,
        )

        if (selected) appendPart(catalog.parts[selected]!, selection, composition.anchors, slot)
      }

      pieces.sort(
        (a, b) => composition.layers.indexOf(a.layer) - composition.layers.indexOf(b.layer),
      )
    }
  }

  return {
    bounds: image?.preview ?? image?.bounds ?? part?.bounds ?? composition!.bounds,
    visible: shown,
    pieces,
    diagnostics,
  }
}
