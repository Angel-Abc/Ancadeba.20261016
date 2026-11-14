import { inflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { ZipFile } from 'yazl'
import {
  EditorError,
  projectArchivePathSchema,
  maxProjectArchiveBytes,
  maxProjectUnpackedBytes,
  maxProjectArchiveEntries,
} from '@ancadeba/editor-core'

const invalid = (message: string) => new EditorError(400, 'invalid_project_archive', message)

const tooLarge = () =>
  new EditorError(
    413,
    'project_archive_too_large',
    'Project ZIPs support at most 128 MiB compressed, 128 MiB unpacked, and 10000 entries',
  )

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index

  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1

  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff

  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)

  return (crc ^ 0xffffffff) >>> 0
}

/** Also protects Windows/case-insensitive destinations and implicit parent directories. */
function claimPath(
  paths: Map<string, { name: string; directory: boolean }>,
  name: string,
  directory: boolean,
) {
  if (!projectArchivePathSchema.safeParse(name).success)
    throw invalid(`Unsupported archive path: ${name}`)
  const parts = name.split('/')

  for (let index = 1; index <= parts.length; index++) {
    const path = parts.slice(0, index).join('/')
    const isDirectory = index < parts.length || directory
    const previous = paths.get(path.toLowerCase())

    if (previous && (previous.name !== path || !previous.directory || !isDirectory))
      throw invalid(`Conflicting archive paths: ${path}`)
    paths.set(path.toLowerCase(), { name: path, directory: isDirectory })
  }
}

/** ZIP32 stored/deflated entries only. No extraction occurs until every entry is validated. */
export function readProjectArchive(archive: Uint8Array): Record<string, Uint8Array> {
  if (archive.byteLength > maxProjectArchiveBytes) throw tooLarge()
  const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  let end = -1

  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (
      data.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + data.readUInt16LE(offset + 20) === data.length
    ) {
      end = offset
      break
    }
  }

  if (end < 0) throw invalid('The file is not a complete ZIP archive')
  const count = data.readUInt16LE(end + 10)
  const centralSize = data.readUInt32LE(end + 12)
  const centralStart = data.readUInt32LE(end + 16)

  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count ||
    centralStart + centralSize !== end
  )
    throw invalid('Split and ZIP64 archives are unsupported')

  if (!count) throw invalid('The ZIP contains no project files')

  if (count > maxProjectArchiveEntries) throw tooLarge()
  let offset = centralStart
  let unpacked = 0
  const paths = new Map<string, { name: string; directory: boolean }>()
  const names = new Set<string>()
  const files = new Map<string, Uint8Array>()
  const ranges: [number, number][] = []

  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50)
      throw invalid('Damaged ZIP directory')
    const flags = data.readUInt16LE(offset + 8)
    const method = data.readUInt16LE(offset + 10)
    const crc = data.readUInt32LE(offset + 16)
    const size = data.readUInt32LE(offset + 20)
    const originalSize = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const local = data.readUInt32LE(offset + 42)
    const attributes = data.readUInt32LE(offset + 38)
    const mode = (attributes >>> 16) & 0xf000
    const next = offset + 46 + nameLength + extraLength + commentLength

    if (
      next > end ||
      data.readUInt16LE(offset + 34) !== 0 ||
      size === 0xffffffff ||
      originalSize === 0xffffffff ||
      local === 0xffffffff
    )
      throw invalid('Damaged, split, or ZIP64 archive entry')

    if ((flags & ~0x80e) !== 0 || ![0, 8].includes(method))
      throw invalid('Encrypted or unsupported ZIP compression')

    if (![0, 0x4000, 0x8000].includes(mode))
      throw invalid('ZIP entries must be regular files or directories, never links')
    const encodedName = data.subarray(offset + 46, offset + 46 + nameLength)
    let name: string

    try {
      if (!(flags & 0x800) && encodedName.some((byte) => byte > 127))
        throw new Error('Legacy filename encoding')
      name = new TextDecoder('utf-8', { fatal: true }).decode(encodedName)
    } catch {
      throw invalid('Use UTF-8 ZIP filenames')
    }

    const directory = name.endsWith('/')

    if ((mode === 0x4000 && !directory) || (mode === 0x8000 && directory))
      throw invalid('Inconsistent ZIP entry type')
    const path = directory ? name.slice(0, -1) : name

    if (names.has(path.toLowerCase())) throw invalid(`Duplicate archive entry: ${path}`)
    names.add(path.toLowerCase())
    claimPath(paths, path, directory)

    if (paths.size > maxProjectArchiveEntries) throw tooLarge()
    unpacked += originalSize

    if (unpacked > maxProjectUnpackedBytes) throw tooLarge()

    if (
      local + 30 > centralStart ||
      data.readUInt32LE(local) !== 0x04034b50 ||
      data.readUInt16LE(local + 6) !== flags ||
      data.readUInt16LE(local + 8) !== method
    )
      throw invalid('Damaged ZIP file header')
    const localNameLength = data.readUInt16LE(local + 26)
    const localExtraLength = data.readUInt16LE(local + 28)
    const start = local + 30 + localNameLength + localExtraLength
    const stop = start + size

    if (
      stop > centralStart ||
      !encodedName.equals(data.subarray(local + 30, local + 30 + localNameLength))
    )
      throw invalid('Inconsistent ZIP filename or file length')

    if (
      !(flags & 8) &&
      (data.readUInt32LE(local + 14) !== crc ||
        data.readUInt32LE(local + 18) !== size ||
        data.readUInt32LE(local + 22) !== originalSize)
    )
      throw invalid('Inconsistent ZIP file sizes')
    let entryEnd = stop

    if (flags & 8) {
      const descriptor = [stop + 4, stop].find(
        (position) =>
          position + 12 <= centralStart &&
          (position === stop || data.readUInt32LE(stop) === 0x08074b50) &&
          data.readUInt32LE(position) === crc &&
          data.readUInt32LE(position + 4) === size &&
          data.readUInt32LE(position + 8) === originalSize,
      )

      if (descriptor === undefined) throw invalid('Damaged ZIP data descriptor')
      entryEnd = descriptor + 12
    }

    ranges.push([local, entryEnd])
    let contents: Uint8Array

    try {
      // maxOutputLength bounds allocation even when a malicious ZIP lies about its expanded size.
      contents =
        method === 0
          ? data.subarray(start, stop)
          : inflateRawSync(data.subarray(start, stop), {
              maxOutputLength: Math.max(1, originalSize),
            })
    } catch {
      throw invalid(`Damaged or oversized compressed entry: ${path}`)
    }

    if (
      contents.length !== originalSize ||
      crc32(contents) !== crc ||
      (directory && originalSize !== 0)
    )
      throw invalid(`Damaged ZIP data: ${path}`)

    if (!directory) files.set(path, contents)
    offset = next
  }

  if (offset !== end) throw invalid('Unexpected ZIP directory data')
  ranges.sort(([a], [b]) => a - b)

  for (let index = 1; index < ranges.length; index++)
    if (ranges[index]![0] < ranges[index - 1]![1]) throw invalid('Overlapping ZIP entries')

  if (files.has('game.json')) return Object.fromEntries(files)
  const wrapper = [...files.keys()][0]?.split('/')[0]
  const lowerWrapper = wrapper?.toLowerCase()

  if (
    wrapper &&
    files.has(`${wrapper}/game.json`) &&
    [...names].every((name) => name === lowerWrapper || name.startsWith(`${lowerWrapper}/`))
  )
    return Object.fromEntries(
      [...files].map(([path, bytes]) => [path.slice(wrapper.length + 1), bytes]),
    )
  throw invalid('Place game.json at the ZIP root or inside a single containing folder')
}

export async function writeProjectArchive(
  files: Readonly<Record<string, Uint8Array>>,
): Promise<Uint8Array> {
  const zip = new ZipFile()
  const output = zip.outputStream

  if (!(output instanceof Readable)) throw new TypeError('ZIP output must be readable')
  zip.on('error', (error: Error) => output.destroy(error))
  const paths = new Map<string, { name: string; directory: boolean }>()
  const entries = Object.entries(files)
  let unpacked = 0

  for (const [name, bytes] of entries) {
    claimPath(paths, name, false)
    unpacked += bytes.length
  }

  if (paths.size > maxProjectArchiveEntries || unpacked > maxProjectUnpackedBytes) throw tooLarge()

  for (const [name, bytes] of entries) zip.addBuffer(Buffer.from(bytes), name)
  zip.end()
  const chunks: Buffer[] = []
  let size = 0

  try {
    for await (const chunk of output) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('ZIP output must contain bytes')
      const bytes = chunk
      size += bytes.length

      if (size > maxProjectArchiveBytes) throw tooLarge()
      chunks.push(bytes)
    }
  } finally {
    output.destroy()
  }

  return Buffer.concat(chunks, size)
}
