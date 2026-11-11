import type { Diagnostic, EditorCommand, ProjectSnapshot } from '@ancadeba/editor-core'

/** Only an image repair may retain already-known failures belonging to other images. */
export function blockingAssetDiagnostics(
  current: ProjectSnapshot,
  command: EditorCommand,
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  if (
    command.type !== 'assets.upsertImage' &&
    !(command.type === 'assets.remove' && command.kind === 'images')
  )
    return [...diagnostics]

  const previous = new Set(
    (current.sourceDiagnostics ?? [])
      .filter(
        (issue) =>
          issue.code === 'invalid_asset_source' &&
          issue.path[0] === 'images' &&
          typeof issue.path[1] === 'string' &&
          issue.path[1] !== command.id,
      )
      .map((issue) => JSON.stringify([issue.file, issue.path])),
  )

  return diagnostics.filter(
    (issue) =>
      issue.code !== 'invalid_asset_source' ||
      !previous.has(JSON.stringify([issue.file, issue.path])),
  )
}
