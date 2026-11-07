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

| Command                    | Fields                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `game.updateMetadata`      | `title`, `description`, `version`                                                    |
| `scene.create`             | A complete `scene` matching the current scene schema                                 |
| `scene.updateMetadata`     | `sceneId`, `title`, `description`                                                    |
| `scene.updateLayout`       | `sceneId`, positive integer `rows` and `columns`                                     |
| `assets.upsertImage`       | `id`, complete `image` definition                                                    |
| `assets.upsertPart`        | `id`, complete `part` definition                                                     |
| `assets.upsertComposition` | `id`, complete `composition` definition                                              |
| `assets.remove`            | `kind` (`images`, `parts`, or `compositions`), `id`                                  |
| `scene.upsertGraphic`      | `sceneId`, complete graphic `component`                                              |
| `scene.removeGraphic`      | `sceneId`, `componentId`                                                             |
| `scene.setActionBar`       | `sceneId`, complete action-bar `component`, or `null` to remove it                   |
| `game.updateInput`         | `inputId`, complete input `input` definition                                         |
| `inventory.setItemActions` | `itemType`, map of item action IDs to requested actions and optional enable bindings |
| `scene.upsertNearby`       | `sceneId`, complete nearby `component` with entries and a description text target    |
| `scene.upsertStatusPanel`  | `sceneId`, complete status-panel `component`                                         |
| `scene.removeStatusPanel`  | `sceneId`, status `componentId`                                                      |

Scene creation updates both the scene document and the manifest reference.
Game IDs cannot be changed. Scene IDs support revision-checked rename commands.
Scenes support text, buttons, language selectors,
and graphics; the focused graphic commands edit only graphic components.
Inspection includes the referenced input definition as `input`. Input edits update
that file. Creating the first input configuration publishes `input/<inputId>.json`
before adding its manifest reference, with the same guarded rollback used for
other newly referenced files. Existing unlisted files are protected.

Graphic components can be created, edited, and removed without changing other
component types. The first asset operation initializes `assets/catalogue.json` and its
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

The editor starts with only the Project explorer visible. Select an existing game
and choose Open project. The folder and load controls collapse after opening a
project, and the navigation tree remains visible. Use Open another project to
show the folder controls again.

Choose **New project** beside **Open project** to create a game, including when the
workspace is empty. Enter a title, a new folder name, and an optional description.
Folder names contain up to 64 letters, digits, underscores, or hyphens; the folder
is created directly beneath the configured workspace and is also the game's ID.
Existing folders and files are never reused. Creation opens the project with a
start screen, a New game button, and an editable adventure scene with a Main menu
button. The starter game can be previewed and exported immediately. Its initial
content is English, independently of the editor language. Its `theme.css` file
sets readable text sizes for both editor previews and standalone exports.

Opening or creating a project asks before discarding unsaved edits. Cancelling
or a failed creation preserves the current project and its drafts. Failed storage
operations roll back unchanged starter files; if external changes prevent cleanup,
the error identifies the folder to inspect before retrying.

`POST /api/editor/projects` accepts JSON `{ "path": "my-game", "title": "My game",
"description": "" }` and returns the new project view with a revision and HTTP 201.
Invalid input returns 400, an existing destination returns 409, and links remain
inaccessible. Creation reserves a new folder exclusively and publishes `game.json`
after both scene files. The MCP editing tools continue to target existing games.

The searchable tree contains Game properties, Scenes with their components,
and Assets grouped into Images, Parts, and Compositions. Scene types and the
startup scene are labeled. Shared assets appear once in the asset library.

Select an entry to open its editing controls. Scene branches include Add graphic;
Scenes includes Add scene; Assets includes image import and definition creation.

**Undo** and **Redo** in the project toolbar restore saved editor changes, including
component edits, ordering and deletion, scene creation/renaming/deletion, shared
definitions, metadata, and image imports. Each successful save is one history step.
Undo restores exact previous file contents; redo reapplies the saved contents.
Saving a different change after undo clears the redo branch. Failed and unchanged
commands do not create steps. New-project creation itself is not undoable.

Use Ctrl/Cmd+Z for undo, Ctrl/Cmd+Shift+Z or Ctrl+Y for redo outside text fields.
Inside editable fields those keys retain normal text-editing behavior. Save or
discard all pending drafts before using project history. History changes refresh
the explorer, editing fields, and preview; if the selected entry disappears, the
editor selects an available scene.

History is shared by clients of the same editor server, kept separately per project,
and retained while opening another project or reloading the page. It is held in
memory for the server session, with at most 50 steps per project and a 64 MiB total
file-content budget; older history is evicted when necessary. Restarting the server
clears it. External changes to referenced files clear a project's history. Revision
checks and exact-byte checks on every restored file prevent undo/redo from silently
overwriting outside edits, including unreferenced files. A failed replay clears
that project's history and asks for inspection if rollback cannot be confirmed.
The restore path has guarded rollback, but no cross-process transaction or crash journal.

`POST /api/editor/history` accepts `{ path, expectedRevision, direction }`, where
`direction` is `undo` or `redo`. It replays server-owned history only and returns a
project view. Inspected views include history availability and next-step labels.

Select a scene to **Rename scene ID**, **Duplicate scene**, **Use as startup scene**,
or **Delete scene**. The existing scene title field changes its display name.
Renaming the ID updates the manifest, scene filename, startup selection, button
and action-bar links, rule transitions and conditions, dialogue choices, quest
conditions, and combat outcome destinations. It preserves source text, translation
keys, and extension data. Case-only ID changes and existing destination files are
rejected, including orphan files outside the manifest.

Duplicating uses a new ID and title and copies all components and extension data.
Direct self-navigation points to the copy. Inventory, combat, dialogue, quest,
map, asset, and rule definitions remain shared game resources. The duplicate has
its own literal title; the source title translation key is not copied. A duplicate
becomes selected after saving, without changing the startup scene.

Deletion asks for confirmation. **Redirect links to** selects an optional replacement
for incoming links and scene conditions. Without a replacement, referenced scenes
cannot be deleted; diagnostics identify the files and fields to update. A replacement
must satisfy each reference's scene-type and map requirements. Deleting the startup
scene selects the replacement or first remaining scene. The last scene cannot be
deleted. Shared resources are retained. Select any component in the explorer to
**Delete component**; references must be updated before a used component can be removed.
Select a component to **Duplicate component**, **Move component up**, or
**Move component down**. Duplication suggests an unused ID and inserts the full copy
immediately after its source, selecting the copy after saving. Settings, translation
keys, extension data, and grid placement are preserved; referenced game resources
and other components remain shared. Copies initially overlap their source until
their placement is edited. Action bars, shops, and combat components cannot be
duplicated because each is limited to one per scene. They can still be reordered.
Moving changes the saved component array order (and explorer/runtime render order),
without changing grid coordinates. Move buttons are disabled at the list boundaries.
**Discard component-control draft** resets the duplicate ID entry.

Select a component and choose **Copy component**, then select a destination scene
and choose **Paste component**. Paste is also available while another component
in that scene is selected. The editor clipboard captures the saved source, including
nested extension data. Later edits, renaming, or deletion of the source do not
change the captured component. Copy does not write files or create an undo step;
each successful paste is a normal, undoable save and selects the new component.

Paste suggests the source ID when it is unused, otherwise an unused `-copy` ID.
It appends the component to the destination list and suggests placement that fits
the destination grid, reducing spans if necessary. Edit the ID and placement before
pasting. The source stays unchanged. Placement extensions and all other settings
are retained. Adjust placement if the copy overlaps an existing component.

Referenced assets, maps, rules, and other game resources remain shared. Local
component references keep their IDs and must resolve in the destination; paste
referenced text/inventory/nearby components first if needed. Scene-type restrictions,
singleton limits, ID collisions, grid bounds, and resource references are validated
before saving. A rejected paste preserves the draft and reports diagnostics.
Save or discard other edits before copying or pasting. **Discard paste draft** resets
the destination fields; **Clear component clipboard** removes the saved snapshot.
The clipboard stays available across scene selections, undo/redo, and saves within
the open project, and clears when another project is opened or the page reloads.
It is an editor clipboard, separate from the operating system's text clipboard.

With a component selected, use **Ctrl/Cmd+C** to copy, **Ctrl/Cmd+D** to duplicate,
and **Delete** or **Backspace** to delete. Deletion uses the same confirmation as
the button. **Ctrl/Cmd+V** pastes into the selected scene or the scene containing
the selected component, using the current suggested ID and placement (or the
edited paste fields). Button tooltips and `aria-keyshortcuts` expose these bindings.
The shortcuts use the same validation, draft guards, and undoable save operations
as the buttons; duplicating or deleting also requires discarding a component-control
draft first. Singleton components cannot be duplicated.

Shortcuts leave text inputs, textareas, selectors, editable text, dialogs, project
opening/creation forms, and the game preview alone. Selecting read-only text keeps
native copy/delete behavior. Repeated keydown events, IME composition, busy saves,
and unresolved project conflicts do not trigger editor shortcuts. Ordinary browser
shortcuts remain available when no applicable editor selection or clipboard exists.

`POST /api/editor/components/copy` accepts `{ path, expectedRevision, sceneId,
componentId }` and returns `{ revision, component }`. The `scene.pasteComponent`
command accepts `sceneId`, `newId`, the complete JSON `component`, and optional
`placement`. Copy checks the inspected source revision; paste checks the current
destination revision through the ordinary command endpoint.
Save or discard other panels' drafts before structural changes. Failed commands
preserve entries, and **Discard scene-control draft** resets the scene controls.

The commands are `scene.rename` (`sceneId`, `newId`), `scene.duplicate` (`sceneId`,
`newId`, `title`), `scene.remove` (`sceneId`, optional `replacementScene`),
`game.setInitialScene` (`sceneId`), and `scene.removeComponent` (`sceneId`,
`componentId`), `scene.duplicateComponent` (`sceneId`, `componentId`, `newId`), and
`scene.moveComponent` (`sceneId`, `componentId`, zero-based final `index`). They use
the same inspected revision as other authoring commands.
Multi-file scene changes reserve new files exclusively, publish references and the
manifest before deleting old scenes, and attempt byte-checked rollback on storage
failures. An uncertain result asks for inspection before retrying. This protects
same-server commands; it does not add a cross-process transaction or crash journal.

Expand a scene and choose **Add component** to create text, buttons, map views,
language selectors, or quest logs. Choose a type, set its unique ID, edit its
settings, and choose **Create component**. Suggested placements fit the scene's
grid; edit Row, Column, and spans to position the component. Saving selects the new
component in the explorer, where **Save component** updates it in place. New saves
use `scene.upsertComponent` with `createOnly: true`, so an ID collision cannot
replace an existing component. Conflicts and rejected settings preserve the draft.
Save or discard edits before switching the component type or another component.
**Cancel** returns to the scene without saving.

Text supports literal content, existing translation keys, heading/body styles,
and alignment. Buttons support scene navigation, starting a new game, rule actions,
and map movement. New-game targets list only game scenes. A button without an action
is disabled during play. Map views choose existing map definitions from the game
manifest and configure their visible area, interactivity, and optional player
marker with zero-based coordinates. Add map files and manifest references outside
the editor when none are registered. Invalid view dimensions and blocked or
out-of-bounds player spawns are rejected. Language selectors use the manifest's
configured languages and catalogs; they remain disabled in play until those exist.

Asset groups display filtered thumbnail galleries. Selecting a thumbnail also
selects and reveals the corresponding tree entry. Action-bar components open their
slot editor. Other component types display their definitions. Engine preview is collapsible and has an
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

### Status panels

Open **Status panels** in the explorer, or select a status-panel component in a
scene. Choose the game scene and panel, or use **Add status panel**. Configure its
title, character name, optional portrait, translations, and grid placement.
Add **value rows** for text or numbers and **resource bars** for current/maximum
numeric values. Each value can be a constant or an existing game-state or
progression binding. State choices are filtered by compatible types. Bars can
have a six-digit hex color; an empty color uses the game's theme.

Add status effects with labels, descriptions, optional catalog icons, and boolean
visibility bindings. Descriptions appear on pointer hover or keyboard focus;
Escape dismisses them. Use the move and remove controls to order rows and effects.
**Save status panel** uses the current project revision. Conflicts preserve the
draft, and unsaved drafts block switching scenes or panels. **Discard status-panel
draft** restores the saved configuration. **Remove status panel** removes the
selected saved panel. Other panels' unsaved edits remain available.

Missing or invalid bindings produce an unavailable display, with diagnostics in
editor preview. Resource bars require actual finite numeric values and a positive
maximum; they never substitute a string fallback as a resource amount. Rule edits
cannot remove or change the types of declared fields used by a saved status panel
until those bindings are updated. Status panels display values; game rules own
resource changes and effect timing.

### Action bars and input bindings

Open **Action bar & input** in the explorer, or select an action-bar component in
a scene. **Scene action bar** provides a five-column, three-row slot grid, bar
placement, and component ID. Choose a slot to edit its label, translation key,
requested action or scene navigation, boolean enable condition, and context/input
binding. Choose **Empty slot** to clear a position. Bars can be added to game
scenes and removed using the panel's controls.

Choose **Move on map** as a slot's action type to expose directional movement.
Select **Target map view** from the interactive maps in that scene and choose
**Direction** (`north`, `east`, `south`, or `west`). The map must have a player
spawn and must not set `interactive: false`. Save those map settings in the
project files before configuring movement slots. Each slot can use any of the
game's existing context/input bindings. Buttons disable for blocked destinations
and while a step is underway. The Coast Road sample demonstrates this setup.

**Game input bindings** edits the existing physical-key → virtual-key →
context-specific input pipeline. Configure virtual keys, physical keyboard codes,
context mappings, and the initial context. Multiple physical keys can map to the
same virtual key. Duplicate physical codes or virtual-key mappings within a
context produce an error and retain the draft. Changes that would invalidate a
saved bar's input references are rejected.

Games without input can create a configuration. Its editable starting layout is
`QWERT / ASDFG / ZXCVB`, mapped to inputs `slot-1` through `slot-15`. Save input
changes before assigning newly created inputs to slots. The slot editor shows all
saved physical shortcuts for each binding. Both forms use revision-checked saves,
keep their drafts on conflicts, and preserve drafts in the other form after a save.
Restart the preview to load the saved configuration.

To populate a slot from inventory selection, choose **Selected inventory item** as
its action type, select an inventory panel from the same scene, and enter an item
action ID. The `inspect` ID uses the item's inspection definition. Under **Rules →
Trigger links → Selected-item actions**, configure additional IDs such as `read`
or `use`, their requested game actions, and boolean enable conditions. Requests
include the selected item ID as their payload, supporting `payload-is-item` rules.
Only applicable item actions appear in the reserved slots. Scene commands remain
available beside them. Inventory names become selectable in linked read-only
panels, and **Clear selection** removes their contextual actions.

Under **Rules → Trigger links → Inventory inspection**, set **Show inspection in
inventory** to **Hide inline inspection** to remove the inventory Inspect button
and result. This keeps its action available to contextual slots. Existing games
retain inline inspection when this setting is omitted.

To place results in the main narrative, add a string state field in **Rules**, have
the inspection action set that field, and bind it in the scene's main text with an
alias such as `{{inspection}}`. The basic sample uses `inspectionResult` for this
purpose. Its rules clear the result after other actions and show it again on
reinspection, without repeating discovery effects.

Configure nearby entries under **Rules → Trigger links → Nearby characters and
objects**. Choose the game scene and the **Description text component** that will
show selected descriptions. Set the panel title and grid placement, then add
targets using stable IDs. Each target has a character/object kind, a label,
description, optional translations, and an optional boolean visibility condition.
Add action IDs such as `talk`, `examine`, or `take`, choose their requested game
actions, and optionally set enable conditions. Save the nearby panel before
assigning its action-bar slots. **Discard nearby draft** restores the saved panel;
unsaved drafts prevent switching scenes.

In **Action bar & input**, choose **Selected nearby target** as the slot action
type, choose its **Nearby panel**, and enter the **Target action ID**. Configure
the slot's label and input binding as usual. Unsupported actions leave their
reserved cells empty. Scene and inventory commands remain in their own slots.
Use the **Request is for nearby target** rule condition to match a selected target
ID. Action results can use the same main-text state bindings as item inspection.

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

The editor does not include scripts, command batches, real-time collaboration,
or embedded chat. The [MCP adapter](editor-mcp.md) exposes authoring operations
to an external coding agent; those saves share the server's project history.

## Item details and equipment

Choose **Items & equipment** to edit an item type's name, description, large
artwork, and ordered display properties. Each string can use a language-catalog
key. Properties accept literal text, finite numbers, or existing scalar state
bindings; they do not calculate stats or change game state. Artwork accepts an
image, part, or composition from the game asset catalog. The instance's dyes
apply to image and part artwork.

Select an inventory panel as the editing target to choose its **Main text details
target**. The selected item's section is appended to that text alongside nearby
descriptions and inspection results. Clearing selection removes only the item
section. Add an **item-details** view for a separate artwork and details panel;
both presentation styles may be used together. Linked views share the inventory
panel's selection, even without an action bar, and include nested and worn items.

Add an **equipment** view, choose its source inventory and owner, and set its
grid columns and optional ordered slot IDs. Unlisted owner slots follow in their
declared order. The owner must appear in the source inventory. **Owner slots**
edits their names and declarations; reference checks prevent removing occupied
or referenced slots. Item compatibility remains declared by `equipmentSlots` on
item types in the inventory file.

```json
{
  "id": "equipment",
  "type": "equipment",
  "inventory": "items",
  "owner": "player",
  "columns": 2,
  "order": ["outerwear", "back"],
  "placement": { "row": 7, "column": 7, "rowSpan": 3, "columnSpan": 6 }
}
```

In **Action bar & input**, choose **Equipment command**, select an equipment
view, and choose **equip** or **unequip**. Bind it through the game's normal input
configuration, or leave it click-only. Occupied slot item buttons select the worn
item for inspection; separate named slot buttons select an equip destination.
An item with exactly one compatible slot selects it automatically. Multiple
compatible slots require an explicit choice. Incompatible destinations leave
Equip disabled. A read-only equipment view still allows inspection.

Equip requires the item to belong to that owner, including items inside owned
containers. Replacement places the displaced item in the same owner's carried
inventory and commits both placements together. Use existing inventory Move
controls to transfer ownership first. Unequip returns the item to its owner's
carried inventory. Neither operation advances turns or game time, and existing
Move behavior still rejects occupied slots. Queued keyboard gestures retain
their original scene, item, and destination rather than following later changes.

The basic sample demonstrates localized main-text details. The graphics sample's
wardrobe demonstrates larger artwork, two dyed cloaks for replacement, paper-doll
updates, and Q/W equipment commands. Saves use the shared revision checks;
conflicts and unrelated saves preserve item drafts until saved or discarded.

## Shops and trading

Choose **Shops & trading**, select a game scene, and add a shop. Choose the player
and merchant inventory owners and their panel IDs, labels, and placements. Saving
also saves these two panels as read-only, single-owner inventories. They retain
item selection and custom item actions, but do not expose free Move controls.
Each scene supports one shop, with distinct participant owners.

Choose a declared numeric **Player balance field** such as `player.gold`, a
currency label or translation, and either finite merchant funds with a different
balance field or unlimited funds. Each shop uses one currency; other shops may
use different currencies and balance fields. Balances and prices use nonnegative
safe integers, including zero. Missing or invalid amounts never fall back to a
binding's text fallback.

Add explicit buy and/or sell prices per item type. Each direction can be disabled,
fixed, or bound to an existing numeric field. Display properties such as Value do
not set prices. An item without a price for its direction remains inspectable and
shows an unavailable price badge. The quote explains affordability and eligibility.
Existing catalog artwork and instance dyes remain available in item-details views.

```json
{
  "id": "shop",
  "type": "shop",
  "placement": { "row": 8, "column": 1, "rowSpan": 2, "columnSpan": 12 },
  "playerInventory": "player-items",
  "merchantInventory": "merchant-items",
  "currency": "Gold",
  "playerBalance": { "source": "game.state", "path": ["player", "gold"] },
  "merchantFunds": {
    "type": "finite",
    "balance": { "source": "game.state", "path": ["merchantGold"] }
  },
  "prices": { "postcard": { "buy": 5, "sell": 3 } },
  "feedbackTarget": "narrative"
}
```

In **Action bar & input**, choose **Shop command**, its shop, and Buy or Sell.
Use the game's existing input mappings or leave commands click-only. Selecting
an item clears the other shop panel's selection, giving one active quote. Each
successful command trades one existing instance, clears the selection, and does
not advance turns or game time. Stock is finite. Sold items become merchant stock
and can be bought again if their item type has a buy price.

Items inside owned containers can be traded individually. Equipped items must
first be unequipped, and containers must be empty. Ownership and all payments
commit together; rejected trades change neither. Unlimited merchants change only
the player's balance. Observer failures occur after the complete commit and do
not cause a retry. Queued shortcuts retain their original scene, selected item,
ownership, and price rather than following later changes.

Shop messages can be customized and translated in **Trade feedback and
translations**, using `{item}`, `{price}`, and `{currency}` tokens. Templates and
item labels render as literal text. The shop always shows feedback and can append
its latest result to an existing main-text component without replacing item,
nearby, or inspection sections. Shop feedback resets on scene changes; ownership
and balances persist until New Game. Revision conflicts and unrelated saves
preserve dirty shop drafts. Removing referenced shops, owners, item types, or
numeric fields produces validation errors.

The basic sample's museum kiosk uses the same `player.gold` field as its status
panel, a finite merchant wallet, and Q/W trade commands. Select the kiosk in the
museum's Nearby panel and use Visit shop. The graphics wardrobe links to a ranger
shop with unlimited merchant funds, E/R commands, dyed stock, and larger artwork.

### Code-hosted games

`game.trading` exposes selection snapshots, quotes, eligibility checks, trades,
feedback, and change subscriptions. Authored rule games automatically receive a
transaction adapter for their declared numeric Map fields. Bindings remain
read-only. A custom host supplies `EngineRuntimeServices.createTradeState(game)`
returning `ITradeState`; `MapTradeState` is available for Map-backed hosts. The
shop's numeric fields must still be declared in its rule data for validation.

Adapter `prepare(writes)` must validate the whole batch without mutation or
notifications, returning `undefined` when unsupported. A prepared batch exposes
`isCurrent()` and a synchronous, infallible `commit()` that invokes no observers.
The runtime revalidates before committing both prepared state writes and the
prepared inventory transfer, then invalidates bindings and notifies views. Custom
inventory implementations may supply `prepareTransfer` with the same preparation
and commit guarantees. Without supported adapters, trade commands are disabled.

V1 excludes baskets, barter, quantities, generated or replenishing stock, pricing
formulas, haggling, currency conversion, buyback history, and trade time costs.

## Dialogue and quests

Open **Dialogue & quests** in the editor to create branching conversations and
linear quests. These are optional resources; existing games need no migration.
Add their IDs to `game.json`:

```json
{ "dialogues": ["curator"], "quests": ["harbour-survey"] }
```

Definitions live in `dialogues/<id>.json` and `quests/<id>.json`. Each has
`"schema-version": "1.0.0"`, its manifest ID, and a `label` or `labelKey`.
Labels, descriptions, dialogue text and speakers, rewards, and feedback support
the game's language catalogs. Editor saves check the inspected revision and
preserve extension properties. Conflicting drafts remain available to review.

### Conversations

```json
{
  "schema-version": "1.0.0",
  "id": "curator",
  "label": "The curator's request",
  "entry": "hello",
  "nodes": {
    "hello": {
      "lines": [{ "speaker": "Curator", "text": "Can you survey the harbour?" }],
      "choices": [
        {
          "id": "accept",
          "label": "I will help.",
          "when": [{ "type": "quest-state", "quest": "harbour-survey", "status": "not-started" }],
          "effects": [{ "type": "start-quest", "quest": "harbour-survey" }],
          "next": "accepted"
        }
      ]
    },
    "accepted": {
      "terminal": true,
      "lines": [{ "speaker": "Curator", "text": "Visit the harbour, then return here." }]
    }
  }
}
```

Nearby entries can set `dialogue: "curator"`. Selection still displays their
description in the nearby panel's existing `descriptionTarget`. Dialogue is
appended there too. A `dialogue-action` slot references that nearby component:

```json
{
  "label": "Talk",
  "action": { "type": "dialogue-action", "nearby": "nearby", "command": { "type": "start" } },
  "inputBinding": { "context": "gameplay", "input": "slot-11" }
}
```

Other commands are `choose` with `position: 1` through `15`, `end`,
`previous-page`, and `next-page`. Reply slots show the current choice labels.
Configure contiguous reply positions starting at 1 and an End command. Add both
page commands when a node contains more choices than the configured reply slots.
Hidden choices leave blank positions; disabled choices remain visible with their
unavailable explanation. Keyboard mappings stay in the existing input file.

Each choice has an ID and either `next` or `end: true`. `visibleWhen` and `when`
are lists of conditions that must all match. Effects can set declared state,
append to the existing log, start a quest, or complete a ready quest. A choice
can optionally set `scene` for navigation after commit.
There are no automatic node-entry effects or arbitrary code effects.

Leaving a scene, selecting another participant, or hiding the participant pauses
the conversation. Talk resumes its node and checks choices again. Finished
exchanges restart at the entry node on the next Talk. By default identity is
scoped to scene, nearby component, entry, and dialogue. An optional nearby-entry
`conversationId` shares one conversation across scenes; every reference to that
identity must use the same dialogue. Only one conversation is active at a time.

Lines can use existing `{{alias}}` text bindings. Values are captured when each
line enters the transcript; changing language re-renders definition references
with those captured values and does not repeat effects. Without a `bindings`
map, braces remain literal. Missing values use the binding fallback and a
localized diagnostic. `transcriptCapacity` bounds retained lines and replies.

### Quest stages, hand-ins, and rewards

A quest has ordered `stages`, each with an ID and `objectives`. Each objective
has an ID, label, and `when` conditions or numeric `progress`, for example:

```json
{
  "id": "experience",
  "label": "Earn five XP",
  "progress": {
    "binding": { "source": "game.state", "path": ["player", "experience"] },
    "target": 5
  }
}
```

Supported world conditions are `scene-is`, `state-is`, `state-compare` with
`eq/gte/lte/gt/lt`, `item-carried-by`, `item-owned-by`, `quest-state`, and
`combat-outcome` (`victory/defeat/escaped`). Owned-item checks include containers;
carried-item checks retain their direct-carried meaning. Combat checks only read
recorded outcomes and never start encounters. Conditions also work in authored
rules, alongside the existing payload conditions.

Quests start explicitly, advance intermediate stages at completed transaction
boundaries, and become `ready` when final objectives and required possessions
are satisfied. Readiness can revert to `active` before turn-in. Completion is
explicit and terminal. Existing facts can satisfy objectives when accepting a
quest; authors maintain counters through existing rules.

`handIns` name exact `item` instances and their required `owner`. Use
`operation: "consume"`, or `operation: "transfer"` with a distinct `recipient`.
Nested items are supported. Equipped items, nonempty containers, and items
reserved by combat plans cannot be handed in. Matching item types never
substitute for the authored instance.

`rewards.numeric` uses the existing `{ id, label, field, amount }` reward format.
Amounts are fixed nonnegative safe integers. XP rewards use the leveling
transaction path. `rewards.items` contains `{ id, itemType, colors? }` entries and
requires `rewards.recipient`. Generated IDs are stable:
`quest-reward-<quest-ID-length>-<quest-ID>-<reward-ID>`. Items are finite and
delivered to the recipient's carried inventory.

Hand-ins, rewards, level gains, related state/log effects, completion, and the
dialogue cursor commit together before observers run. Failure changes nothing;
observer failure keeps the completed result without retrying it. Commands spend
no game turn or world time. New Game resets quests and conversations.

### Journal and runtime services

Add a `quest-log` scene component with normal grid placement, optional `quests`
IDs, `statuses` filters (default active/ready/completed), and optional `textTarget`.
Select a quest for details. `quest-action` slots use `operation: "start"`,
`"turn-in"`, `"track"`, or `"untrack"` and reference either a fixed `quest` or
a `journal` component for its selection. One quest can be tracked globally.

`game.quests` and `game.dialogue` expose snapshots, eligibility, captured requests,
text, and subscriptions. Read-only bindings use `game.quests` paths
`[questId, "status" | "stage" | "tracked"]`. Queued shortcuts retain their scene,
participant, page/choice, journal selection, and world facts; stale commands are
discarded and held-key terminal phases stay consumed.

Authored games receive declared numeric and string/boolean transaction adapters.
Custom hosts can supply `createStateTransactions` and
`createStoryStateTransactions`; `MapStoryState` supports declared Map fields and
an optional staged log adapter. Preparation must be pure, and commits synchronous,
infallible, and observer-free. Custom inventories can implement
`prepareTransaction` to stage creation, removal, and transfers together. Missing
capabilities disable the affected operation with a reason; bindings stay read-only.

The basic sample demonstrates a localized curator survey. The graphics sample's
ranger post demonstrates an exact-letter transfer, XP/level gains, and a dyed
cloak reward. Repeatable or failed quests, branching quest stages, deadlines,
procedural dialogue, type-matched hand-ins, and random quest rewards are deferred.
