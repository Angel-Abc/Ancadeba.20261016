import type { ProjectChoice } from '@ancadeba/editor-core'
import { workspaceError, type WorkspaceService } from './workspace.js'

function manifestTitle(bytes: Uint8Array): string {
  try {
    const manifest: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))

    if (
      manifest &&
      typeof manifest === 'object' &&
      'title' in manifest &&
      typeof manifest.title === 'string'
    ) {
      return manifest.title.trim()
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }

  return ''
}

function unavailable(error: unknown): boolean {
  return [400, 403, 404, 409].includes(workspaceError(error).status)
}

export async function listWorkspaceProjects(
  workspace: Pick<WorkspaceService, 'list' | 'read'>,
): Promise<ProjectChoice[]> {
  const pending = ['']
  const projects: ProjectChoice[] = []

  for (const path of pending) {
    const prefix = path ? `${path}/` : ''
    let listing

    try {
      listing = await workspace.list(path)
    } catch (error) {
      if (!path || !unavailable(error)) throw error

      continue
    }

    const { entries } = listing

    for (const entry of entries) {
      if (entry.type === 'directory') pending.push(prefix + entry.name)
    }

    if (!entries.some((entry) => entry.type === 'file' && entry.name === 'game.json')) continue

    try {
      const manifest = await workspace.read(prefix + 'game.json')
      projects.push({ path, title: manifestTitle(manifest) })
    } catch (error) {
      if (!unavailable(error)) throw error
    }
  }

  return projects.sort((a, b) => a.path.localeCompare(b.path))
}
