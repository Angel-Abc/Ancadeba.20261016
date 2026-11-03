import type { AssetCatalog } from '@ancadeba/schemas'

export interface TunicPalette {
  fabric: string
  trim: string
  metal: string
}

export interface SwordMaterial {
  id: string
  label: string
  blade: string
  edge: string
  hilt: string
  grip: string
}

export interface Appearance {
  cloak: boolean
  tunic: { equipped: boolean; palette: TunicPalette }
  sword: { equipped: boolean; material: SwordMaterial }
}

function color(colors: Readonly<Record<string, string>> | undefined, slot: string): string {
  const value = colors?.[slot]

  if (!value) throw new Error('The graphics sample is missing color slot ' + slot)

  return value
}

function tunic(colors: Readonly<Record<string, string>> | undefined): TunicPalette {
  return {
    fabric: color(colors, 'fabric'),
    trim: color(colors, 'trim'),
    metal: color(colors, 'metal'),
  }
}

export function getTunicPresets(catalog: AssetCatalog) {
  return ['wayfarer', 'royal', 'ember'].map((id) => ({
    label: id[0]!.toUpperCase() + id.slice(1),
    ...tunic(catalog.images.tunic?.palettes[id]),
  }))
}

export function getSwordMaterials(catalog: AssetCatalog): SwordMaterial[] {
  return ['steel', 'bronze', 'obsidian'].map((id) => {
    const colors = catalog.images.sword?.palettes[id]

    return {
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
      blade: color(colors, 'blade'),
      edge: color(colors, 'edge'),
      hilt: color(colors, 'hilt'),
      grip: color(colors, 'grip'),
    }
  })
}

export function createAppearance(catalog: AssetCatalog): Appearance {
  return {
    cloak: false,
    tunic: { equipped: true, palette: tunic(catalog.images.tunic?.colors) },
    sword: { equipped: true, material: getSwordMaterials(catalog)[0]! },
  }
}
