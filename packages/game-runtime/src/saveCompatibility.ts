/** Stable content identity for compatibility checks, not an authenticity or security checksum. */
export function saveCompatibility(text: string): string {
  let first = 2166136261
  let second = 3339675911

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }

  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
