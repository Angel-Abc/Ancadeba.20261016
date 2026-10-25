import { createWriteStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'

export async function writeGameArchive(source: string, destination: string): Promise<void> {
  const zip = new ZipFile()
  const output = zip.outputStream as Readable
  zip.on('error', (error: Error) => output.destroy(error))
  const completed = pipeline(output, createWriteStream(destination, { flags: 'wx' }))
  // Handle early stream failures while file metadata is still being collected.
  void completed.catch(() => {})

  async function addDirectory(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory)
    if (prefix && entries.length === 0) zip.addEmptyDirectory(prefix)
    for (const name of entries.sort()) {
      const path = join(directory, name)
      const archivePath = prefix ? `${prefix}/${name}` : name
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Archive entries must not be links')
      if (info.isDirectory()) await addDirectory(path, archivePath)
      else if (info.isFile()) zip.addFile(path, archivePath)
      else throw new Error('Archive entries must be regular files or directories')
    }
  }

  try {
    await addDirectory(source, '')
    zip.end()
    await completed
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)))
    await completed.catch(() => {})
    throw error
  }
}
