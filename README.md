# Ancadeba

A pnpm workspace using Vite+ 1.3 and TypeScript 7.0.2. The layout follows
`Ancadeba.20261013`; application and library source starts with a minimal scaffold.

## Getting started

Requirements: Node.js 24.11+ in the 24.x LTS line (or Node.js 26+) and pnpm 11.5.1.

```sh
pnpm install
cp apps/engine/config.example.json apps/engine/config.json
cp apps/editor-ui/config.example.json apps/editor-ui/config.json
cp apps/editor-server/config.example.json apps/editor-server/config.json
pnpm dev
```

Dependencies are already installed in this workspace. Vite+ is installed locally,
so a global `vp` installation is optional. Scripts resolve the local CLI.

| Folder                   | Package                   | Purpose                                                 | Development URL       |
| ------------------------ | ------------------------- | ------------------------------------------------------- | --------------------- |
| `apps/engine`            | `@ancadeba/engine`        | Vanilla TypeScript web application                      | http://localhost:5173 |
| `apps/editor-ui`         | `@ancadeba/editor-ui`     | Vanilla TypeScript web application                      | http://localhost:5174 |
| `apps/editor-server`     | `@ancadeba/editor-server` | Small Node.js HTTP server                               | http://127.0.0.1:3000 |
| `packages/schemas`       | `@ancadeba/schemas`       | Shared schemas and types                                | —                     |
| `packages/game-runtime`  | `@ancadeba/game-runtime`  | Shared game runtime                                     | —                     |
| `packages/utilities`     | `@ancadeba/utilities`     | Shared utilities                                        | —                     |
| `packages/ui-components` | `@ancadeba/ui-components` | Browser UI components, retained from the earlier layout | —                     |
| `tests`                  | —                         | All tests, helpers, and fixtures                        | —                     |
| `docs`                   | —                         | Project documentation                                   | —                     |
| `sample-games`           | —                         | Sample game projects                                    | —                     |

Every app depends on schemas, game-runtime, and utilities through `workspace:*`.
Both web apps also depend on ui-components. Game-runtime depends on schemas and
utilities. Shared packages expose compiled ESM and TypeScript declarations from
`dist/`; export new code from each package's `src/index.ts`.

`pnpm dev` first builds the shared packages in dependency order, then starts both
web apps, the server watcher, and the shared package compiler watchers. Vite+
handles web development, production bundles, task execution, linting, formatting,
and tests. TypeScript 7's native `tsc` handles type checks and compilation of the
server and shared packages; tsx restarts the server during development.

Browser source includes DOM types; server and tooling include Node types.
Schemas, game-runtime, and utilities include neither DOM nor Node globals, keeping
them usable across browser and server applications.

## Commands

```sh
pnpm dev           # Start all apps and shared package watchers
pnpm build         # Build all packages and apps in dependency order
pnpm check         # Format, lint, and type-check all source and TS configs
pnpm lint          # Oxlint checks (including types) and Oxfmt format checks
pnpm lint:fix      # Fix lint issues and format files
pnpm format        # Format with single quotes, no semicolons, and LF endings
pnpm format:check  # Check formatting
pnpm typecheck     # Check all apps, libraries, tests, and TypeScript configs
pnpm test          # Build shared packages and run tests once
pnpm test:watch    # Build shared packages and watch tests
```

The root `vite.config.ts` holds lint, format, and test settings. Each web app has
its own Vite+ config and separate browser and Node tooling TypeScript configs.
Tests belong in `tests/**/*.test.ts` and import test APIs from `vite-plus/test`.
The integration tests exercise compiled workspace exports and real HTTP requests
to the server on an automatically allocated local port.

VS Code recommendations include the Vite+ extension pack and TypeScript Native
Preview extension, with Oxc formatting and fix actions on save.

## Running an individual app

Build shared dependencies first:

```sh
pnpm build:packages
pnpm --filter @ancadeba/engine dev
pnpm --filter @ancadeba/editor-ui dev
pnpm --filter @ancadeba/editor-server dev
```

Run only the desired app command. In another terminal, use
`pnpm --filter './packages/*' --parallel dev` to watch shared library changes.

The editor server provides `GET /health`, returning `{ "status": "ok" }`. During
development, the editor UI proxies `/health` and `/api` to its configured
`editorServerUrl`.

## App configuration

Copy each app's `config.example.json` to `config.json` and edit the values.
PowerShell users can use `Copy-Item` in place of `cp`. Local config files are
ignored by Git. Config files are located relative to the app, regardless of the
terminal's working directory. Missing files, invalid JSON, or invalid settings
stop startup with setup guidance. Restart the relevant app after changing its
source config.

Engine (`apps/engine/config.json`):

```json
{
  "gameUrl": "/games/example/",
  "port": 5173
}
```

`gameUrl` is required and refers to a directory of browser-accessible game files.
It accepts an HTTP(S) URL or a relative web path. Relative paths resolve against
the engine application's base URL, and a missing trailing slash is added. For
example, `./game` under `/engine/` resolves to `/engine/game/`. Put static game
files in `apps/engine/public/games/example/` to use the example URL, or point to
an existing web server (which must allow cross-origin requests when applicable).
The engine's injected `gameResources` service reads text and bytes beneath that
directory and reports HTTP/network failures. Startup loads and validates
`game.json` through `JsonResourceLoader`. The current game schema accepts an
object and preserves its fields; game execution is not implemented yet. The
editor file API is a separate interface and is not a directory URL for this service.

Editor UI (`apps/editor-ui/config.json`):

```json
{
  "port": 5174,
  "editorServerUrl": "http://127.0.0.1:3000"
}
```

Editor server (`apps/editor-server/config.json`):

```json
{
  "workFolder": "../../sample-games",
  "host": "127.0.0.1",
  "port": 3000
}
```

`workFolder` is required and must be an existing accessible directory, not a
symbolic link or junction. Relative paths resolve against the config file's
directory. Absolute paths are supported; in Windows JSON use forward slashes
(`D:/Games/My Project`) or escape backslashes. The server does not create the
workspace root. Only files inside this folder are exposed.

Optional settings use the defaults shown above. Existing environment variables
override JSON settings, which override defaults:

| App           | Environment override | JSON setting      |
| ------------- | -------------------- | ----------------- |
| Engine        | `ENGINE_PORT`        | `port`            |
| Editor UI     | `EDITOR_UI_PORT`     | `port`            |
| Editor UI     | `EDITOR_SERVER_URL`  | `editorServerUrl` |
| Editor server | `HOST`               | `host`            |
| Editor server | `PORT`               | `port`            |

Ports must be integers between 1 and 65535. Vite CLI options such as `--port`
continue to work. Environment overrides can be scoped to a terminal and its child
processes, without changing config files.

## Engine instances

The editor includes Start and Stop controls and a Game folder field. Leave the
field empty when the editor server's `workFolder` is the game directory, or enter
a subfolder such as `basic` when the workspace contains multiple games. Start
loads that folder's `game.json` through `/api/files`, with caching disabled, and
mounts a preview after validation. Stop also works while loading. Each new start
uses a fresh instance and reads the latest saved files; unsaved edits are not yet
part of the resource source. Failures appear beside the controls and allow retrying.
The preview currently confirms that the game definition loaded; gameplay rendering
is not implemented yet.

`@ancadeba/game-runtime` exports `createEngine`, `IEngine`, and `IEngineHost`.
It has no browser or Node globals and can be imported by the editor without
starting the standalone engine or fetching its `config.json`.

```ts
import { createEngine } from '@ancadeba/game-runtime'

const engine = createEngine({
  resourceSource,
  logger,
  host: {
    mount(game) {
      const root = previewElement.ownerDocument.createElement('section')
      root.textContent = typeof game.title === 'string' ? game.title : 'Game preview'
      previewElement.append(root)
      return () => root.remove()
    },
  },
})

await engine.start()
console.log(engine.state, engine.game)
engine.stop()
```

Supply an `IResourceSource`, an `ILogger`, and a host whose synchronous `mount`
returns a cleanup function. Each instance gets its own container and JSON loader.
The host should release its mounted content, listeners, and other owned resources
in that cleanup function. If mounting throws, the host is responsible for undoing
any partial mount. Injected sources and loggers remain owned by the caller.

Instances transition through `stopped`, `starting`, and `running`. Repeated starts
share the current startup promise, and repeated stops are safe. A stopped instance
can start again and reads fresh game data. Startup failures reject `start()` and
return the instance to `stopped`.

Stopping during startup resolves the cancelled `start()` without mounting. Late
resource results cannot revive a stopped instance or overwrite a newer run.
Underlying resource reads can finish in the background because `IResourceSource`
does not yet expose transport cancellation. `stop()` clears the loaded game and
runs host cleanup synchronously. The standalone page uses this lifecycle and
stops its instance when Vite replaces its entry module.

## Workspace file API

The editor server exposes these endpoints directly and through the editor UI's
development proxy. Paths use `/` separators relative to `workFolder`; URL-encode
the `path` query value. Host filesystem paths are not included in responses.

| Request                                | Behavior                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/workspace`                   | List the workspace root                                                            |
| `GET /api/workspace?path=levels`       | List a directory                                                                   |
| `GET /api/files?path=levels/demo.json` | Read file bytes as `application/octet-stream`                                      |
| `PUT /api/files?path=levels/demo.json` | Create or replace a file using the raw request body; create missing parent folders |

Listings return `{ "entries": [{ "name": "levels", "type": "directory" }] }`,
with entry types `file` and `directory`. Links are omitted. File creation returns
`201`; replacement returns `204`. Empty and binary files are supported. Writes
are limited to 10 MiB, including requests without a content-length header.

Errors return `{ "error": "message" }`: `400` for invalid paths, `403` for
traversal or link access, `404` for missing resources, `409` for file/directory
conflicts, and `413` for oversized writes. Filesystem permission failures return
`403`; unexpected failures return `500`. Absolute paths, `..`, backslashes,
Windows device names, and alternate data streams are rejected. No rename,
delete, or concurrent-edit detection is provided. The editor UI does not yet
include a file browser or editor.

Example using PowerShell:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/api/workspace'
Invoke-WebRequest 'http://127.0.0.1:3000/api/files?path=levels/demo.json' `
  -Method Put -ContentType 'application/octet-stream' -Body '{"name":"Demo"}'
```

## Production

After `pnpm build`, run `pnpm --filter @ancadeba/engine preview` or
`pnpm --filter @ancadeba/editor-ui preview` to preview a web build. Use
`pnpm --filter @ancadeba/editor-server start` to start the built server. Keep the
installed workspace and shared package build output available for server runtime
imports. Keep `apps/editor-server/config.json` alongside the server's `dist/`
folder; work-folder paths retain the same meaning for source and compiled runs.
The development proxy is not included in production static builds.

The engine build emits `apps/engine/dist/config.json` containing only `gameUrl`.
The browser loads it before creating services, with caching disabled. Edit that
deployed file to switch games without rebuilding JavaScript; configure the static
host to avoid caching `config.json`. Source settings such as ports are not exposed
to the browser. Vite preview serves the emitted config file. Both web apps still
require their source app config files when invoking Vite tooling.

## Separate development instances

Ports 5173, 5174, and 3000 are reserved for the user's development instances.
Use other free ports for temporary instances, without changing the defaults:

```powershell
pnpm --filter @ancadeba/engine dev --port 5273
pnpm --filter @ancadeba/editor-ui dev --port 5274
```

For the server, in a separate terminal:

```powershell
$env:PORT = '3100'
pnpm --filter @ancadeba/editor-server dev
```

To start the entire workspace on alternate ports from one PowerShell terminal:

```powershell
$env:ENGINE_PORT = '5273'
$env:EDITOR_UI_PORT = '5274'
$env:PORT = '3100'
$env:EDITOR_SERVER_URL = 'http://127.0.0.1:3100'
pnpm dev
```

These overrides apply to that terminal and its child processes. Vite uses strict
ports, so an occupied port produces a startup error.

## Toolchain upgrades

Vite+ is pinned together with its Vite core alias and bundled Vitest in
`pnpm-workspace.yaml`. Upgrade these entries together, using
`pnpm exec vp toolchain` to inspect the bundled versions. The scoped peer rules
accept Vite+ core's version for Vitest's upstream Vite peer ranges; update those
alongside the core alias. TypeScript is restricted to the stable 7.0 patch line.

See the [Vite+ monorepo guide](https://www.viteplus.dev/guide/monorepo) and
[local CLI setup](https://www.viteplus.dev/guide/local-cli) for tooling details.
