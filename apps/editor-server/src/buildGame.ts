import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const exportCommand = fileURLToPath(new URL('../../../tooling/export-game.ts', import.meta.url))

export async function buildGame(gameDirectory: string, outputDirectory: string): Promise<void> {
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
    { cwd: repositoryRoot, windowsHide: true, maxBuffer: 1024 * 1024 },
  )
}
