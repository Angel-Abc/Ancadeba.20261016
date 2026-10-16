# Ancadeba

A pnpm workspace using Vite+ 1.3 and TypeScript 7.0.2. The layout follows
`Ancadeba.20261013`; application and library source starts with a minimal scaffold.

## Getting started

Requirements: Node.js 24.11+ in the 24.x LTS line (or Node.js 26+) and pnpm 11.5.1.

```sh
pnpm install
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
development, the editor UI proxies `/health` to `http://127.0.0.1:3000`.
`HOST` and `PORT` configure the server; defaults are `127.0.0.1` and `3000`.

After `pnpm build`, run `pnpm --filter @ancadeba/engine preview` or
`pnpm --filter @ancadeba/editor-ui preview` to preview a web build. Use
`pnpm --filter @ancadeba/editor-server start` to start the built server. Keep the
installed workspace and shared package build output available for server runtime
imports. The development proxy is not included in production static builds.

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
