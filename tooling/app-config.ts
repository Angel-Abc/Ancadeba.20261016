import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ConfigOverrides } from '@ancadeba/schemas'

export function loadAppConfig<T>(
  file: URL,
  parse: (value: unknown, env: ConfigOverrides) => T,
  env: ConfigOverrides = process.env,
): T {
  try {
    return parse(JSON.parse(readFileSync(file, 'utf8')), env)
  } catch (error) {
    throw new Error(
      `Cannot load ${fileURLToPath(file)}. Copy config.example.json to config.json and check its settings.`,
      { cause: error },
    )
  }
}
