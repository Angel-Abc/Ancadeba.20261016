import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { build } from 'vite-plus'
import { engineRuntimeConfigPlugin } from '../apps/engine/tooling/config.js'

export interface GameExportOptions {
  gameDirectory: string
  outputDirectory: string
}

export interface GameExportResult {
  outputDirectory: string
  fileCount: number
}

const engineRoot = fileURLToPath(new URL('../apps/engine/', import.meta.url))
const excludedNames = new Set(['.git', '.hg', '.svn', 'node_modules', '.DS_Store', 'Thumbs.db'])
const validationLogger: ILogger = {
  debug: () => '',
  info: () => '',
  warn: () => '',
  error: () => '',
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT') || dirname(path) === path) throw error
    return join(await canonicalPath(dirname(path)), basename(path))
  }
}

async function requireNewDestination(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  throw new Error(`Export destination already exists: ${path}. Choose a new output directory.`)
}

async function copyGame(source: string, destination: string): Promise<number> {
  await mkdir(destination)
  const entries = await readdir(source)
  let fileCount = 0
  for (const name of entries.sort()) {
    if (excludedNames.has(name) || name === '.env' || name.startsWith('.env.')) continue
    const from = join(source, name)
    const to = join(destination, name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error(`Game exports cannot contain links: ${from}`)
    if (info.isDirectory()) {
      fileCount += await copyGame(from, to)
    } else if (info.isFile()) {
      await copyFile(from, to)
      fileCount++
    } else {
      throw new Error(`Game exports only support regular files and directories: ${from}`)
    }
  }
  return fileCount
}

export async function exportGame(options: GameExportOptions): Promise<GameExportResult> {
  const source = resolve(options.gameDirectory)
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error('The game source must be a directory, not a file or link')
  }
  const gameDirectory = await realpath(source)
  const outputDirectory = await canonicalPath(resolve(options.outputDirectory))
  if (contains(gameDirectory, outputDirectory) || contains(outputDirectory, gameDirectory)) {
    throw new Error('The game source and export destination must not overlap')
  }
  await requireNewDestination(outputDirectory)

  const parent = dirname(outputDirectory)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, '.game-export-'))
  try {
    const fileCount = await copyGame(gameDirectory, join(staging, 'game'))
    try {
      const source = {
        readText: (path: string) => readFile(join(staging, 'game', path), 'utf8'),
        readBytes: async (path: string) =>
          new Uint8Array(await readFile(join(staging, 'game', path))),
      }
      await new GameLoader(new JsonResourceLoader(source, validationLogger)).load()
    } catch (error) {
      throw new Error(
        'Cannot export game: game.json, a referenced scene, or input definition is missing, malformed, or invalid',
        {
          cause: error,
        },
      )
    }

    await build({
      configFile: false,
      envDir: false,
      root: engineRoot,
      base: './',
      publicDir: false,
      plugins: [engineRuntimeConfigPlugin('./game/')],
      build: {
        outDir: staging,
        emptyOutDir: false,
        sourcemap: false,
      },
    })

    await requireNewDestination(outputDirectory)
    await rename(staging, outputDirectory)
    return { outputDirectory, fileCount }
  } finally {
    // Only remove the temporary sibling created for this export.
    if (contains(parent, staging) && basename(staging).startsWith('.game-export-')) {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
