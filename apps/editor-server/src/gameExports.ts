import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { WorkspaceError } from './workspace.js'

export interface GameExportArchive {
  filePath: string
  fileName: string
  size: number
  dispose(): Promise<void>
}

export interface GameExportService {
  create(path: string): Promise<GameExportArchive>
}

interface GameDirectoryResolver {
  resolveDirectory(path: string): Promise<string>
}

export class WorkspaceGameExporter implements GameExportService {
  private busy = false

  constructor(
    private readonly workspace: GameDirectoryResolver,
    private readonly buildGame: (source: string, output: string) => Promise<void>,
    private readonly writeArchive: (source: string, output: string) => Promise<void>,
    private readonly temporaryRoot = tmpdir(),
  ) {}

  async create(path: string): Promise<GameExportArchive> {
    if (this.busy)
      throw new WorkspaceError(409, 'An export is already running. Please try again shortly.')
    this.busy = true
    let temporary: string | undefined
    let disposed = false
    const cleanup = async () => {
      if (disposed) return
      disposed = true
      try {
        if (temporary) {
          const target = resolve(temporary)
          if (
            dirname(target) !== resolve(this.temporaryRoot) ||
            !basename(target).startsWith('ancadeba-export-')
          ) {
            throw new Error('Unexpected export temporary directory')
          }
          await rm(target, { recursive: true, force: true })
        }
      } finally {
        this.busy = false
      }
    }

    try {
      const gameDirectory = await this.workspace.resolveDirectory(path)
      temporary = await mkdtemp(join(this.temporaryRoot, 'ancadeba-export-'))
      const output = join(temporary, 'game')
      try {
        await this.buildGame(gameDirectory, output)
      } catch {
        throw new WorkspaceError(
          422,
          'Could not export the game. Check game.json and the game assets.',
        )
      }
      const filePath = join(temporary, 'game.zip')
      await this.writeArchive(output, filePath)
      const name =
        basename(gameDirectory)
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .slice(0, 80) || 'game'
      const size = (await stat(filePath)).size
      return { filePath, fileName: `${name}.zip`, size, dispose: cleanup }
    } catch (error) {
      await cleanup()
      throw error
    }
  }
}
