import { parseEngineRuntimeConfig, type EngineRuntimeConfig } from '@ancadeba/schemas'

export async function loadRuntimeConfig(
  applicationUrl: string,
  fetcher: typeof fetch,
): Promise<EngineRuntimeConfig> {
  const response = await fetcher(new URL('config.json', applicationUrl).href, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Cannot load engine config.json: HTTP ${response.status}`)
  }
  return parseEngineRuntimeConfig(await response.json())
}
