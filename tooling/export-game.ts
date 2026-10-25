import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exportGame } from './game-export.js'

const usage = `Usage: pnpm export:game <game-directory> [--out <output-directory>]

Packages the engine and saved game files into a static web game.
The default output is dist/games/<game-directory-name>.
The destination must not already exist.

Example: pnpm export:game sample-games/basic --out dist/games/basic
Serve the exported directory over HTTP(S) to play it.`

try {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(usage)
  } else {
    const gameDirectory = positionals[0]
    if (positionals.length !== 1 || !gameDirectory || values.out === '') {
      throw new Error(usage)
    }
    const result = await exportGame({
      gameDirectory,
      outputDirectory: values.out ?? resolve('dist/games', basename(resolve(gameDirectory))),
    })
    console.log(
      `Exported ${result.fileCount} game files and the engine to ${result.outputDirectory}`,
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
