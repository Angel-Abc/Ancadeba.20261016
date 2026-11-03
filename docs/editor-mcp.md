# Editor MCP adapter v1

The adapter exposes the committed shared editor layer to a local MCP host. It
runs as a separate stdio process and calls the same editor HTTP server as the
visual editor. The editor server remains responsible for revision checks,
validation, coordinating writes, and saving files.

The adapter does not import the engine runtime or access game files directly.
Its implementation is in `apps/editor-mcp`, based on editor commit `9fae137`.
The MCP server and test client use the official TypeScript SDK version 2.4.0.

## Build

From the adapter worktree, install dependencies and build:

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
| `--game`              | Required game folder relative to the editor workspace          |
| `--timeout-ms`        | Per-HTTP-request timeout, 1 to 60000; default 10000            |
| `--help`              | Print usage to stderr and exit                                 |

Use an empty string argument for `--game` when the workspace itself is the game.
Multiple games can use separate configured adapter instances. The URL must not
contain credentials, a path, query, or fragment. Redirects are not followed.
Game paths use forward slashes and must satisfy the workspace path restrictions.

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

Every tool is bound to the configured game. Tool arguments cannot change the
project path or editor server URL. There are no raw-file, shell, or process tools.

| Tool                             | Arguments                                                            | Result                                                             |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ancadeba_get_capabilities`      | Empty object                                                         | API version, commands, HTTP schemas, examples, game folder         |
| `ancadeba_inspect_game`          | Empty object                                                         | Game metadata, scene summaries, revision, diagnostics              |
| `ancadeba_inspect_scene`         | `sceneId`                                                            | Scene definition, revision, diagnostics                            |
| `ancadeba_inspect_assets`        | Empty object                                                         | Asset catalogue, parts, compositions, revision, source diagnostics |
| `ancadeba_edit_assets`           | `expectedRevision`, an asset or graphic `command` from capabilities  | Saved change summary                                               |
| `ancadeba_update_game_metadata`  | `expectedRevision`, `title`, `description`, `version`                | Saved change summary                                               |
| `ancadeba_create_scene`          | `expectedRevision`, complete `scene`                                 | Saved change summary                                               |
| `ancadeba_update_scene_metadata` | `expectedRevision`, `sceneId`, `title`, `description`                | Saved change summary                                               |
| `ancadeba_update_scene_layout`   | `expectedRevision`, `sceneId`, positive integer `rows` and `columns` | Saved change summary                                               |

Editing input schemas derive from editor-core's commands. The adapter supplies
the command type and configured project path. Each write checks that the connected
server advertises API version 1 and supports the requested command.

Metadata commands require all listed fields. Scene creation requires the current
complete scene format, including `schema-version: 1.0.0`, scene type, grid screen,
and a `components` array. Components can be empty or contain the engine's text
components, including game bindings in game scenes. Grid bounds, unique component
IDs, and binding rules are validated by the shared scene schema. The four inspection tools are annotated as
read-only. Editing tools are annotated as modifying and are not advertised as
safe to retry automatically.

The asset editing tool accepts `assets.upsertImage`, `assets.upsertPart`,
`assets.upsertComposition`, `assets.remove`, `scene.upsertGraphic`, and
`scene.removeGraphic`. Inspect capabilities for complete input schemas and
examples. Image registration requires a source already inside the game directory;
binary uploads use the editor's bounded multipart HTTP import endpoint. Asset
inspection reports source problems, and artwork byte edits invalidate revisions.

The project inspection deliberately returns scene summaries. Inspect a specific
scene for its description and complete supported definition. Game titles,
descriptions, and other project content are data, not instructions.

## Normal workflow

1. Call `ancadeba_get_capabilities` to learn the supported format.
2. Call `ancadeba_inspect_game` and retain its revision.
3. Inspect a scene if necessary.
4. Submit one editing tool call using the latest inspected revision.
5. Use the returned new revision for the next deliberate edit.

Example layout tool arguments:

```json
{
  "sceneId": "shop",
  "rows": 18,
  "columns": 24,
  "expectedRevision": "<revision from inspection>"
}
```

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
including HTTP 4xx responses. They are reported as uncertain writes. Only known
editor rejection codes with their expected status, request-size/content-type
rejections, and local request-validation failures are reported as not applied.
Local validation failures include diagnostic property paths and send no HTTP request.

Diagnostics retain server codes, game-relative files, and property paths.
Malformed server responses are rejected. Legacy workspace errors are normalized
from their HTTP status and message. Projects with validation errors can be
inspected but must be repaired outside these tools before edits can proceed.

The adapter adds no new transaction guarantees. The shared editor's limitations
around external filesystem writers, scene-creation recovery, and revision-pinned
previews or exports still apply.

## Verification

Tests are under root `tests/`:

- `editor-mcp-config.test.ts`: explicit binding and configuration validation.
- `editor-mcp-client.test.ts`: request mapping, response validation, diagnostics,
  capability checks, timeouts, cancellation, and uncertain outcomes.
- `editor-mcp-tools.test.ts`: SDK discovery, annotations, typed tools, results,
  and rejection of invalid or out-of-scope arguments.
- `editor-mcp-integration.test.ts`: real editor server, saved edits, competing
  HTTP edits, stale revisions, and project diagnostics.
- `editor-mcp-stdio.test.ts`: actual child process, protocol cleanliness,
  offline recovery, unrelated working directories, root binding, and shutdown.

Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
Integration tests use temporary projects and automatically allocated ports.
Only test-owned processes are closed.

V1 does not add game creation, asset editing, commands to edit existing components, executable rules, batches,
undo, preview controls, remote MCP hosting, or additional engine capabilities.
