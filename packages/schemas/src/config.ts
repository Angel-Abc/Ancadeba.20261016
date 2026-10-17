export interface EngineConfig {
  gameUrl: string
  port: number
}

export interface EngineRuntimeConfig {
  gameUrl: string
}

export interface EditorUiConfig {
  port: number
  editorServerUrl: string
}

export interface EditorServerConfig {
  workFolder: string
  host: string
  port: number
}

export type ConfigOverrides = Readonly<Record<string, string | undefined>>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Configuration must be a JSON object')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

function port(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('port must be an integer between 1 and 65535')
  }
  return parsed
}

function httpUrl(value: unknown, key: string): string {
  const result = text(value, key)
  const match =
    /^https?:\/\/(\[[a-f\d:.]+\]|[^\s/\\?#:@%[\]]+)(?::(\d+))?(?:[/?#][^\s\\]*)?$/i.exec(result)
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) {
    throw new Error(`${key} must be an HTTP(S) URL`)
  }
  return result
}

export function parseEngineRuntimeConfig(value: unknown): EngineRuntimeConfig {
  const config = object(value)
  const gameUrl = text(config.gameUrl, 'gameUrl')
  if (
    gameUrl !== gameUrl.trim() ||
    /[\\\s?#]/.test(gameUrl) ||
    gameUrl.startsWith('//') ||
    (/^[\w+.-]+:/.test(gameUrl) && !/^https?:\/\//i.test(gameUrl))
  ) {
    throw new Error('gameUrl must be an HTTP(S) URL or a relative web directory path')
  }
  if (/^https?:/i.test(gameUrl)) httpUrl(gameUrl, 'gameUrl')
  return { gameUrl }
}

export function parseEngineConfig(value: unknown, env: ConfigOverrides = {}): EngineConfig {
  const config = object(value)
  return {
    ...parseEngineRuntimeConfig(config),
    port: port(env.ENGINE_PORT ?? config.port ?? 5173),
  }
}

export function parseEditorUiConfig(value: unknown, env: ConfigOverrides = {}): EditorUiConfig {
  const config = object(value)
  return {
    port: port(env.EDITOR_UI_PORT ?? config.port ?? 5174),
    editorServerUrl: httpUrl(
      env.EDITOR_SERVER_URL ?? config.editorServerUrl ?? 'http://127.0.0.1:3000',
      'editorServerUrl',
    ),
  }
}

export function parseEditorServerConfig(
  value: unknown,
  env: ConfigOverrides = {},
): EditorServerConfig {
  const config = object(value)
  return {
    workFolder: text(config.workFolder, 'workFolder'),
    host: text(env.HOST ?? config.host ?? '127.0.0.1', 'host'),
    port: port(env.PORT ?? config.port ?? 3000),
  }
}

export interface WorkspaceEntry {
  name: string
  type: 'file' | 'directory'
}

export interface WorkspaceListing {
  entries: WorkspaceEntry[]
}
