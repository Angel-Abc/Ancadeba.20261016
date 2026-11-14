# Editor MCP adapter

The adapter exposes the shared editor command layer to a local MCP host. It
runs as a separate stdio process and calls the same editor HTTP server as the
visual editor. The editor server remains responsible for revision checks,
validation, coordinating writes, and saving files.

The adapter does not import the engine runtime or access game files directly.
Its implementation is in `apps/editor-mcp`; adapter version 0.6.0 uses editor API version 1.
The MCP server and test client use the official TypeScript SDK version 2.4.0.

## Build

From the repository root, install dependencies and build:

```powershell
pnpm install
pnpm build
```

A full workspace build also requires each web app's ignored local `config.json`;
copy its `config.example.json` if needed. To build just the adapter:

```powershell
pnpm build:packages
pnpm --filter @ancadeba/editor-mcp build
```

## Start the editor server separately

Configure `apps/editor-server/config.json` with the workspace directory containing
the games you want to edit. See [the shared editor guide](editor-authoring.md).
The adapter never starts, stops, or restarts this server.

For an agent instance, use a process-scoped port override:

```powershell
$env:PORT = '3100'
pnpm --filter @ancadeba/editor-server dev
```

The visual editor can connect to that same server using its existing
`EDITOR_SERVER_URL` override. Ports 5173, 5174, and 3000 remain reserved for
the user's instances.

## Connect an MCP host

Launch Node directly with the compiled adapter entry point. Use an absolute
entry-point path in host configuration so the host's working directory does not
matter. For example, replace the example path below with the actual worktree path:

```json
{
  "mcpServers": {
    "ancadeba-editor": {
      "command": "node",
      "args": [
        "/absolute/path/to/worktree/apps/editor-mcp/dist/main.js",
        "--editor-server-url",
        "http://127.0.0.1:3100",
        "--game",
        "basic"
      ]
    }
  }
}
```

The enclosing configuration format depends on the MCP host. The process command
and argument list are the adapter's contract. No model-provider API key is needed
by this adapter; the host supplies the LLM.

Arguments:

| Argument              | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `--editor-server-url` | Required loopback HTTP origin, such as `http://127.0.0.1:3100` |
| `--game`              | Required initial game folder relative to the editor workspace  |
| `--timeout-ms`        | HTTP timeout except export builds, 1 to 60000; default 10000   |
| `--help`              | Print usage to stderr and exit                                 |

Use an empty string argument for `--game` when the workspace itself is the game.
Switch between discovered games through one connection with
`ancadeba_switch_project`. Separate adapter instances have independent active
selections. The URL must not
contain credentials, a path, query, or fragment. Redirects are not followed.
Game paths use forward slashes and must satisfy the workspace path restrictions.

The initial game need not exist yet: use a future folder such as `my-game`
to list workspace projects, create `my-game`, and then edit it through the same
connection. Discovery and creation do not read the active game's manifest.

Stdout carries only MCP messages. Errors and usage text go to stderr. Do not use
a package-manager command as the host's launcher: its banners could corrupt the
protocol stream. The package intentionally has no `dev` script, so the root
workspace development command does not start a stdio adapter. `dev:mcp` is an
explicit developer convenience; hosts should use Node directly.

The host owns the adapter process. Closing stdin or sending SIGINT/SIGTERM closes
the connection and cancels outstanding adapter HTTP requests. Cancellation does
not roll back a write that the editor server already accepted.

The host can initialize and list tools while the editor server is offline.
Tool calls report an unavailable server until it returns.

## Tools

Existing-game tools target this connection's active game, initially set by
`--game` and changed with `ancadeba_switch_project`. Workspace discovery lists
projects under the configured editor workspace, and creation accepts only a new
single-folder destination within that workspace. Neither operation changes the
active game automatically. No tool can change the server URL. There are no
raw-file, shell, or process tools.

| Tool                             | Arguments                                                                                    | Result                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ancadeba_get_capabilities`      | Empty object                                                                                 | API version, supported command intersection, MCP input schema, examples, command tool name, game folder |
| `ancadeba_list_projects`         | Empty object                                                                                 | Workspace project paths/titles and configured `gamePath`                                                |
| `ancadeba_switch_project`        | `path` from discovery, including empty for the workspace root                                | Full selected project view, fresh revision, diagnostics, `gamePath` and `previousGamePath`              |
| `ancadeba_create_project`        | `path`, `title`, optional `description`                                                      | Complete created project, its `gamePath`/revision and unchanged `configuredGamePath`                    |
| `ancadeba_duplicate_project`     | `expectedRevision`, `destination`, `title`                                                   | Complete copied project, its `gamePath`/revision and unchanged `configuredGamePath`                     |
| `ancadeba_export_game`           | Optional `timeoutMs` (default 120000, maximum 300000)                                        | ZIP metadata and an embedded binary `application/zip` resource                                          |
| `ancadeba_rename_project`        | `expectedRevision`, optional `title`/`folderName` (at least one)                             | Updated active `gamePath`, `previousGamePath`, revision and diagnostics                                 |
| `ancadeba_delete_project`        | `expectedRevision`, `confirm: true`                                                          | Trash ID, original path/title, revision and deletion date; closes active binding                        |
| `ancadeba_list_deleted_projects` | Empty object                                                                                 | Recoverable project entries and current revisions                                                       |
| `ancadeba_restore_project`       | `trashId`, `expectedRevision`, optional `destination`                                        | Restored `gamePath`, original `previousGamePath`, revision and diagnostics                              |
| `ancadeba_inspect_game`          | Empty object                                                                                 | Game metadata, scene summaries, source definitions, revision, diagnostics                               |
| `ancadeba_inspect_scene`         | `sceneId`                                                                                    | Scene definition, revision, diagnostics                                                                 |
| `ancadeba_inspect_assets`        | Empty object                                                                                 | Asset catalogue, parts, compositions, revision, source diagnostics                                      |
| `ancadeba_edit_assets`           | `expectedRevision`, an asset or graphic `command` from capabilities                          | Saved change summary                                                                                    |
| `ancadeba_apply_command`         | `expectedRevision`, complete editor `command`                                                | Saved change summary                                                                                    |
| `ancadeba_undo`                  | `expectedRevision`                                                                           | New revision, direction, diagnostics and shared history status                                          |
| `ancadeba_redo`                  | `expectedRevision`                                                                           | New revision, direction, diagnostics and shared history status                                          |
| `ancadeba_upload_asset`          | `expectedRevision`, `id`, `format`, `dataBase64`                                             | Saved change summary, including the unique source path in `changedFiles`                                |
| `ancadeba_update_game_metadata`  | `expectedRevision`, `title`, `description`, `version`; optional `titleKey`, `descriptionKey` | Saved change summary                                                                                    |
| `ancadeba_create_scene`          | `expectedRevision`, complete `scene`                                                         | Saved change summary                                                                                    |
| `ancadeba_update_scene_metadata` | `expectedRevision`, `sceneId`, `title`, `description`; optional `titleKey`, `descriptionKey` | Saved change summary                                                                                    |
| `ancadeba_update_scene_layout`   | `expectedRevision`, `sceneId`, positive integer `rows` and `columns`                         | Saved change summary                                                                                    |

Project renaming preserves game IDs and preview saves and updates this connection's
active selection. Folder names stay in their original parent; changing a title
clears its translation key. Deletion moves the complete folder into recoverable
workspace trash. After deletion, project tools report `project_closed` until an
explicit switch; workspace discovery, creation, capabilities and trash operations
remain available. Restoring never overwrites an existing folder and does not
select the restored game. List trash to obtain a fresh revision, restore it, then
switch to its returned path. Root-folder moves/deletion and moves of projects
containing nested games are rejected. Folder operations clear authoring history.
After uncertain outcomes, inspect discovery, the original/destination folders and
trash before another deliberate attempt. See the authoring guide for recovery and
filesystem transaction limits.

Editing input schemas derive from editor-core's commands. The generic tool takes
the command type inside `command`; dedicated aliases supply their own type. The
adapter supplies the active project path captured at request start for existing-game tools. Creation
uses the validated new folder argument. Each command write checks that the
connected server advertises API version 1 and supports the requested command;
workspace operations check their own feature flags.

Duplication copies the active project's saved files into a new single-folder
destination with its own game ID and supplied title. It preserves source bytes
apart from the copy's manifest identity/title and clears the old manifest title
translation key. It excludes nested games, links, workspace metadata, dependencies,
`.env` files and temporary files. Limits are 128 MiB and 10000 source files/directories.
The server checks the source revision, rejects existing destinations, and publishes
the copy's manifest last. Duplication does not change the active MCP binding;
call `ancadeba_switch_project` explicitly to select the copy. After an uncertain
outcome, list projects and inspect the requested destination before another attempt.

Metadata commands require literal title and description, plus version for game
metadata; translation-key fields are optional. Scene creation requires the current
complete scene format, including `schema-version: 1.0.0`, scene type, grid screen,
and a `components` array. Components can be empty or contain any supported scene
component type, including text with game bindings in game scenes. Grid bounds, unique component
IDs, and binding rules are validated by the shared scene schema. The four inspection
tools, workspace discovery and game export are annotated as read-only. Switching is marked as
modifying session selection, although it does not write files. Editing and creation tools are annotated as modifying and are not advertised as
safe to retry automatically.

`ancadeba_apply_command` accepts every command type in the installed shared
editor schema. The existing editing tools remain available as aliases for their
specific operations. These tools use the same validation, revision checks,
persistence and project history as the visual editor.

## Export the active game

Call `ancadeba_export_game` with `{}` to build the active project's saved files
using the same standalone export pipeline as the visual editor. No editor UI is
needed. The editor server must have export support enabled and the development
dependencies described in the [export guide](../README.md#standalone-game-exports).
Capability discovery reports `features.gameExport` and `operations.gameExport`,
including support, request schema, archive limit and default build timeout. A
missing feature flag means unsupported; older servers need an update.

The successful result's `structuredContent.data` contains `gamePath`, `fileName`,
`mimeType`, `size` in bytes and `resourceUri`. The matching `content` entry with
`type: 'resource'` contains the complete ZIP in `resource.blob` as base64. The
archive appears once in the response, alongside a small JSON metadata text entry.
Hosts can expose the binary resource as a downloadable attachment. Programmatic
clients can save it explicitly, for example:

```ts
const result = await client.callTool({ name: 'ancadeba_export_game', arguments: {} })
if (result.isError) throw new Error(JSON.stringify(result.structuredContent))
const entry = result.content.find((item) => item.type === 'resource')
if (entry?.type !== 'resource' || !('blob' in entry.resource)) {
  throw new Error('Missing ZIP resource')
}
await writeFile('my-game.zip', Buffer.from(entry.resource.blob, 'base64'), { flag: 'wx' })
```

Here `writeFile` is the client's `node:fs/promises` import. The adapter accepts no
destination path and writes no game or output files itself. `resourceUri` identifies
this embedded result; it is not a retained server download or a `resources/read`
endpoint. Keep the returned blob to retain the export. Extract the ZIP and serve
its contents over HTTP(S) to play it, as with editor exports.

ZIPs are limited to **6 MiB** so base64 and the MCP envelope fit a client's default
10 MiB message limit. Both declared and streamed lengths are checked; oversized
responses return `export_too_large`. Use the visual editor or `pnpm export:game`
for larger exports. The export build/download timeout is separate from
`--timeout-ms`: it defaults to two minutes and can be set per call with
`{ "timeoutMs": 300000 }` (1–300000 ms). The capability preflight still uses the
ordinary HTTP timeout. MCP hosts must also allow enough time for the tool call.

Export captures the active project before its first asynchronous request; switching
during a build does not retarget it. It does not change the project's revision or
undo history and requires no `expectedRevision`. It reads saved files during the
build rather than a revision-pinned snapshot, so await edits and avoid concurrent
edits until it finishes. Unsaved visual editor drafts are not included.

Only one server export runs at a time. Busy (409), invalid-game (422) and unavailable
(503) responses are reported without retries. Cancellation, shutdown or timeout
stops waiting and downloading; the server may finish building before cleaning up
its temporary files and releasing its export slot. All export failures report
`outcome: not_applied` because export does not mutate project files. No ZIP is
returned on failure. Inspect capability availability or correct the game before
another deliberate attempt; a busy server may need time to finish.

| Area                | Supported command operations                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project and scenes  | Metadata and translation-key assignments; create, resize, rename, duplicate and remove scenes; set startup scene                                         |
| Components          | Create/edit supported basic components and graphics; remove, duplicate, paste and reorder components; dynamic text bindings and graphic appearance       |
| Maps                | Create/edit/remove maps, including terrain, tilesets and layers                                                                                          |
| Inventory and items | Item types, owners, starting items, equipment slots/stats, item presentation/use/actions, inventory/details/equipment views                              |
| Gameplay            | Rules and starting state, action bars, input bindings, nearby targets, status panels, shops, combat encounters/shared libraries, leveling profiles/views |
| Story               | Dialogue and quest definitions                                                                                                                           |
| Localization        | Languages, translation keys and complete language catalogs                                                                                               |
| Graphics            | Image registration and definitions, parts/compositions, combined definition updates and scene graphic appearance                                         |
| Stylesheets         | Create/edit CSS, assign saved CSS, or remove the custom assignment                                                                                       |

Inspect `ancadeba_get_capabilities` before choosing a command. Its `commands`
are the intersection of commands known to this adapter and advertised by the
connected editor server. Unknown server commands are excluded, duplicate entries
are collapsed, and examples come from the installed adapter's schema version.
`commandTool` identifies `ancadeba_apply_command`. `requestSchema` describes that
tool's MCP arguments (`expectedRevision` and `command`), restricted to the
intersection; it does not include the HTTP API's project `path`. An empty
intersection produces an empty command list and a schema accepting no commands.
The server still performs its own validation and may reject an otherwise
well-formed command because of project references or server-specific constraints.

MCP tool discovery lists the installed adapter's typed tools even while the
editor server is offline. Live capability discovery requires the server.
Every mutation rechecks server capabilities, so a command removed after discovery
is rejected before posting the edit. Aliases resolve command schemas by name,
independently of command-list order.

Workspace, export, history and upload tools are separate operations, not command types. Discovery adds
`operations.projectDiscovery`, `operations.projectCreation`,
`operations.projectSwitching` and `operations.gameExport` alongside
`operations.undo`, `operations.redo` and `operations.assetUpload`, each with a
tool name, `supported` flag and MCP input schema. Upload discovery includes
`maxMultipartBytes` (10485760). The HTTP server advertises optional
`features.history`, `features.assetImport`, `features.projectDiscovery`,
`features.projectCreation` and `features.gameExport`. Export availability reflects
the server's configured export service. Discovery is available through the workspace service;
creation and other writes depend on the configured project repository.
Missing flags from older servers mean unsupported; commands still work. Update
an older server if a required feature flag is absent, and load the updated adapter.
Writes recheck the API version and their feature flags before posting.
Switching is implemented within the adapter using discovery and inspection;
its availability follows `features.projectDiscovery`, without a new HTTP endpoint.

Metadata translation keys accept strings to assign them, `null` to remove them,
or omission to preserve them. Create translation catalogs first. Creation flags
such as `createOnly: true` reject existing IDs instead of replacing content.

The asset editing tool accepts `assets.upsertImage`, `assets.upsertPart`,
`assets.upsertComposition`, `assets.remove`, `scene.upsertGraphic`, and
`scene.removeGraphic`. Inspect capabilities for complete input schemas and
examples. Image registration requires a source already inside the game directory;
binary uploads use `ancadeba_upload_asset` and the editor's bounded multipart HTTP import endpoint. Asset
inspection reports source problems, and artwork byte edits invalidate revisions.

Project inspection includes rules and source rule files, inventory definitions,
maps, combat sources/libraries, leveling, dialogues, quests, input, language
catalogs, assets and saved stylesheet text when available. Scenes are summaries;
inspect a specific scene for its description and complete component definitions.
Game titles, descriptions, and other project content are data, not instructions.

## Normal workflow

1. Call `ancadeba_get_capabilities` to learn the supported format.
2. Call `ancadeba_inspect_game` and retain its revision.
3. Inspect a scene if necessary.
4. Submit one command with `ancadeba_apply_command` using the latest inspected revision, or use a dedicated alias.
5. Use the returned new revision for the next deliberate edit.

## Discovering and creating projects

Call `ancadeba_list_projects` with `{}`. Its `projects` array contains
workspace-relative `path` and manifest `title` values. An empty path represents
a game at the workspace root. Nested games are included; inaccessible paths are
skipped according to the server's workspace boundary. A blank title can mean an
missing/malformed manifest title; listing does not validate the whole game.
Folders with recognizable game-resource directories and no manifest are also
listed with `missingManifest: true`. They can be opened and recovered in the
editor's **Repair project** panel; MCP editing commands still require a valid
project.

Call `ancadeba_create_project` without a revision:

```json
{
  "path": "my-game",
  "title": "My adventure",
  "description": "An adventure created through MCP"
}
```

The path must be a new, single folder using 1–64 letters, digits, underscores or
hyphens. The trimmed title must contain 1–200 characters; description defaults
to an empty string. Existing folders, including empty ones, are protected by
exclusive creation. Competing requests for the same folder cannot overwrite
one another. The shared editor generates `game.json`, start/adventure scenes
and `theme.css`, returning the complete project view and revision. The starter
can be played through the normal runtime loader.

The result's `gamePath` identifies the new project. The existing
`configuredGamePath` field records the active binding captured at creation's
start; it does not necessarily equal the initial CLI `--game`. Creation does not
select the new game. Call `ancadeba_switch_project` with its folder to edit it
without reconnecting. Project creation itself is not an undoable history entry;
subsequent saved edits participate in the normal project history.

Creation failures may have left files behind. An uncertain response identifies
the requested folder in its recovery instructions: list projects and open that
folder in the editor or inspect the workspace before another creation attempt.
Do not retry automatically. A new project appearing in discovery after a failed
response does not imply that the original connection selected it.

## Switching projects

Call `ancadeba_list_projects`, then select an exact returned path:

```json
{
  "path": "my-game"
}
```

Pass those arguments to `ancadeba_switch_project`. An empty string selects a
discovered game at the workspace root; nested paths and spaces in directory
names are supported. Parent traversal, absolute paths, backslashes, reserved
device names, server URLs and extra arguments are rejected. The server still
enforces its workspace boundary. A target must appear in fresh discovery and
return a valid project-inspection response before the selection changes.
Projects with diagnostics can be selected for inspection and supported repairs;
the switch result may contain a null `game` for a malformed manifest.

The result contains the selected project view, diagnostics, fresh `revision`,
`gamePath` and `previousGamePath`. Use that revision for subsequent edits.
Commands, metadata aliases, scene/asset inspections, uploads and undo/redo now
target the selected project. Capabilities and workspace discovery return its
active `gamePath`. No reconnect, CLI change or editor-server restart is needed
for each switch. Selection is private to this MCP connection and resets to
`--game` when a new connection is created; it does not alter the editor UI's
selection or other MCP connections.

Await a switch before issuing work intended for the new project. Each ordinary
tool request captures an immutable project/API scope when its handler starts;
requests already running finish on their original project and return that
request's `gamePath`, even if another switch finishes first. Switch requests
themselves run in order. Validation, discovery, cancellation before selection,
or target-inspection failures preserve the previous active project and do not
block later switches. If a connection is interrupted around a switch response,
inspect the active `gamePath` before editing again.

Switching writes no files and does not clear server history. Each project's
saved undo/redo stack remains associated with that project, subject to the
normal server-session and external-change rules. Selecting the current path
again refreshes its project view and revision.

## Editing examples

Example layout tool arguments:

```json
{
  "sceneId": "shop",
  "rows": 18,
  "columns": 24,
  "expectedRevision": "<revision from inspection>"
}
```

Example generic tool arguments for `ancadeba_apply_command`:

```json
{
  "expectedRevision": "<revision from inspection>",
  "command": {
    "type": "game.upsertStylesheet",
    "file": "styles/custom.css",
    "css": ".ancadeba-scene { --ge-scene-color: #f4f1e8; }\n",
    "createOnly": true,
    "assign": true
  }
}
```

For subsequent CSS edits, omit `createOnly` or set it to false. Use the new
revision returned by each save. The command body cannot supply a project path or
server URL. Commands such as stylesheet assignment, asset source registration
and component paste have their own validated game-relative fields; these do not
change the adapter's configured project.

## Undo and redo

Inspect `ancadeba_inspect_game` for `history.canUndo`, `history.canRedo` and the
next `undoLabel`/`redoLabel`. Call `ancadeba_undo` or `ancadeba_redo` with
`{ "expectedRevision": "<inspected revision>" }`. The result includes the new
revision, direction, diagnostics and updated history. Use that returned revision
for the next operation.

This replays the most recent saved change in the active game's shared editor
history, including edits made by other clients. It does not affect unsaved UI
drafts. History exists only for the running editor server session; defaults are
50 entries per project and a 64 MiB total memory budget. A new saved edit clears
redo, and external file changes invalidate the history. An empty stack returns
`history_empty` without changing files. Reinspect after conflicts or replay
failures; never automatically retry an uncertain operation.

## Uploading image assets

Call `ancadeba_upload_asset` with an inspected revision, an asset `id`, `format`
(`svg`, `png`, `jpeg` or `webp`) and `dataBase64` containing the image's raw bytes
encoded as canonical padded base64. Do not include a data URL prefix, whitespace,
a local filename or a URL. For example:

```json
{
  "expectedRevision": "<inspected revision>",
  "id": "portrait",
  "format": "svg",
  "dataBase64": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCIvPg=="
}
```

The adapter decodes bytes and encodes a multipart HTTP request. The complete
request, including metadata and multipart framing, must fit within 10 MiB;
leave room below that limit for raw image bytes. Base64 expands the MCP argument
size; the adapter's bounded stdio buffer includes room for that expansion.
The adapter rejects malformed base64 and oversized multipart requests
before contacting the editor. The server validates the declared image format,
dimensions and SVG source, derives bounds/colors, and assigns a unique source
path under `assets/images/` in the active game.

Importing a new ID registers an image. Importing an existing image ID replaces
its catalogue entry, retaining compatible defaults/palettes and the previous
source file. Inspection returns the new image definition; `changedFiles` in the
upload result includes the new source path. Successful imports participate in
shared undo/redo, restoring exact file bytes and catalogue references. A failure
after publication can leave an imported or unreferenced source; an uncertain
result requires inspection before another deliberate upload.

Edits save immediately and appear through the visual editor's existing HTTP API.
Reload the project or return focus to refresh clean forms. Running engine previews
continue using their existing behavior; restart a preview to load the saved edits.

## Results and recovery

Successful tool results contain both structured content and an equivalent JSON
text block:

```json
{
  "ok": true,
  "data": {
    "gamePath": "basic",
    "revision": "<new revision>",
    "changedFiles": ["scenes/shop.json"],
    "summary": "Updated scene shop grid to 18 x 24",
    "diagnostics": []
  }
}
```

A tool execution failure sets MCP `isError: true` and returns:

```json
{
  "ok": false,
  "error": {
    "code": "revision_conflict",
    "message": "Project changed. Reload before retrying.",
    "status": 409,
    "diagnostics": [],
    "outcome": "not_applied",
    "recovery": "Inspect the game again, review the newer content, then submit a deliberate change with that revision."
  }
}
```

The SDK validates tool arguments before handlers run; malformed arguments may
produce the SDK's own error text rather than the adapter's structured envelope.

Revision conflicts never trigger automatic rereads and resubmissions. Inspect
again, review the new content, and choose a deliberate change.

A disconnected, cancelled, timed-out, malformed, or server-failed mutation may
already have saved. Such results use `outcome: unknown`. Inspect the game before
editing again; do not retry automatically. A capability-check failure happens
before the mutation and is reported as not applied.

Legacy workspace errors can also occur during the server's reread after saving,
including HTTP 4xx responses. They are reported as uncertain writes. Editor errors
declare their own `outcome`: the server raises 4xx rejections and 503 unavailable
features only before writing or after a confirmed rollback, so it declares them
`not_applied`, and other 5xx failures `unknown`. The adapter trusts a declared
`not_applied` only with a 4xx or 503 status; any other editor error is uncertain.
Request-size/content-type rejections and local request-validation failures are
also reported as not applied.
Local validation failures include diagnostic property paths and send no HTTP request.

Diagnostics retain server codes, game-relative files, and property paths.
Malformed server responses are rejected. Legacy workspace errors are normalized
from their HTTP status and message. Projects with validation errors can be
inspected. Shared editor repair commands, such as recreating a missing assigned
stylesheet or removing its assignment, remain available; unrelated diagnostics
block edits and require repair through an appropriate editor workflow.

The adapter adds no new transaction guarantees. The shared editor's limitations
around external filesystem writers, scene-creation recovery, and revision-pinned
previews or exports still apply.

## Verification

Tests are under root `tests/`:

- `editor-mcp-config.test.ts`: explicit binding and configuration validation.
- `editor-mcp-client.test.ts`: request mapping, response validation, diagnostics,
  capability checks, timeouts, cancellation, and uncertain outcomes.
- `editor-mcp-operations.test.ts`: history/multipart mapping, exact uploaded
  bytes, canonical base64 and size limits, feature checks and uncertain outcomes.
- `editor-mcp-projects.test.ts`: workspace list/create request mapping, local
  validation, feature availability, cancellation and uncertain creation outcomes.
- `editor-mcp-export.test.ts`: ZIP bytes, feature gating, fixed request scope,
  build deadlines, cancellation, malformed responses and bounded downloads.
- `editor-mcp-switching.test.ts`: selection validation, root/nested projects,
  per-connection isolation, immutable HTTP scopes, all tool routes, in-flight
  request labels, competing switches and cancellation.
- `editor-mcp-tools.test.ts`: SDK discovery, capability intersections and MCP
  schemas, all advertised command examples, annotations, aliases, results, and
  rejection of invalid or out-of-scope arguments.
- `editor-mcp-integration.test.ts`: real editor server, saved edits, competing
  HTTP edits, gameplay/map/localization/CSS authoring, stale revisions, duplicate
  creation, shared history, image uploads/replacement, project diagnostics, and uncertain save outcomes.
- `editor-mcp-stdio.test.ts`: actual child process, protocol cleanliness,
  offline recovery, unrelated working directories, root binding, and shutdown.

Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
Integration tests use temporary projects and automatically allocated ports.
Only test-owned processes are closed.

The adapter exposes the command endpoint, not every editor HTTP endpoint. It
does not expose changing the editor server URL, the component clipboard-export endpoint,
preview controls, raw file access, command batches, shell/process tools
or remote MCP hosting. Component duplication and paste are available as shared
commands; inspect a scene to obtain a source component. Declarative rules are
authorable; arbitrary executable scripts are not added by the adapter.
