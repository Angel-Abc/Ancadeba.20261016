import './workshop.css'
import '@ancadeba/ui-components/game.css'
import { createAppearance, getSwordMaterials, getTunicPresets } from './appearance'
import { AppearancePreview } from './preview'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { BrowserGraphicResources, createGraphicPlatform } from '@ancadeba/ui-components'
import { HttpGameResources } from '../gameResources'

const source = new HttpGameResources(
  './sample-games/graphics/',
  new URL(import.meta.env.BASE_URL, document.baseURI).href,
  fetch,
)

const log = (category: string, message: string) => {
  console.debug(`[${category}] ${message}`)

  return message
}

const logger: ILogger = { debug: log, info: log, warn: log, error: log }
const game = await new GameLoader(new JsonResourceLoader(source, logger)).load()

if (!game.assets) throw new Error('The graphics sample has no asset catalogue')

const catalog = game.assets
const swordMaterials = getSwordMaterials(catalog)
const tunicPresets = getTunicPresets(catalog)

const graphics = new BrowserGraphicResources(source, createGraphicPlatform(document))

function element<T extends HTMLElement>(selector: string, type: { new (): T }): T {
  const result = document.querySelector(selector)

  if (!(result instanceof type)) throw new Error(`Missing workshop element: ${selector}`)

  return result
}

const controls = new AbortController()
const eventOptions = { signal: controls.signal }

const colorInputs = {
  fabric: element('#fabric', HTMLInputElement),
  trim: element('#trim', HTMLInputElement),
  metal: element('#metal', HTMLInputElement),
}

const equipTunic = element('#equip-tunic', HTMLInputElement)
const equipSword = element('#equip-sword', HTMLInputElement)
const equipCloak = element('#equip-cloak', HTMLInputElement)
const loadout = element('#loadout', HTMLElement)

const preview = new AppearancePreview(
  {
    character: element('#character-preview', HTMLElement),
    tunic: element('#tunic-preview', HTMLElement),
    sword: element('#sword-preview', HTMLElement),
  },
  game.assets,
  graphics,
)

let appearance = createAppearance(catalog)

const paletteButtons = tunicPresets.map((preset) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'preset-button'

  const swatches = document.createElement('span')
  swatches.className = 'palette-dots'
  swatches.setAttribute('aria-hidden', 'true')

  for (const color of [preset.fabric, preset.trim, preset.metal]) {
    const dot = document.createElement('span')
    dot.style.backgroundColor = color
    swatches.append(dot)
  }

  button.append(swatches, preset.label)
  button.addEventListener(
    'click',
    () => {
      appearance.tunic.palette = { fabric: preset.fabric, trim: preset.trim, metal: preset.metal }
      update()
    },
    eventOptions,
  )
  element('#tunic-presets', HTMLElement).append(button)

  return { button, preset }
})

const materialButtons = swordMaterials.map((material) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'material-button'

  const swatch = document.createElement('span')
  swatch.className = 'material-swatch'
  swatch.style.setProperty('--sample', material.blade)
  swatch.style.setProperty('--sample-edge', material.edge)
  swatch.setAttribute('aria-hidden', 'true')

  const check = document.createElement('span')
  check.className = 'material-check'
  check.textContent = '✓'
  check.setAttribute('aria-hidden', 'true')
  button.append(swatch, material.label, check)
  button.addEventListener(
    'click',
    () => {
      appearance.sword.material = { ...material }
      update()
    },
    eventOptions,
  )
  element('#sword-materials', HTMLElement).append(button)

  return { button, material }
})

function update(): void {
  preview.update(appearance)
  equipTunic.checked = appearance.tunic.equipped
  equipSword.checked = appearance.sword.equipped
  equipCloak.checked = appearance.cloak

  for (const slot of ['fabric', 'trim', 'metal'] as const) {
    const color = appearance.tunic.palette[slot]
    colorInputs[slot].value = color
    element(`#${slot}-value`, HTMLOutputElement).value = color.toUpperCase()
  }

  for (const { button, preset } of paletteButtons) {
    const selected = (['fabric', 'trim', 'metal'] as const).every(
      (slot) => preset[slot] === appearance.tunic.palette[slot],
    )

    button.setAttribute('aria-pressed', String(selected))
  }

  for (const { button, material } of materialButtons) {
    button.setAttribute('aria-pressed', String(material.id === appearance.sword.material.id))
  }

  const equipped = []

  if (appearance.tunic.equipped) equipped.push('Wayfarer’s tunic')

  if (appearance.sword.equipped) equipped.push(`${appearance.sword.material.label} sword`)

  if (appearance.cloak) equipped.push('Cloak')

  loadout.textContent = equipped.length
    ? equipped.join(' + ')
    : 'No equipment · ready for a fresh start'
}

for (const slot of ['fabric', 'trim', 'metal'] as const) {
  colorInputs[slot].addEventListener(
    'input',
    () => {
      appearance.tunic.palette[slot] = colorInputs[slot].value
      update()
    },
    eventOptions,
  )
}

equipTunic.addEventListener(
  'change',
  () => {
    appearance.tunic.equipped = equipTunic.checked
    update()
  },
  eventOptions,
)

equipSword.addEventListener(
  'change',
  () => {
    appearance.sword.equipped = equipSword.checked
    update()
  },
  eventOptions,
)

element('#reset', HTMLButtonElement).addEventListener(
  'click',
  () => {
    appearance = createAppearance(catalog)
    update()
  },
  eventOptions,
)

update()

equipCloak.addEventListener(
  'change',
  () => {
    appearance.cloak = equipCloak.checked
    update()
  },
  eventOptions,
)

import.meta.hot?.dispose(() => {
  controls.abort()
  preview.dispose()
  graphics.dispose()
})
