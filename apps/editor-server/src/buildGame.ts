import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WorkspaceError } from './workspace.js'

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const exportCommand = fileURLToPath(new URL('../../../tooling/export-game.ts', import.meta.url))

// Matches the longest wait an MCP client may request for an export.
const buildTimeoutMs = 5 * 60 * 1000

export async function buildGame(gameDirectory: string, outputDirectory: string): Promise<void> {
  try {
    await execute(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        exportCommand,
        gameDirectory,
        '--out',
        outputDirectory,
      ],
      {
        cwd: repositoryRoot,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: buildTimeoutMs,
      },
    )
  } catch (error) {
    // A timeout kills the build without an exit code; an output overflow carries its own code.
    if (
      error instanceof Error &&
      'killed' in error &&
      error.killed === true &&
      !('code' in error && typeof error.code === 'string')
    )
      throw new WorkspaceError(504, 'The export build did not finish within 5 minutes')
    throw error
  }
}
