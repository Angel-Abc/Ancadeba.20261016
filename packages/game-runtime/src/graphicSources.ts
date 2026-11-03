import { SaxesParser } from 'saxes'
import type { GraphicBounds, ImageAsset } from '@ancadeba/schemas'

interface SvgNode {
  name: string
  attributes: Record<string, string>
  children: (SvgNode | string)[]
}

export interface PreparedSvg {
  readonly root: SvgNode
  readonly bounds: GraphicBounds
  readonly colors: Readonly<Record<string, string>>
}

const tags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'title',
  'desc',
])

const attributes = new Set(
  'xmlns xmlns:xlink version id viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry fx fy fr width height d points transform fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity vector-effect clip-path clip-rule mask maskUnits maskContentUnits clipPathUnits gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity href xlink:href color'.split(
    ' ',
  ),
)

const slotPattern = /var\(\s*--([a-zA-Z0-9_-]+)\s*,\s*(#[0-9a-fA-F]{6})\s*\)/g

export function parseGraphicSvg(source: string): PreparedSvg {
  if (source.length > 10 * 1024 * 1024) throw new Error('SVG exceeds the 10 MiB limit')
  const parser = new SaxesParser({ xmlns: true })
  const stack: SvgNode[] = []
  const colors: Record<string, string> = {}
  const ids = new Set<string>()
  const references: string[] = []
  let root: SvgNode | undefined
  let count = 0
  parser.on('doctype', () => {
    throw new Error('SVG DTDs are unsupported')
  })
  parser.on('processinginstruction', () => {
    throw new Error('SVG processing instructions are unsupported')
  })
  parser.on('opentag', (tag) => {
    if (++count > 20000 || stack.length > 128) throw new Error('SVG is too complex')

    if (tag.uri !== 'http://www.w3.org/2000/svg' || !tags.has(tag.local))
      throw new Error(`Unsupported SVG element: ${tag.name}`)
    const node: SvgNode = { name: tag.local, attributes: {}, children: [] }

    for (const attribute of Object.values(tag.attributes)) {
      const { name, value } = attribute

      if (!attributes.has(name) || /^on/i.test(name))
        throw new Error(
          `Unsupported SVG attribute: ${name}; use presentation attributes instead of styles`,
        )

      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg')
        throw new Error('Invalid SVG namespace')

      if (name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink')
        throw new Error('Invalid SVG link namespace')

      if (name === 'href' || name === 'xlink:href') {
        if (!/^#[a-zA-Z_][\w.-]*$/.test(value))
          throw new Error('SVG references must be local fragment IDs')
        references.push(value.slice(1))
      }

      if (/url\s*\(/i.test(value)) {
        const local = /^url\(\s*#([a-zA-Z_][\w.-]*)\s*\)$/.exec(value)

        if (!local) throw new Error('SVG paint references must be local fragment IDs')
        references.push(local[1]!)
      }

      if (name === 'id') {
        if (!/^[a-zA-Z_][\w.-]*$/.test(value) || ids.has(value))
          throw new Error(`Invalid or duplicate SVG ID: ${value}`)
        ids.add(value)
      }

      if (value.includes('var(')) {
        if (
          !['fill', 'stroke', 'stop-color', 'color'].includes(name) ||
          !/^var\(\s*--[a-zA-Z0-9_-]+\s*,\s*#[0-9a-fA-F]{6}\s*\)$/.test(value)
        )
          throw new Error('Color slots require var(--slot, #RRGGBB) in paint attributes')

        for (const match of value.matchAll(slotPattern)) {
          const slot = match[1]!
          const color = match[2]!.toLowerCase()

          if (Object.hasOwn(colors, slot) && colors[slot] !== color)
            throw new Error(`Conflicting SVG defaults for slot ${slot}`)
          Object.defineProperty(colors, slot, {
            value: color,
            enumerable: true,
            configurable: true,
          })
        }
      }

      Object.defineProperty(node.attributes, name, { value, enumerable: true, configurable: true })
    }

    if (stack.length) stack.at(-1)!.children.push(node)
    else {
      if (root || tag.local !== 'svg') throw new Error('Expected one SVG root')
      root = node
    }

    stack.push(node)
  })
  parser.on('text', (value) => {
    if (value.trim() && !['title', 'desc'].includes(stack.at(-1)?.name ?? ''))
      throw new Error('Convert SVG text to paths')
    stack.at(-1)?.children.push(value)
  })
  parser.on('closetag', () => {
    stack.pop()
  })
  parser.write(source).close()

  if (!root) throw new Error('Missing SVG root')

  for (const reference of references)
    if (!ids.has(reference)) throw new Error(`Missing SVG definition: ${reference}`)

  const box = root.attributes.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)

  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0)
    throw new Error('SVG requires a finite, positive viewBox')

  return { root, bounds: { x: box[0]!, y: box[1]!, width: box[2]!, height: box[3]! }, colors }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function prepareGraphicSvg(
  svg: PreparedSvg,
  colors: Readonly<Record<string, string>>,
): string {
  for (const [slot, color] of Object.entries(colors)) {
    if (!Object.hasOwn(svg.colors, slot) || !/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error(`Invalid SVG color override: ${slot}`)
  }

  const serialize = (node: SvgNode | string): string => {
    if (typeof node === 'string') return escapeXml(node)

    const attributes = Object.entries(node.attributes)
      .map(([name, value]) => {
        const resolved = value.replace(
          slotPattern,
          (_match, slot: string, fallback: string) => colors[slot] ?? fallback,
        )

        return ` ${name}="${escapeXml(resolved)}"`
      })
      .join('')

    return `<${node.name}${attributes}>${node.children.map(serialize).join('')}</${node.name}>`
  }

  return serialize(svg.root)
}

export interface ImageSourceInfo {
  bounds: GraphicBounds
  colors: Record<string, string>
  svg?: PreparedSvg
}

export function inspectImageSource(
  format: ImageAsset['format'],
  bytes: Uint8Array,
  text = '',
): ImageSourceInfo {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MiB limit')

  if (format === 'svg') {
    const svg = parseGraphicSvg(text)

    return { bounds: svg.bounds, colors: { ...svg.colors }, svg }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length))

  let width = 0
  let height = 0

  if (
    format === 'png' &&
    bytes.length >= 33 &&
    ascii(1, 3) === 'PNG' &&
    bytes[0] === 137 &&
    ascii(12, 4) === 'IHDR'
  ) {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (format === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2

    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]!

      if (marker === 217 || marker === 218) break
      const length = view.getUint16(offset + 2)

      if (length < 2 || offset + 2 + length > bytes.length) break

      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(offset + 5)
        width = view.getUint16(offset + 7)
        break
      }

      offset += length + 2
    }
  } else if (
    format === 'webp' &&
    bytes.length >= 30 &&
    ascii(0, 4) === 'RIFF' &&
    ascii(8, 4) === 'WEBP'
  ) {
    const chunk = ascii(12, 4)

    if (chunk === 'VP8X') {
      if ((bytes[20]! & 2) !== 0) throw new Error('Animated WebP is unsupported')
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
    } else if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383
      height = view.getUint16(28, true) & 16383
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true)
      width = (bits & 16383) + 1
      height = ((bits >>> 14) & 16383) + 1
    }
  }

  if (!width || !height) throw new Error(`Invalid or unsupported ${format} image`)

  return { bounds: { x: 0, y: 0, width, height }, colors: {} }
}

export function validateImageSource(
  image: ImageAsset,
  bytes: Uint8Array,
  text = '',
): ImageSourceInfo {
  const info = inspectImageSource(image.format, bytes, text)

  if (
    (['x', 'y', 'width', 'height'] as const).some((key) => image.bounds[key] !== info.bounds[key])
  )
    throw new Error('Image bounds do not match its source')

  if (Object.keys(info.colors).sort().join(',') !== Object.keys(image.colors).sort().join(','))
    throw new Error('Declared color slots do not match the SVG source')

  return info
}
