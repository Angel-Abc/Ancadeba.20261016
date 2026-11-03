import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  assetCatalogSchema,
  graphicAppearanceSchema,
  graphicComponentSchema,
  gameSchema,
  sceneSchema,
  localizeDefinitions,
  assertGraphicReference,
} from '@ancadeba/schemas'
import {
  resolveGraphic,
  parseGraphicSvg,
  prepareGraphicSvg,
  inspectImageSource,
  validateImageSource,
  GameBindings,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from '@ancadeba/game-runtime'

const catalog = assetCatalogSchema.parse(
  JSON.parse(
    await readFile(new URL('../sample-games/graphics/assets.json', import.meta.url), 'utf8'),
  ),
)

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30"><defs><linearGradient id="shade"><stop stop-color="var(--fabric, #123456)"/><stop offset="1" stop-color="#ffffff"/></linearGradient><clipPath id="clip"><rect width="20" height="30"/></clipPath></defs><path d="M0 0h20v30z" fill="url(#shade)" clip-path="url(#clip)"/></svg>'

describe('graphics definitions and source profile', () => {
  it('validates actual sample artwork, slot declarations, native bounds, and local definitions', async () => {
    for (const image of Object.values(catalog.images)) {
      const bytes = await readFile(
        new URL(`../sample-games/graphics/${image.source}`, import.meta.url),
      )

      expect(() => validateImageSource(image, bytes, bytes.toString('utf8'))).not.toThrow()
    }

    const parsed = parseGraphicSvg(svg)
    expect(parsed.colors).toEqual({ fabric: '#123456' })
    const recolored = prepareGraphicSvg(parsed, { fabric: '#fedcba' })
    expect(recolored).toContain('stop-color="#fedcba"')
    expect(recolored).toContain('url(#shade)')
    expect(recolored).toContain('clip-path="url(#clip)"')
    expect(parsed.colors.fabric).toBe('#123456')
    expect(() => prepareGraphicSvg(parsed, { fabric: 'url(https://invalid)' })).toThrow()
  })

  it.each([
    '<script>alert(1)</script>',
    '<foreignObject/>',
    '<animate attributeName="x"/>',
    '<path onclick="alert(1)"/>',
    '<use href="https://example.com/image.svg#x"/>',
    '<path fill="url(https://example.com/image.svg#x)"/>',
    '<style>path{fill:red}</style>',
    '<path style="fill:red"/>',
    '<text>Convert me to paths</text>',
    '<use href="#missing"/>',
  ])('rejects unsupported or non-self-contained SVG: %s', (content) => {
    expect(() =>
      parseGraphicSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30">${content}</svg>`,
      ),
    ).toThrow()
  })

  it('rejects DTDs, malformed XML, missing viewBoxes, invalid references, and undeclared palette slots', () => {
    expect(() => parseGraphicSvg('<!DOCTYPE svg [<!ENTITY bad "bad">]>' + svg)).toThrow()
    expect(() => parseGraphicSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow()
    expect(() => parseGraphicSvg(svg.replace('</svg>', ''))).toThrow()
    const invalid = structuredClone(catalog)
    invalid.parts.cloak!.pieces[0]!.image = 'missing'
    expect(assetCatalogSchema.safeParse(invalid).success).toBe(false)
    const wrong = structuredClone(catalog)
    wrong.images.tunic!.palettes.bad = { nonexistent: '#000000' }
    expect(assetCatalogSchema.safeParse(wrong).success).toBe(false)
    expect(() =>
      assertGraphicReference(
        catalog,
        'paper-doll',
        graphicAppearanceSchema.parse({ slots: { sword: { part: 'cloak' } } }),
      ),
    ).toThrow()
  })

  it('inspects PNG, JPEG, lossless WebP, and extended WebP bounds and rejects format mismatches', () => {
    const png = new Uint8Array(33)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    png.set([73, 72, 68, 82], 12)
    new DataView(png.buffer).setUint32(16, 40)
    new DataView(png.buffer).setUint32(20, 50)
    expect(inspectImageSource('png', png).bounds).toEqual({ x: 0, y: 0, width: 40, height: 50 })
    expect(() => inspectImageSource('jpeg', png)).toThrow()
    const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 30, 0, 20, 1])
    expect(inspectImageSource('jpeg', jpeg).bounds).toMatchObject({ width: 20, height: 30 })
    const webp = new Uint8Array(30)
    webp.set([82, 73, 70, 70])
    webp.set([87, 69, 66, 80, 86, 80, 56, 88], 8)
    webp[24] = 19
    webp[27] = 29
    expect(inspectImageSource('webp', webp).bounds).toMatchObject({ width: 20, height: 30 })
    webp[20] = 2
    expect(() => inspectImageSource('webp', webp)).toThrow(/Animated/)
    webp[20] = 47
    webp[15] = 76
    new DataView(webp.buffer).setUint32(21, 19 | (29 << 14), true)
    expect(inspectImageSource('webp', webp).bounds).toMatchObject({ width: 20, height: 30 })
  })

  it('keeps old manifests valid and localizes graphic alternative text including a decorative translation', () => {
    const game = gameSchema.parse({
      'schema-version': '1.0.0',
      id: 'test',
      title: 'Game',
      version: '1',
      scenes: ['scene'],
      languages: { default: 'en', available: ['en', 'nl'] },
    })

    const scene = sceneSchema.parse({
      'schema-version': '1.0.0',
      id: 'scene',
      title: 'Scene',
      type: 'stand-alone',
      screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
      components: [
        {
          id: 'art',
          type: 'graphic',
          visual: 'tunic',
          alt: 'Tunic',
          altKey: 'art.alt',
          placement: { row: 1, column: 1 },
        },
      ],
    })

    expect(game.assets).toBeUndefined()

    const localized = localizeDefinitions(game, new Map([['scene', scene]]), {
      fallback: { 'art.alt': 'Tunic' },
      messages: { 'art.alt': '' },
    })

    expect(localized.scenes.get('scene')?.components[0]).toMatchObject({ alt: '' })
    expect(
      graphicComponentSchema.parse({
        id: 'art',
        type: 'graphic',
        visual: 'tunic',
        alt: '',
        placement: { row: 1, column: 1 },
      }).fit,
    ).toBe('contain')
  })
})

describe('appearance resolution', () => {
  it('orders grouped cloak pieces around the body and maps shared palette slots to both images', () => {
    const appearance = graphicAppearanceSchema.parse({
      slots: { cloak: { colors: { fabric: '#112233', metal: '#aabbcc' } } },
    })

    const resolution = resolveGraphic(catalog, 'paper-doll', appearance)
    expect(resolution.pieces.map((piece) => piece.layer)).toEqual([
      'rear',
      'body',
      'clothes',
      'sword',
      'hands',
      'clasp',
    ])
    expect(resolution.pieces[0]?.colors).toEqual({ fabric: '#112233' })
    expect(resolution.pieces.at(-1)?.colors).toEqual({ metal: '#aabbcc' })
    expect(resolution.pieces.find((piece) => piece.layer === 'sword')?.transform).toBe(
      'translate(250 257) rotate(12) scale(0.7) translate(-40 -215)',
    )
    expect(
      resolveGraphic(
        catalog,
        'paper-doll',
        graphicAppearanceSchema.parse({ slots: { cloak: { part: null } } }),
      ).pieces.map((piece) => piece.layer),
    ).not.toContain('rear')
  })

  it('shares artwork while keeping appearances independent and follows default/preset/override precedence', () => {
    const first = resolveGraphic(
      catalog,
      'tunic',
      graphicAppearanceSchema.parse({ palette: 'royal', colors: { trim: '#ffffff' } }),
    )

    const second = resolveGraphic(catalog, 'tunic', graphicAppearanceSchema.parse({}))
    expect(first.pieces[0]?.colors).toEqual({
      fabric: '#665191',
      trim: '#ffffff',
      metal: '#c99b50',
    })
    expect(second.pieces[0]?.colors.fabric).toBe('#397c73')
    expect(catalog.images.tunic?.colors.trim).toBe('#e4c58b')

    const doll = resolveGraphic(
      catalog,
      'paper-doll',
      graphicAppearanceSchema.parse({
        slots: { tunic: { palette: 'royal', colors: { trim: '#ffffff' } } },
      }),
    )

    expect(doll.pieces.find((piece) => piece.layer === 'clothes')?.colors).toEqual(
      first.pieces[0]?.colors,
    )
  })

  it('binds part selection, visibility, presets, and individual colors with typed static fallbacks', () => {
    const state = { part: '', shown: true, material: 'bronze', fabric: '#123456' }
    const bus = new MessageBus<EngineMessages>()

    const bindings = new GameBindings(
      { state: () => state, progression: () => ({ turn: 0, worldTimeMs: 0 }) },
      bus,
    )

    const bind = (key: string) => ({ source: 'game.state', path: [key] })

    const appearance = graphicAppearanceSchema.parse({
      slots: {
        tunic: { colors: { fabric: '#abcdef' }, bindings: { colors: { fabric: bind('fabric') } } },
        sword: {
          palette: 'steel',
          bindings: { palette: bind('material'), visible: bind('shown') },
        },
        cloak: { partBinding: bind('part') },
      },
    })

    const first = resolveGraphic(catalog, 'paper-doll', appearance, bindings)
    expect(first.pieces.map((piece) => piece.layer)).not.toContain('rear')
    expect(first.pieces.find((piece) => piece.layer === 'clothes')?.colors.fabric).toBe('#123456')
    expect(first.pieces.find((piece) => piece.layer === 'sword')?.colors.blade).toBe('#b98249')
    state.part = 'cloak'
    state.shown = false
    expect(
      resolveGraphic(catalog, 'paper-doll', appearance, bindings).pieces.map(
        (piece) => piece.layer,
      ),
    ).toEqual(['rear', 'body', 'clothes', 'hands', 'clasp'])
    state.part = 'missing'
    state.material = 'missing'
    state.fabric = 'url(https://invalid)'
    state.shown = true
    const failed = resolveGraphic(catalog, 'paper-doll', appearance, bindings)
    expect(failed.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'tunic.fabric',
      'sword.palette',
      'cloak.part',
    ])
    expect(failed.pieces.find((piece) => piece.layer === 'clothes')?.colors.fabric).toBe('#abcdef')
    expect(failed.pieces.find((piece) => piece.layer === 'sword')?.colors.blade).toBe('#a5bbc8')
    bindings.dispose()
  })
})
