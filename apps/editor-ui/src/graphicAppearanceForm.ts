import type { ProjectView } from '@ancadeba/editor-core'
import type {
  AssetCatalog,
  GraphicAppearance,
  SlotAppearance,
  GraphicPart,
  ImageAsset,
} from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'
import { graphicBindingForm } from './graphicBindingForm.js'

type Selection = Pick<SlotAppearance, 'colors' | 'palette' | 'visible' | 'bindings'>

/** Dynamic part choices must share every statically authored color and palette override. */
export function compatibleAppearance(selection: Selection, assets: (ImageAsset | GraphicPart)[]) {
  const colors = assets.length
    ? Object.keys(assets[0]!.colors).filter((id) =>
        assets.every((asset) => Object.hasOwn(asset.colors, id)),
      )
    : []

  const palettes = assets.length
    ? Object.keys(assets[0]!.palettes).filter((id) =>
        assets.every((asset) => Object.hasOwn(asset.palettes, id)),
      )
    : []

  for (const id of Object.keys(selection.colors))
    if (!colors.includes(id)) delete selection.colors[id]

  for (const id of Object.keys(selection.bindings?.colors ?? {}))
    if (!colors.includes(id)) delete selection.bindings!.colors[id]

  if (selection.palette && !palettes.includes(selection.palette)) delete selection.palette

  return { colors, palettes }
}

export function graphicAppearanceForm(
  controls: RuleFormControls,
  view: ProjectView,
  catalog: AssetCatalog,
  visual: string,
  appearance: GraphicAppearance,
  gameScene: boolean,
  change: (operation: () => void) => void,
  edited: () => void,
): HTMLElement {
  const { group, select, button, input, create } = controls
  const root = group('Graphic appearance')
  const help = create('p')
  help.className = 'help'
  help.textContent = gameScene
    ? 'Static values supply fallbacks for bindings. Visibility expects true or false, colors expect #rrggbb, palettes expect a preset name, and part bindings expect an allowed part ID (or empty text for none).'
    : 'This stand-alone scene uses static appearance. Game-state bindings require a game scene.'
  root.append(help)

  const bindings = (selection: Selection) => (selection.bindings ??= { colors: {} })

  const visibility = (selection: Selection, title: string, commit = () => {}) => {
    const box = group(
      title,
      select(
        'Static visibility',
        String(selection.visible),
        [
          ['true', 'Visible'],
          ['false', 'Hidden'],
        ],
        (value) =>
          change(() => {
            commit()
            selection.visible = value === 'true'
          }),
      ),
    )

    if (gameScene)
      box.append(
        graphicBindingForm(
          controls,
          view,
          `${title} visibility`,
          selection.bindings?.visible,
          'boolean',
          (value) => {
            commit()

            if (value) bindings(selection).visible = value
            else if (selection.bindings) delete selection.bindings.visible
          },
          change,
          () => {
            commit()
            edited()
          },
        ),
      )

    return box
  }

  const colorsAndPalettes = (
    selection: Selection,
    assets: (ImageAsset | GraphicPart)[],
    title: string,
    commit = () => {},
  ) => {
    // Keep obsolete entries visible until explicitly changed or reset; saving validates them.
    const sharedColors = assets.length
      ? Object.keys(assets[0]!.colors).filter((id) =>
          assets.every((asset) => Object.hasOwn(asset.colors, id)),
        )
      : []

    const colors = [
      ...new Set([
        ...sharedColors,
        ...Object.keys(selection.colors),
        ...Object.keys(selection.bindings?.colors ?? {}),
      ]),
    ]

    const palettes = assets.length
      ? Object.keys(assets[0]!.palettes).filter((id) =>
          assets.every((asset) => Object.hasOwn(asset.palettes, id)),
        )
      : []

    const box = group(
      title,
      select(
        'Static palette',
        selection.palette ?? '',
        [['', 'Default colors'], ...palettes],
        (value) =>
          change(() => {
            commit()
            selection.palette = value || undefined
          }),
      ),
    )

    if (gameScene)
      box.append(
        graphicBindingForm(
          controls,
          view,
          `${title} palette`,
          selection.bindings?.palette,
          'string',
          (value) => {
            commit()

            if (value) bindings(selection).palette = value
            else if (selection.bindings) delete selection.bindings.palette
          },
          change,
          () => {
            commit()
            edited()
          },
        ),
      )

    for (const color of colors) {
      const colorBox = group(
        `Color ${color}`,
        select(
          'Static color',
          Object.hasOwn(selection.colors, color) ? 'override' : 'inherit',
          [
            ['inherit', 'Inherit palette / default'],
            ['override', 'Override color'],
          ],
          (value) =>
            change(() => {
              commit()

              if (value === 'inherit') delete selection.colors[color]
              else
                selection.colors[color] =
                  assets[0]?.palettes[selection.palette ?? '']?.[color] ??
                  assets[0]?.colors[color] ??
                  '#ffffff'
            }),
        ),
      )

      if (Object.hasOwn(selection.colors, color)) {
        const swatch = input(
          'Color picker',
          selection.colors[color]!,
          (value) => {
            commit()
            selection.colors[color] = value
            hex.querySelector('input')!.value = value
            edited()
          },
          'color',
        )

        const hex = input('Hex color', selection.colors[color]!, (value) => {
          commit()
          selection.colors[color] = value

          if (/^#[0-9a-fA-F]{6}$/.test(value)) swatch.querySelector('input')!.value = value
          edited()
        })

        colorBox.append(swatch, hex)
      }

      if (gameScene)
        colorBox.append(
          graphicBindingForm(
            controls,
            view,
            `${title} ${color}`,
            selection.bindings?.colors[color],
            'string',
            (value) => {
              commit()

              if (value) bindings(selection).colors[color] = value
              else if (selection.bindings) delete selection.bindings.colors[color]
            },
            change,
            () => {
              commit()
              edited()
            },
          ),
        )
      box.append(colorBox)
    }

    return box
  }

  root.append(visibility(appearance, 'Graphic'))
  const asset = catalog.images[visual] ?? catalog.parts[visual]

  if (asset) root.append(colorsAndPalettes(appearance, [asset], 'Graphic colors'))
  const composition = catalog.compositions[visual]

  for (const [slot, definition] of Object.entries(composition?.slots ?? {})) {
    const selection = appearance.slots[slot] ?? { colors: {}, visible: true }

    const store = () => {
      appearance.slots[slot] = selection
    }

    const slotChange = (operation: () => void) =>
      change(() => {
        store()
        operation()
      })

    const selected = selection.part === undefined ? definition.default : selection.part
    const parts = selection.partBinding ? definition.parts : selected ? [selected] : []
    const assets = parts.flatMap((id) => (catalog.parts[id] ? [catalog.parts[id]!] : []))

    const box = group(
      `Slot ${slot}`,
      select(
        'Static part',
        selection.part === undefined
          ? 'inherit'
          : selection.part === null
            ? 'none'
            : `part:${selection.part}`,
        [
          ['inherit', `Default (${definition.default ?? 'None'})`],
          ['none', 'None'],
          ...definition.parts.map((id) => [`part:${id}`, id] as const),
        ],
        (value) =>
          slotChange(() => {
            selection.part =
              value === 'inherit' ? undefined : value === 'none' ? null : value.slice(5)

            const ids = selection.partBinding
              ? definition.parts
              : selection.part === undefined
                ? definition.default
                  ? [definition.default]
                  : []
                : selection.part
                  ? [selection.part]
                  : []

            compatibleAppearance(
              selection,
              ids.flatMap((id) => (catalog.parts[id] ? [catalog.parts[id]!] : [])),
            )
          }),
      ),
    )

    if (gameScene)
      box.append(
        graphicBindingForm(
          controls,
          view,
          `${slot} part`,
          selection.partBinding,
          'string',
          (value) => {
            store()
            selection.partBinding = value
            const ids = value ? definition.parts : selected ? [selected] : []
            compatibleAppearance(
              selection,
              ids.flatMap((id) => (catalog.parts[id] ? [catalog.parts[id]!] : [])),
            )
          },
          change,
          () => {
            store()
            edited()
          },
        ),
      )
    box.append(
      visibility(selection, `${slot} slot`, store),
      colorsAndPalettes(selection, assets, `${slot} colors`, store),
      button('Reset slot appearance', () =>
        change(() => {
          delete appearance.slots[slot]
        }),
      ),
    )
    root.append(box)
  }

  return root
}
