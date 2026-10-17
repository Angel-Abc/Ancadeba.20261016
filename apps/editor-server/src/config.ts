import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEditorServerConfig, type ConfigOverrides } from '@ancadeba/schemas'

export const editorServerConfigFile = new URL('../config.json', import.meta.url)

export async function loadEditorServerConfig(
  file = editorServerConfigFile,
  env: ConfigOverrides = process.env,
) {
  try {
    const config = parseEditorServerConfig(JSON.parse(await readFile(file, 'utf8')), env)
    return { ...config, workFolder: resolve(dirname(fileURLToPath(file)), config.workFolder) }
  } catch (error) {
    throw new Error(
      `Cannot load ${fileURLToPath(file)}. Copy config.example.json to config.json and check its settings.`,
      { cause: error },
    )
  }
}
