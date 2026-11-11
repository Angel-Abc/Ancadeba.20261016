import { gameIdSchema, languageTagSchema } from '@ancadeba/schemas'
import type { GameDefinition, WorkspaceListing } from '@ancadeba/schemas'
import { workspaceError, type WorkspaceService } from './workspace.js'

const resources = [
  ['scenes', 'scenes'],
  ['maps', 'maps'],
  ['inventory', 'inventory'],
  ['rules', 'rules'],
  ['dialogues', 'dialogues'],
  ['quests', 'quests'],
  ['leveling', 'leveling'],
  ['combat', 'combat'],
  ['combatLibraries', 'combat-libraries'],
  ['assets', 'assets'],
  ['input', 'input'],
] as const

export function hasRecoveryResources(listing: WorkspaceListing): boolean {
  const directories: readonly string[] = [
    ...resources.map(([, directory]) => directory),
    'languages',
  ]

  return listing.entries.some(
    (entry) => entry.type === 'directory' && directories.includes(entry.name),
  )
}

/** Suggest references from filenames only; no existing resource is changed or claimed to be valid. */
export async function suggestRecoveryManifest(
  workspace: Pick<WorkspaceService, 'list'>,
  folder: string,
  listing: WorkspaceListing,
): Promise<string> {
  const list = async (directory: string): Promise<WorkspaceListing['entries']> => {
    try {
      return (await workspace.list(folder ? `${folder}/${directory}` : directory)).entries
    } catch (error) {
      if (![400, 403, 404, 409].includes(workspaceError(error).status)) throw error

      return []
    }
  }

  const name = folder.split('/').at(-1) || 'recovered-game'

  const manifest: GameDefinition = {
    'schema-version': '1.0.0',
    id: gameIdSchema.safeParse(name).success ? name : 'recovered-game',
    title: name,
    description: '',
    version: '1.0.0',
    scenes: [],
  }

  for (const [field, directory] of resources) {
    const ids = (await list(directory))
      .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((id) => gameIdSchema.safeParse(id).success)
      .sort()

    if (field === 'assets' || field === 'input') {
      if (ids.length === 1) manifest[field] = ids[0]!
    } else if (ids.length) manifest[field] = ids
  }

  const stylesheets = listing.entries
    .filter((entry) => entry.type === 'file' && /^[a-zA-Z0-9_-]+\.css$/.test(entry.name))
    .map((entry) => entry.name)

  if (stylesheets.length === 1) manifest.stylesheet = stylesheets[0]!

  const languages = (await list('languages'))
    .filter(
      (entry) => entry.type === 'directory' && languageTagSchema.safeParse(entry.name).success,
    )
    .map((entry) => entry.name)
    .sort()

  if (languages.length)
    manifest.languages = {
      default: languages.includes('en') ? 'en' : languages[0]!,
      available: languages,
    }

  return `${JSON.stringify(manifest, null, 2)}\n`
}
