import { isIP } from 'node:net'

function hostName(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

function trustedHostName(name: string | undefined, configuredHost: string): boolean {
  return (
    name !== undefined &&
    (isIP(name) !== 0 ||
      name === 'localhost' ||
      name.endsWith('.localhost') ||
      name === configuredHost.toLowerCase())
  )
}

/**
 * DNS rebinding and cross-site requests need a foreign domain name, so the editor only answers
 * when it is addressed by an IP literal, a localhost name or its configured host, and when any
 * browser origin is one of those too.
 */
export function isTrustedRequest(
  headers: { host?: string | undefined; origin?: string | undefined },
  configuredHost: string,
): boolean {
  if (headers.host === undefined) return false

  if (!trustedHostName(hostName(`http://${headers.host}`), configuredHost)) return false

  return headers.origin === undefined || trustedHostName(hostName(headers.origin), configuredHost)
}
