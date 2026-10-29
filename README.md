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
pnpm export:game sample-games/basic  # Package a standalone game
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
  "gameUrl": "/sample-games/basic/",
  "port": 5173
}
```

`gameUrl` is required and refers to a directory of browser-accessible game files.
It accepts an HTTP(S) URL or a relative web path. Relative paths resolve against
the engine application's base URL, and a missing trailing slash is added. For
example, `./game` under `/engine/` resolves to `/engine/game/`. During `pnpm dev`,
the engine serves the repository's `sample-games` folder at `/sample-games/`, so
the example configuration loads `sample-games/basic/game.json` directly. The
route also supports a nested Vite base, returns real 404 responses for missing
files, and reads saved changes without caching. Links, traversal paths, local
environment files, source-control metadata, and `node_modules` are inaccessible.
This route is only for development; use `export:game` to package a standalone
game. You can also put static files under `apps/engine/public/` and configure
their URL, or point to an existing HTTP(S) server with suitable cross-origin access.
The engine's injected `gameResources` service reads text and bytes beneath that
directory and reports HTTP/network failures. Startup loads and validates
`game.json` and its referenced scene files through `JsonResourceLoader` and
`GameLoader`. Each file is validated before its definition is assembled into
`GameData`; game execution is not implemented yet. The
editor file API is a separate interface and is not a directory URL for this service.
`readText` and `readBytes` accept literal game-relative filenames, including `#`
and `%`, and encode each path segment for HTTP. `fetchResource` accepts relative
URL references, so its callers must encode filename characters themselves.

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

## Game data pipeline

The pipeline is `JSON files → validated definitions → assembled game data`.
`@ancadeba/schemas` owns `gameSchema` / `GameDefinition` and `sceneSchema` /
`SceneDefinition`. The manifest requires `schema-version` (`1.0.0`), `id`, `title`,
`description`, `version`, and a `scenes` array of unique IDs. IDs contain only
letters, digits, underscores, and hyphens. An empty scene list is valid.

`GameLoader` uses an injected `IJsonResourceLoader` to load `game.json`, then
`scenes/<id>.json` for each reference. The current scene format supports
`stand-alone` scenes with a `grid` screen, positive integer rows and columns,
and an empty `components` array. Component definitions are not supported yet.
Every scene must declare the ID used by its manifest reference.

`assembleGameData` combines validated definitions without I/O. `GameData` contains
game metadata and a `ReadonlyMap<string, SceneData>` in manifest order. The data
excludes file schema versions: `schema-version` belongs to validation, while all
supported file formats assemble into the same runtime data model. Scene objects are
copied into the assembled structure. Readonly types describe the consumer API;
these objects are not frozen at runtime. No initial scene is selected.

The engine exposes and mounts the assembled game only after every referenced
scene loads and validates. Rendering and mutable play state remain separate from
this data pipeline; both existing hosts still display their placeholders.

## Engine instances

The editor includes Start and Stop controls and a Game folder field. Leave the
field empty when the editor server's `workFolder` is the game directory, or enter
a subfolder such as `basic` when the workspace contains multiple games. Start
loads that folder's `game.json` and referenced scenes through `/api/files`, with
caching disabled, and mounts a preview after the complete game is validated and
assembled. Stop also works while loading. Each new start
uses a fresh instance and reads the latest saved files; unsaved edits are not yet
part of the resource source. Failures appear beside the controls and allow retrying.
The preview currently confirms that the game definition loaded; gameplay rendering
is not implemented yet.

The editor UI composes its services in `apps/editor-ui/src/ioc/containerBuilder.ts`.
The `factories/` folder registers console logging, preview engine creation, and
the preview/export controllers. The entry point supplies the preview host, fetch
function, download callback, and UI state callbacks, then resolves the controllers
from one container. Each preview start creates a fresh engine for the selected
game folder; controller disposal remains owned by the entry point.

Export uses the same Game folder field and downloads a ZIP containing the engine,
`game.json`, and the game's assets. It works while a preview is running and uses
the latest saved workspace files. The folder is locked while the export builds;
Stop remains available for a running preview. A download link remains available
afterward so the ZIP can be downloaded again. Unzip it and serve the complete
contents over HTTP(S), just like a command-line export.

`@ancadeba/game-runtime` exports `Engine`, `IEngine`, `IEngineHost`, `EngineMessages`,
`GameLoader`, `IGameLoader`, `assembleGameData`, `GameData`, and `SceneData`.
It has no browser or Node globals and can be imported by the editor without
starting the standalone engine or fetching its `config.json`.

```ts
import { Engine, GameLoader, type EngineMessages } from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'
import { createBrowserTiming } from '@ancadeba/ui-components'

const engine = new Engine(
  new GameLoader(new JsonResourceLoader(resourceSource, logger)),
  {
    mount(game) {
      const root = previewElement.ownerDocument.createElement('section')
      root.textContent = game.title
      previewElement.append(root)
      return () => root.remove()
    },
  },
  logger,
  () => new MessageBus<EngineMessages>(),
  createBrowserTiming(window),
)

await engine.start()
console.log(engine.state, engine.game)
engine.stop()
```

Construct `Engine` with an `IGameLoader`, a host whose synchronous `mount(game, session)`
returns a cleanup function, an `ILogger`, a factory that creates a fresh
raw message bus for each session, and required `EngineRuntimeServices` containing
an `ITaskScheduler` and `IMonotonicClock`. `createBrowserTiming(window)` supplies
these through browser timers and `performance.now()`. The scheduler must always
defer its callback and return an idempotent cancellation function. The standalone application uses
`ContainerBuilder` to register the host, resources, JSON loader, message-bus
factory, and engine in one container, then resolves `engine` from that container.
The editor's IoC preview factory constructs an engine and JSON loader for each
selected game folder, using the registered logger, host, message-bus factory, and timing services.
The host receives `{ input, messages, timers, actions }` for that session during mounting.
Timing services can also supply a `createGameRules(game)` factory, described below.
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

### Lifecycle messages

Each `start()` that creates a session wraps a fresh injected raw bus in a
`ScheduledMessageBus<EngineMessages>`, available immediately as `engine.messages`.
It is undefined before the first start. Subscribe immediately after calling
`start()` to observe startup messages. All session messages are delivered
automatically in deferred host tasks; publishing never invokes handlers inline.
Multiple publications share one pending task, and messages published by handlers
get a later task. An idle bus schedules no work. Subscribers remain the processing
boundary; dispatch does not itself advance turns or world time.

```ts
const starting = engine.start()
const messages = engine.messages
messages?.subscribe('engine.started', ({ game }) => {
  console.log('Started', game)
})
messages?.subscribe('engine.failed', ({ error }) => {
  console.error('Engine failed', error)
})

await starting
engine.stop()
```

The exported `EngineMessages` interface defines these topics:

| Topic             | Payload              | Queued when                                       |
| ----------------- | -------------------- | ------------------------------------------------- |
| `engine.starting` | `undefined`          | A new session is created                          |
| `engine.started`  | `{ game: GameData }` | The game is loaded and mounted successfully       |
| `engine.failed`   | `{ error: unknown }` | Startup or host cleanup throws                    |
| `engine.stopped`  | `undefined`          | The session stops, including cancellation/failure |

Failures queue `engine.failed` before `engine.stopped` and keep the existing
promise rejection or synchronous exception behavior. Cancellation queues stopped
without failed or started. Automatic dispatch logs aggregated subscriber failures
through the injected logger, completes the batch, and continues later dispatches.
Failed deliveries are not retried and do not become engine failure events.

On stop, action processing and input are disposed, timers are cancelled, and gameplay delivery is
disabled before host cleanup. A message already being delivered finishes its
remaining subscribers; later queued input, timer, action, and progression messages are discarded,
including those in the same batch. Final lifecycle messages are queued and the
bus is sealed against further publication. These final messages are still
delivered automatically, even if another session starts immediately.

`engine.messages` retains the stopped session's bus. Retained references may
subscribe to remaining lifecycle messages or explicitly flush them, but cannot
publish more work. A restart creates a new bus, input controller, and timer
service, action handlers, and progression; subscriptions do not transfer. Repeated starts while active and repeated
stops do not create extra buses or events.

`engine.flushMessages()` and `engine.messages.flush()` remain available. They
invalidate a pending automatic task, synchronously deliver one snapshot batch,
and throw `AggregateError` for subscriber or delivery-predicate failures. Handler
publications still schedule a later task, and nested flushes do nothing. Explicit
flushes use the same session-delivery rules as automatic dispatch. Flushing before
the first start does nothing.

The application IoC registrations supply the bus factory through dependency
injection, returning a fresh `MessageBus<EngineMessages>` on every call.
The exposed bus is the scheduled decorator rather than that raw instance; use
`engine.messages` for publications and subscriptions. Lifecycle topic contracts
live in game-runtime; utilities remain generic.

## One-shot timers

Every loaded session creates a `TimerService`, exposed through `engine.timers`
only while running and through `session.timers` during host mounting. It uses
injected timing services and publishes `timer.wakeup` into the session bus.

```ts
await engine.start()
engine.messages?.subscribe('timer.wakeup', ({ timerId, dueAt, observedAt }) => {
  console.log(timerId, dueAt, observedAt)
})
const timerId = engine.timers?.schedule(1000)
// Delivery occurs automatically. To prevent a pending timer from publishing:
if (timerId !== undefined) engine.timers?.cancel(timerId)
```

`ITimerService.schedule(delayMs)` returns a session-local numeric `TimerId`.
Delays must be integer milliseconds from zero through `2_147_483_647`; invalid
delays throw `RangeError`. Even a zero-delay timer is deferred. Each wakeup carries
`{ timerId, dueAt, observedAt }` with timestamps from the monotonic clock.
Early callbacks rearm for the remaining duration; late callbacks publish once,
without replaying missed time. The bus preserves publication order rather than
sorting wakeups by deadline.

`cancel(id)` returns true only when it prevents a pending timer from publishing.
Once published, cancellation returns false and does not retract the queued
wakeup. Engine stop still discards queued gameplay triggers. Disposal cancels
pending callbacks and disables retained service references: scheduling returns
undefined and cancellation returns false. Stale callbacks cannot affect a new
session.

Timers continue counting while unfocused or hidden; browser execution may delay
their wakeups until the host resumes. Input focus resets do not pause timers.
Recurring timer APIs and pause policies remain future work. A subscriber can
schedule the next one-shot timer when appropriate. Game actions can associate
these host-time timers with named handlers, and elapsed world time chains its
own one-shot pulses as described below.

## Game actions and progression

`EngineRuntimeServices.createGameRules(game)` optionally supplies game-specific
TypeScript rules once per loaded session. Return fresh handler closures or
instances for each call so positions, inventory, weather, and other domain state
are session-owned. The action processor owns only routing and progression.
Without a factory, an engine has empty rules and action-driven world time; existing
JSON games keep their behavior and an idle session does not start polling.

Custom handler code must currently be supplied by application composition. Game
JSON schemas do not define executable rules, and the loader does not import game
scripts. Both application containers forward the supplied runtime services to
their engines, including the editor's fresh preview instances. The placeholder UI
is unchanged.

```ts
import {
  Engine,
  type EngineMessages,
  type GameActionHandler,
  type GameRulesFactory,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { createBrowserTiming } from '@ancadeba/ui-components'

const createGameRules: GameRulesFactory = (_game) => {
  let moves = 0
  let weather = 'clear'
  return {
    handlers: new Map<string, GameActionHandler>([
      [
        'move',
        () => {
          moves++
          return { status: 'applied', advanceTurn: true, worldTimeCostMs: 5000 }
        },
      ],
      [
        'inspect',
        () => {
          console.log({ moves, weather })
          return { status: 'applied' } // No turn or action-time cost.
        },
      ],
      [
        'weather',
        (_request, { actions }) => {
          weather = weather === 'clear' ? 'rain' : 'clear'
          actions.schedule('weather', 60000)
          return { status: 'applied' } // A timer does not inherently consume a turn.
        },
      ],
    ]),
    inputBindings: [{ context: 'gameplay', input: 'moveNorth', action: 'move' }],
    worldTime: { mode: 'hybrid', rate: 1, pulseMs: 1000 },
  }
}

const engine = new Engine(loader, host, logger, () => new MessageBus<EngineMessages>(), {
  ...createBrowserTiming(window),
  createGameRules,
})
await engine.start()
engine.messages?.subscribe('action.applied', ({ request, progression }) => {
  console.log(request.id, request.origin.type, progression)
})
engine.actions?.request('inspect')
engine.actions?.schedule('weather', 60000)
```

`GameRules.handlers` maps action IDs to synchronous `GameActionHandler` functions.
Each receives an `ActionRequest` and `{ progression, actions }`. Requests carry a
session-local numeric ID, action ID, optional payload, and an origin: direct,
captured virtual input, or timer wakeup. Payloads are passed by reference and must
be treated as immutable. Follow-up requests are queued rather than executed
recursively. Asynchronous work must submit a later request instead of returning
a promise from a handler.

`inputBindings` select a captured input context, input ID, and phase. Phase defaults
to `pressed`; `released` and `cancelled` require explicit bindings. Unmatched input
is ignored. A context change does not reinterpret already queued inputs.
Unknown target actions, duplicate context/input/phase tuples, invalid bindings,
and invalid world-time policies fail startup before mounting.

`IGameActions` is available as `engine.actions` only while running and as
`session.actions` during mounting. It exposes:

- `progression`: a frozen `{ turn, worldTimeMs }` snapshot of the latest synchronization.
- `request(action, payload?)`: queue a direct request and return its request ID.
- `schedule(action, delayMs, payload?)`: schedule a host-time action and return its `TimerId`.
- `cancelScheduled(timerId)`: cancel a pending action-service timer without affecting unrelated timers.

A timer wakeup queues its associated request once. Cancellation cannot retract a
wakeup already published to the bus. The processor handles requests in bus order,
with trigger translation, follow-up requests, and outcome delivery separated by
normal deferred batches. Handler maps and bindings are copied at session creation.

Handlers return `{ status: 'applied', advanceTurn?, worldTimeCostMs? }` or
`{ status: 'rejected', reason }`. Turn advancement defaults to false; time cost
defaults to zero and must be finite and nonnegative. Unknown action IDs produce
rejection. Exceptions, promises, and invalid results produce logged action
failures without stopping the engine or retrying. Rejection and failure commit no
turn or action-time cost. Handlers must validate before mutating domain state or
enqueuing effects; the processor does not roll those effects back.

The bus publishes `action.requested`, then `action.applied`, `action.rejected`, or
`action.failed`. Outcome messages capture the request and progression snapshot;
applied messages include the normalized outcome, rejected messages a reason, and
failed messages the error. `turn.advanced` and `world-time.advanced` carry
`{ previous, progression }` snapshots and are published only when values change.
An action's progression updates are committed together before its outcome is
queued, with turn notification preceding world-time notification when both change.

### Independent turns and world time

Every session starts at turn zero and world time zero. Only an applied action
with `advanceTurn: true` increments the turn, by exactly one. Accepted actions,
timer wakeups, and elapsed time never implicitly consume turns.

`GameRules.worldTime` selects one static per-session policy:

| Mode                      | Elapsed host time            | Accepted action costs |
| ------------------------- | ---------------------------- | --------------------- |
| `action-driven` (default) | Ignored                      | Added                 |
| `elapsed`                 | Added at the configured rate | Ignored               |
| `hybrid`                  | Added at the configured rate | Added independently   |

`rate` is a positive finite number of world milliseconds per host millisecond,
defaulting to one. `pulseMs` is an integer host delay from one through
`2_147_483_647`, defaulting to 1,000. Elapsed accounting begins when the session
becomes running, excluding loading and mounting time. It synchronizes before
each action and on an owned timer pulse using the injected monotonic clock at
processing time. Each elapsed interval is counted once; an action-cost jump does
not reset the elapsed anchor. Rejection or failure can still coincide with elapsed
world-time advancement because real time continued passing.

Late pulses account for the elapsed duration once and schedule the next pulse
from the current host time, without replaying missed intervals. Pulses publish
progression changes, not game-action outcomes. Time continues through hidden tabs,
focus loss, and input-context changes. Merely reading `progression` does not
synchronize it. Published snapshots remain unchanged as later actions execute.

Stop cancels action timers and world pulses, unsubscribes runtime handlers, and
disables retained action-service references. Request and schedule return undefined
after disposal; cancellation returns false. A handler that stops its session
cannot commit its returned result. Restart creates fresh progression and invokes
the rules factory again; stale callbacks cannot affect the new session.

Actor order, turn phases, world-time alarms, dynamic pause/resume, policy switching,
game-script loading, persistence, and visual gameplay rendering are not part of
this layer. In particular, scheduling an action uses host milliseconds, so an
action-time jump does not make a host timer due.

## Game-specific input

Games can add an optional `"input": "input.json"` reference to `game.json`.
The filename must be a single game-root JSON filename: letters, digits,
underscores, or hyphens followed by `.json`. Existing games can omit it.
Startup and export validate the referenced file before mounting or publishing.

```json
{
  "schema-version": "1.0.0",
  "virtual-keys": ["north", "confirm"],
  "keyboard": {
    "KeyW": "north",
    "ArrowUp": "north",
    "Enter": "confirm"
  },
  "contexts": {
    "gameplay": { "north": "moveNorth", "confirm": "interact" },
    "menu": { "north": "selectPrevious", "confirm": "accept" }
  },
  "initial-context": "gameplay"
}
```

The pipeline is physical keyboard position → game-defined virtual key →
context-specific virtual input. Keyboard bindings use `KeyboardEvent.code`,
so `KeyW` refers to a physical position even on a layout that types a different
character there. Context and control IDs follow the same naming rules as game
IDs. Virtual keys must be unique, references must exist, and every context must
contain at least one mapping. Multiple physical keys may share a virtual key,
and multiple virtual keys may share a virtual input.

`GameLoader` assembles a copied `GameData.input` without the file schema version.
Each running engine session creates its own `InputController`; `engine.input`
is available only while running and only when the game defines input. The host
receives it earlier through `mount(game, { input })` to attach browser listeners.
`InputData`, `IGameInput`, `VirtualInput`, and `EngineHostSession` are exported
from game-runtime. Browser adapters remain in ui-components.

```ts
await engine.start()
engine.messages?.subscribe('input.virtual', ({ context, input, phase }) => {
  console.log(context, input, phase)
})
engine.input?.pressKey('KeyW')
engine.input?.releaseKey('KeyW')
// Pressed and released arrive automatically in a later host task.
// Switching contexts immediately would not rewrite those queued payloads.
```

`input.virtual` carries `{ context, input, phase }`, where phase is `pressed`,
`released`, or `cancelled`. One press is published when an input becomes active,
and one release when its final contributing key is released. Each message captures
its context when published. A configured action binding can translate it into a
queued action; input receipt itself does not consume a turn.

`IGameInput` exposes `context`, `setContext(id)`, `isKeyMapped(code)`,
`pressKey(code)`, `releaseKey(code)`, and `reset()`. Press/release return whether
the transition belongs to a mapped input; duplicate presses do not publish again.
Selecting the current context does nothing; an unknown context throws. A context
change cancels active inputs and suppresses held keys until released. `reset()`
cancels active inputs and clears held state. Engine stop silently disposes the
controller before host cleanup, and retained references become inert.

The standalone game and editor preview use the same `bindKeyboardInput` adapter.
Their game surfaces are focusable without stealing focus. Focus the surface to
play; input in editor fields, editable game controls, or outside the game surface
is ignored. Losing focus, entering an editable control, hiding the document, or
blurring the window resets held input. Native keyboard repeat, composition, and
Ctrl/Alt/Meta shortcuts are ignored. Shift does not change physical bindings.
Releases of tracked keys are processed even when modifiers change. Only accepted
mapped bindings have their browser defaults prevented; mapped held repeats also
prevent defaults without generating inputs. Cleanup removes owned listeners.

This version supplies game defaults, press/release state, and one active named
context. Player remapping, persistence, chords, repeat policies, additional devices,
and JSON-defined executable rules are not implemented yet. Hosts do not flush the bus on keyboard
events; the session dispatcher schedules delivery.

## Queued messaging

`@ancadeba/utilities` exports `MessageBus<Topics>` and `IMessageBus<Topics>`.
Define a topic-to-payload interface and inject the bus into the systems that need
it. Create a bus for each engine session so sessions do not share messages or
subscriptions. The utility has no browser or Node dependencies.

```ts
import { MessageBus } from '@ancadeba/utilities'

interface GameplayMessages {
  'entity.destroyed': { entityId: string }
  'scene.loaded': { sceneId: string }
}

const messages = new MessageBus<GameplayMessages>()
const unsubscribe = messages.subscribe('entity.destroyed', ({ entityId }) => {
  scoreSystem.awardFor(entityId)
})

messages.publish('entity.destroyed', { entityId: 'enemy-42' })
messages.flush() // Call explicitly at the chosen point in an engine update.
unsubscribe() // Release the subscription when its owning system stops.
```

`publish` queues the payload by reference; treat it as immutable after publishing.
`flush` synchronously delivers only the messages queued when that flush began, in
publish order. Messages published by handlers wait for the next flush, and nested
flush calls do nothing. The generic `MessageBus` remains manually flushed;
engine sessions add the scheduled decorator described above.

An optional `flush((topic, payload) => boolean)` predicate runs once before each
message, including messages without subscribers. Returning false discards that
message; throwing discards it and contributes to the batch's `AggregateError`.
The decision applies to all subscribers of that message. A scheduled bus combines
an explicit predicate with its mandatory configured predicate, so callers cannot
bypass the session's stop rules.

Subscribers run in registration order and are selected at delivery time. New
subscriptions added by a handler start with the next message. Unsubscribing takes
effect immediately, including for messages already queued; the returned cleanup
function is safe to call repeatedly. Registering the same handler twice creates
two independent subscriptions. Messages flushed without subscribers are discarded.

Handlers must be synchronous. If they throw, the remaining handlers and messages
still run, then `flush` throws an `AggregateError` containing the failures. Failed
deliveries are not retried, and messages queued during that flush remain available
for the next call.

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
| `POST /api/exports`                    | Export the game selected by the JSON body `{ "path": "levels/demo" }` as a ZIP     |

Listings return `{ "entries": [{ "name": "levels", "type": "directory" }] }`,
with entry types `file` and `directory`. Links are omitted. File creation returns
`201`; replacement returns `204`. Empty and binary files are supported. Writes
are limited to 10 MiB, including requests without a content-length header.
Saves stage a complete file beside the destination before replacing it atomically.
Concurrent saves leave one complete version; they do not merge contents or detect
conflicting edits. Failed staging or replacement preserves the previous file.

Errors return `{ "error": "message" }`: `400` for invalid paths, `403` for
traversal or link access, `404` for missing resources, `409` for file/directory
conflicts, and `413` for oversized writes. Filesystem permission failures return
`403`; unexpected failures return `500`. Absolute paths, `..`, backslashes,
Windows device names, and alternate data streams are rejected. No rename,
delete, or concurrent-edit detection is provided. The editor UI does not yet
include a file browser or editor.

Export requests must use `Content-Type: application/json`. An empty `path` selects
the workspace root. Sources use the same path and link restrictions as the file
API; clients cannot supply filesystem output paths. The server runs the existing
export command in a child process and streams a ZIP with the standalone game's
files at its root. Temporary build files are removed after the download or a
failure, including disconnected clients. Only one export runs at a time; another
request receives HTTP 409. Invalid game builds return HTTP 422 with a retryable
error. Editor exports require the installed development workspace, shared package
builds, and the `tooling/export-game.ts` source, including when starting the compiled
editor server. The exported game itself has no such dependencies.

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

## Standalone game exports

Run from the repository root:

```sh
pnpm export:game sample-games/basic
pnpm export:game "path/to/my game" --out "dist/my-game"
```

The first command writes to `dist/games/basic`. Use `--out` to choose another
destination. Paths are relative to the current working directory. Shared
packages are compiled and the engine is typechecked first, then the exporter
validates the saved `game.json` and referenced scenes, then builds the engine with
Vite+. Export does not
require the engine's local `config.json`, the editor server, or any running
development instance.

```text
dist/games/basic/
  index.html
  config.json           # gameUrl: ./game/
  assets/               # Compiled engine JavaScript and CSS
  game/
    game.json
    ...                 # Game assets, preserving their paths and bytes
```

The exporter copies all regular game files, including unused assets. It excludes
source-control directories (`.git`, `.hg`, `.svn`), `node_modules`, `.env` and
`.env.*` files, and `.DS_Store`/`Thumbs.db`. Links and special files are rejected.
Exports use the same game data pipeline as engine startup. Missing or invalid
referenced scenes prevent export; other asset references are not yet validated.
Gameplay is not executed during export.

Exports are assembled in a temporary directory and published only after a
successful build. The destination must be new and must not overlap the source;
existing files and previous exports are not overwritten. Choose a new `--out`
directory for another export. Export never changes the source game or app configs.

Upload the complete output folder to a static HTTP(S) host. Relative engine and
game URLs allow moving it to a different directory or hosting it under a nested
path. Node.js, pnpm, the repository, and the editor API are not needed by the
deployed game. Opening `index.html` with `file://` is not supported.

For a local check, serve the export with a static server, for example:

```sh
pnpm exec vp preview --outDir dist/games/basic --port 5273
```

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
