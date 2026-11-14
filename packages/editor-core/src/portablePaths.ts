const reservedDeviceName =
  /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

/** One path segment that every supported filesystem, including Windows, can store. */
export function isPortablePathSegment(part: string): boolean {
  return (
    part.length > 0 &&
    part !== '.' &&
    part !== '..' &&
    !/[<>:"\\|?*]/.test(part) &&
    !/[. ]$/.test(part) &&
    part.split('').every((character) => character.charCodeAt(0) >= 32) &&
    !reservedDeviceName.test(part)
  )
}

const privateNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.codex',
  '.agents',
  'node_modules',
  '.ds_store',
  'thumbs.db',
])

/** Version control, dependencies, local secrets and editor state never leave their workspace. */
export function isPrivateProjectEntry(name: string): boolean {
  const lower = name.toLowerCase()

  return (
    privateNames.has(lower) ||
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.startsWith('.ancadeba-') ||
    lower.startsWith('.game-export-')
  )
}
