# Shared editor layer v1

The visual editor and external agents edit an existing game through the same
revision-checked HTTP API. The editor core depends on the existing schemas and
Zod. It does not import the engine runtime, browser APIs, or Node APIs.

## Packages and services

- `packages/editor-core`: request schemas, source project documents, queries,
  validation, and pure editing commands.
- `apps/editor-server/src/editorProjectService.ts`: coordinates requests,
  checks revisions, applies commands, and saves changes.
- `apps/editor-server/src/editorProjectRepository.ts`: reads source JSON,
  computes content revisions, and persists changed documents.
- `apps/editor-server/src/editorCoordinator.ts`: serializes commands and
  legacy file-API reads/writes within one server instance.
- `apps/editor-ui/src/projectController.ts`: UI workflow with an injected client.
- `apps/editor-ui/src/editorClient.ts`: HTTP adapter.
- `apps/editor-ui/src/projectPanel.ts`: DOM bindings and local form drafts.

The editable project retains source definitions, including schema versions and
extension properties. Runtime GameData and mutable playthrough state remain
separate. The engine, game schemas, preview controller, and export controller are
unchanged.

## Supported operations

Each request contains one command. Metadata commands supply all listed fields.

| Command                    | Fields                                               |
| -------------------------- | ---------------------------------------------------- |
| `game.updateMetadata`      | `title`, `description`, `version`                    |
| `scene.create`             | A complete `scene` matching the current scene schema |
| `scene.updateMetadata`     | `sceneId`, `title`, `description`                    |
| `scene.updateLayout`       | `sceneId`, positive integer `rows` and `columns`     |
| `assets.upsertImage`       | `id`, complete `image` definition                    |
| `assets.upsertPart`        | `id`, complete `part` definition                     |
| `assets.upsertComposition` | `id`, complete `composition` definition              |
| `assets.remove`            | `kind` (`images`, `parts`, or `compositions`), `id`  |
| `scene.upsertGraphic`      | `sceneId`, complete graphic `component`              |
| `scene.removeGraphic`      | `sceneId`, `componentId`                             |

Scene creation updates both the scene document and the manifest reference.
Existing IDs cannot be changed. Scenes support text, buttons, language selectors,
and graphics; the focused graphic commands edit only graphic components.
Input definitions are loaded and validated but cannot be edited through commands.

Graphic components can be created, edited, and removed without changing other
component types. The first asset operation initializes `assets.json` and its
manifest reference. Inspection includes the parsed catalogue as `assets` when
present. See [the graphics guide](asset-workshop.md) for source and composition
formats, palettes, and game-state bindings.

`POST /api/editor/assets/import` accepts multipart fields `metadata` (JSON with
`path`, `expectedRevision`, `id`, and `format`) and `file` (bytes). The entire
request is limited to 10 MiB, including multipart overhead. Source files are
created under unique names before definitions are published. Replacing artwork
retains compatible defaults and presets and never overwrites the previous source.
An uncertain save reports the new source path; inspect before retrying. A failed
publication can leave an unreferenced source, which is not automatically deleted.

## HTTP contract

All paths are relative to the configured editor-server workspace, using forward
slashes. An empty project path selects the workspace root. Existing workspace
path restrictions also apply to editor routes.

| Endpoint                                   | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `GET /api/editor/capabilities`             | API version, JSON Schema for requests, supported commands and examples |
| `GET /api/editor/project?path=basic`       | Revision, game definition, scene definitions, diagnostics              |
| `GET /api/editor/scene?path=basic&id=shop` | Revision, scene definition, diagnostics                                |
| `POST /api/editor/commands`                | Updated project view, changed files, readable change summary           |

Editing requests require `Content-Type: application/json`. Responses are not
cached. First inspect the project, then use its opaque revision when editing:

```json
{
  "path": "basic",
  "expectedRevision": "<revision returned by project inspection>",
  "command": {
    "type": "scene.updateLayout",
    "sceneId": "shop",
    "rows": 18,
    "columns": 24
  }
}
```

PowerShell example for an external agent or developer:

```powershell
$project = Invoke-RestMethod 'http://127.0.0.1:3100/api/editor/project?path=basic'
$body = @{
  path = 'basic'
  expectedRevision = $project.revision
  command = @{
    type = 'game.updateMetadata'
    title = 'My game'
    description = 'Created through the shared editor'
    version = '1.0.0'
  }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod 'http://127.0.0.1:3100/api/editor/commands' `
  -Method Post -ContentType 'application/json' -Body $body
```

Command errors return `error`, `code`, and `diagnostics`. Each diagnostic has
`code`, game-relative `file`, property `path`, and `message`. Workspace transport
errors retain the existing file API's status and error-message conventions.

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| 400    | Invalid request, command, JSON, or workspace path |
| 403    | Access outside the workspace or through links     |
| 404    | Project or requested scene not found              |
| 409    | Stale revision or an existing scene destination   |
| 413    | Request exceeds the existing 10 MiB limit         |
| 415    | Unsupported request content type                  |
| 422    | Project validation failed; no command was saved   |
| 500    | Storage or cleanup failure                        |

Project inspection reports malformed JSON and missing referenced files as
diagnostics. A missing project manifest is a 404. Commands require a valid
project; repair invalid source files externally before retrying.

## Revisions and persistence

Revisions hash the exact bytes of the manifest, referenced scenes, and referenced
input file. They survive server restarts and detect direct file edits, including
formatting changes. Unreferenced files do not affect the revision. Asset catalogues
and all registered image source bytes do affect it. Inspection validates source
bounds, format, SVG profile, and color-slot declarations. Replacing or unregistering
an unused broken image is permitted as a targeted repair; the resulting project
must be valid.

Server commands and raw file-API writes use one queue per server. Competing
commands based on the same revision cannot overwrite each other silently.
Separate server processes and external filesystem programs do not share this
queue. Changes saved before the revision check are detected; writes racing after
that check are not protected by filesystem compare-and-swap.

Successful commands save immediately. Single-document changes use the workspace's
atomic replacement. Scene creation publishes complete scene bytes using an
exclusive hard link from a temporary file, then replaces the manifest last.
Filesystems must support hard links. An existing destination, including an
unreferenced orphan, is never overwritten.

A normal manifest-save failure first checks whether publication already succeeded.
If the saved manifest matches the intended bytes, the command succeeds. Otherwise,
rollback removes the new scene only when the manifest is valid, no longer references
it, and the scene bytes still match. If those checks or cleanup fail, the scene is
retained and the error asks the caller to reload before retrying. A process crash
before manifest publication can also leave an orphan. The manifest must never
reference a partially created scene. This is not a general multi-file transaction
or crash-recovery journal.

## Visual editor

The editor starts with only the Project explorer visible. Enter the game folder
and select Load project. The folder and load controls collapse after opening a
project, and the navigation tree remains visible. Use Open another project to
show the folder controls again.
The searchable tree contains Game properties, Scenes with their components,
and Assets grouped into Images, Parts, and Compositions. Scene types and the
startup scene are labeled. Shared assets appear once in the asset library.

Select an entry to open its editing controls. Scene branches include Add graphic;
Scenes includes Add scene; Assets includes image import and definition creation.
Asset groups display filtered thumbnail galleries. Selecting a thumbnail also
selects and reveals the corresponding tree entry. Components other than graphics
currently display read-only definitions. Engine preview is collapsible and has an
independent selection and lifetime; project navigation never starts a playthrough
or changes its active scene.

Use Up/Down and Home/End to move keyboard focus, Right/Left to expand or collapse
branches, and Enter/Space to select. Search retains matching entries' ancestor
paths. Expansion and selection survive project refreshes during the editor session.
The sidebar can be resized horizontally on desktop and stacks above the workspace
on narrow screens. English and Dutch labels follow the editor language.

Each form saves independently; saving one form preserves drafts in other forms.
Save pending scene edits before selecting a different scene, and asset/graphic
edits before selecting another asset/graphic target. Blocked navigation preserves
the current selection and form entries and explains which action is needed.
Unrelated panels can be visited without discarding drafts.

### Extending the project explorer

`apps/editor-ui/src/projectTree.ts` builds navigation from injected
`ProjectTreeSection` providers. Each provider supplies a unique section ID,
a translated label key, and nodes with stable globally unique keys. This model
has no browser dependencies and stores definitions rather than runtime instances.
`projectTreeView.ts` handles searching, expansion, focus, and selection independently
of resource types.

To add a system such as maps, actors, items, dialogs, or scripts, supply a
`ProjectWorkspaceSection` to the final `bindProjectPanel` argument. It extends the
tree provider with `show(node, view)` and `hide()` callbacks for that system's
workspace. The workspace must preserve its drafts across show/hide calls and use
the shared revision-checked editing API when authoring commands become available.
Its optional `canSelect(node)` guard can refuse a selection that would replace
unsaved values.
No tree renderer change is needed. Future world and narrative definitions belong
in their own sections; scenes remain screen layouts that reference shared content.

On a revision conflict, entries remain intact. Reload latest (keep entries) refreshes
clean forms and preserves dirty forms. Review the intended values, then save again.
If the selected scene has been removed externally, its draft is never reassigned
to another scene; load the project afresh to discard it. Loading a project afresh
replaces all form values.

Returning focus to the window refreshes clean forms; dirty forms retain their
original revision and show that saved files changed. Draft state is checked when
the background read completes, so text entered during that read is preserved.
Background reads do not block saves and cannot replace a newer save or project load.

The existing preview and export continue reading saved files. Restart preview
to see edits. Neither a running preview nor export is pinned to an editor revision.

## Development and verification

Use an independent worktree. Install its dependencies and copy each app's
`config.example.json` to its local ignored `config.json`. For agent instances,
scope port overrides to each process:

```powershell
$env:PORT = '3100'
pnpm --filter @ancadeba/editor-server dev
```

In a separate terminal:

```powershell
$env:EDITOR_UI_PORT = '5274'
$env:EDITOR_SERVER_URL = 'http://127.0.0.1:3100'
pnpm --filter @ancadeba/editor-ui dev
```

Tests are in `tests/editor-core.test.ts`,
`tests/editor-project-api.test.ts`, and
`tests/editor-project-controller.test.ts`, and `tests/editor-project-panel.test.ts`.
Run `pnpm lint`, `pnpm test`,
`pnpm typecheck`, and `pnpm build`.

V1 does not include new-project creation, deletion, ID changes, input editing,
commands to edit existing non-graphic components, scripts, batches, undo history, real-time
collaboration, live preview updates, or embedded chat. New scenes can include
text components using the engine's shared scene schema; existing components and
bindings are preserved by metadata and layout edits. The visual panel creates
empty scenes. The [MCP adapter](editor-mcp.md) exposes these same HTTP operations
to an external coding agent.
