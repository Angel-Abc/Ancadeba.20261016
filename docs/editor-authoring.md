# Shared editor layer v1

The visual editor creates starter games and edits projects through a
revision-checked HTTP API. External agents use the same API for supported edits;
the MCP adapter exposes all shared editor commands known to its installed version,
filtered by the connected server's capabilities. The editor core depends on the schemas and
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
separate. Preview and export load saved source files through the game data pipeline.

## Supported operations

Each request contains one command. Metadata commands supply all listed fields.
The table below highlights core operations; `GET /api/editor/capabilities` supplies
the complete command list, schemas, and examples, including gameplay authoring.

| Command                    | Fields                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `game.updateMetadata`      | `title`, `description`, `version`; optional `titleKey`, `descriptionKey`             |
| `scene.create`             | A complete `scene` matching the current scene schema                                 |
| `scene.updateMetadata`     | `sceneId`, `title`, `description`; optional `titleKey`, `descriptionKey`             |
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
Metadata commands accept translation-key strings to assign them, or `null` to
remove them. Omitting either key preserves its existing value for older clients.
Referenced keys must exist in the default-language catalog; title translations
must be nonempty. Clearing a title key requires a nonempty literal title.
Game IDs cannot be changed. Scene IDs support revision-checked rename commands.
Scenes support the runtime's component types, including inventory, maps, combat,
dialogue interactions, and quests; the focused graphic commands edit only graphic components.
Inspection includes the referenced input definition as `input`. Input edits update
that file. Creating the first input configuration publishes `input/<inputId>.json`
before adding its manifest reference, with the same guarded rollback used for
other newly referenced files. Existing unlisted files are protected.

Graphic components can be created, edited, and removed without changing other
component types. The first asset operation initializes `assets/catalogue.json` and its
manifest reference. Inspection includes the parsed catalogue as `assets` when
present. See [the graphics guide](asset-workshop.md) for source and composition
formats, palettes, and game-state bindings.

**Assets → Add definition**, or selecting a saved part/composition, opens visual
authoring for pieces, transforms, color mappings, palettes, layer order, destination
anchors and slot choices. A live runtime preview marks attachment points.
**Save parts and compositions** saves related changes together through
`assets.updateDefinitions`; invalid references retain the draft for correction.
See [visual graphics authoring](asset-workshop.md#visual-part-authoring) for the workflow.

Scene graphics expose visual controls for static colors, palettes, visibility,
composition slot selections and typed game-state bindings. The per-instance draft
has a live preview for static fallbacks or authored starting values, and preserves
edits on validation failures and conflicts. See
[scene appearance authoring](asset-workshop.md#visual-scene-appearance-authoring).

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
diagnostics. An existing folder without a manifest opens for recovery; a missing
folder remains a 404. Commands require a valid
project; use the repair panel below to correct invalid source files before retrying.

## Repairing invalid projects

Opening a project with diagnostics shows **Repair project** above the normal
editing forms, even when `game.json` cannot be parsed. Select a **Project file**
to see its original JSON or CSS and file-specific diagnostics. Referenced missing
files appear as missing entries and can be created by supplying their contents.
When the manifest itself is damaged, repair it first; saving it discovers the
definitions referenced by the corrected manifest.

Folders containing recognizable game-resource directories remain in the project
list with a **missing game.json — recover** label. Open one normally, or choose
**Recover project** to enter another existing workspace-relative folder path.
Leave the path blank for the workspace root. Inspection never creates folders or
files, and opening recovery uses the usual unsaved-draft guard.

In **Repair project**, paste a backup into the missing `game.json` entry, or choose
**Generate manifest draft**. The draft lists surviving scene, map, inventory, rule,
story, leveling, and combat JSON filenames. It selects an asset catalogue, input
file, or root stylesheet only when there is exactly one candidate, and includes
language directories. It may include unused definitions; review references,
game ID, title, version, and startup scene before checking and saving. Original
metadata and the intended startup scene cannot be reconstructed from filenames.
Ambiguous references can be edited directly. Generating a draft never writes
files or replaces an existing repair draft.

**Check repair** previews the selected manifest against surviving resources.
**Save repair** creates only `game.json` and leaves all other files unchanged.
If another client creates the manifest first, recovery refuses to overwrite it.
Undo removes the newly recovered manifest and returns to recovery; Redo restores
it. Missing-manifest views include `recoveryManifest`, an optional suggested JSON
text, and discovery entries use `missingManifest: true`. Recovery uses the same
revision-checked repair endpoints and draft recovery as other repairs.

Edit **Repair source**, then choose **Check repair**. This reads a candidate project
without writing files and previews all remaining diagnostics, including problems
revealed by new manifest references. **Save repair** becomes available after a
check; further typing requires another check. JSON must be syntactically valid,
but schema and reference problems may be fixed incrementally. The save button
shows when problems remain. Ordinary authoring resumes when diagnostics are clear.
Image source bytes can be replaced through Assets; the repair panel edits the
catalogue and other text definitions.
Multiple missing or invalid images can be replaced one at a time in Assets.
Each replacement must validate; diagnostics for other broken images remain until
they are repaired. Unused broken images can also be removed incrementally.

Repairs retain exact submitted text, use the inspected revision, and participate
in shared Undo/Redo. Undo restores even malformed original bytes or removes a
newly created missing definition. Conflicts and failed saves keep the repair
draft. **Reload latest (keep entries)** preserves its text and updates the saved
source available for comparison; check the draft again before saving. Repair
drafts also participate in browser draft recovery, close warnings, and export's
unsaved-changes warning.

`POST /api/editor/repair/check` and `POST /api/editor/repair` accept
`{ path, expectedRevision, file, text }`. Check returns `{ revision, diagnostics }`;
save returns the updated `ProjectView`. An invalid project's view includes
`repairFiles`, mapping inspected definition paths to original text or `null` for
missing files. Only those paths are eligible for repair, with a 4 MiB text limit.
Both operations recheck revisions; writes use guarded publication and history.
The server advertises `features.projectRepair` when this support is available.
A post-save reread failure reports `repair_save_uncertain` and asks callers to
reload and inspect before retrying.

## Revisions and persistence

Revisions hash the exact bytes of the manifest and its referenced scene, map, input,
inventory, rule, story, combat, leveling, language, and stylesheet files.
They survive server restarts and detect direct file edits, including
formatting changes. Unreferenced files do not affect the revision. Asset catalogues
and all registered image source bytes do affect it. Inspection validates source
bounds, format, SVG profile, and color-slot declarations. Replacing or unregistering
unused broken images is permitted incrementally; existing source diagnostics for
other images may remain. A repaired image and all structural references must validate.
While the manifest is missing, the recovery revision also covers its suggested
reference list, so discovering different candidate filenames requires a fresh check.

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

Removing an unused dialogue, quest, combat encounter, combat library, or leveling
profile removes both its manifest reference and its definition file. The manifest
is published before file removal, and failures use guarded rollback without
overwriting outside edits. Undo restores the exact original bytes and references;
redo removes them again. Once removed, the ID can be used for a new definition.
Referenced definitions must have their incoming links removed before deletion.

## Visual editor

The editor keeps local recovery copies of unsaved drafts, including maps, gameplay
definitions, components, localization, stylesheets, and metadata. Copies are scoped
to the project and browser tab. After reopening the editor at the same address,
open the same project and choose **Restore drafts** or **Discard recovery copy**
in the project explorer. Restoring never saves game files automatically; save each
edited section when ready. Successful saves and explicit draft discards clear that
tab's recovery copy once no unsaved work remains.

Recovered drafts retain their original project revision. If saved files changed
since the copy was made, the editor reports the change and revision checks prevent
an overwrite. Review the newer files with **Reload latest (keep entries)** before
deliberately saving recovered edits. Other tabs' recovery copies remain separate.

Closing or reloading the browser with unsaved edits requests the browser's normal
leave-page warning. Recovery is checkpointed during editing and when hiding or
leaving the page. Browser storage can be unavailable or full; the editor reports
that condition and still requests the warning. Recovery is local to this browser
and address. Image import form entries are recoverable, but selected image files
must be chosen again after reopening. Map recovery keeps the painted draft and
pending fields; it starts a new local undo history from the saved map.

The editor starts with only the Project explorer visible. Select an existing game
and choose Open project. The folder and load controls collapse after opening a
project, and the navigation tree remains visible. Use Open another project to
show the folder controls again.

Choosing **Play** with unsaved edits asks whether to preview the saved files.
Cancelling keeps the drafts and does not load a game. Continuing leaves drafts
intact and previews only saved content. Automatic refreshes of an already-running
preview continue to use saved files without showing this start confirmation again.

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

In **Rules → Trigger links**, save or discard edited button links before switching
buttons or scenes, and edited inspections before switching item types. Saving
one trigger form preserves drafts in the other forms. **Discard trigger draft**
resets all trigger forms; item-action and nearby forms also offer their own
discard buttons. Conflicts and unrelated saves retain pending trigger edits.

`POST /api/editor/projects` accepts JSON `{ "path": "my-game", "title": "My game",
"description": "" }` and returns the new project view with a revision and HTTP 201.
Invalid input returns 400, an existing destination returns 409, and links remain
inaccessible. Creation reserves a new folder exclusively and publishes `game.json`
after both scene files. MCP clients can list workspace projects and create a
starter project with `ancadeba_list_projects` and `ancadeba_create_project`.
Creation leaves the active project unchanged. Use `ancadeba_switch_project` to
select a discovered or newly created game without reconnecting; each MCP
connection retains its own selection and in-flight requests keep their original scope.

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
Inside editable fields those keys retain normal text-editing behavior. While a
map has local edit history, these controls and shortcuts undo or redo its unsaved
edits. Save or discard all pending drafts before using saved project history. History changes refresh
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

Text supports literal content, translation keys, dynamic bindings, heading/body
styles, and alignment. Buttons support scene navigation, starting a new game, rule actions,
and map movement. New-game targets list only game scenes. A button without an action
is disabled during play. Map views choose existing map definitions from the game
manifest and configure their visible area, interactivity, and optional player
marker with zero-based coordinates. Create map definitions in the **Maps**
workspace before selecting them here. Invalid view dimensions and blocked or
out-of-bounds player spawns are rejected. Language selectors use the manifest's
configured languages and catalogs; they remain disabled in play until those exist.

### Dynamic text placeholders

Select a text component in a game scene, or add one, and choose **Text binding
mode → Dynamic placeholders**. Write `{{gold}}` or another named placeholder in
**Text**. Enter its **New binding name**, choose **New binding value**, and choose
**Add text binding**. Names use letters, digits, underscores or hyphens and must be
unique within this text component. **Bound value** changes an existing binding.
**Append {{name}}** adds a placeholder at the end of literal text.

State values come from fields declared in Rules, including numeric gold/currency
fields. Quest choices include status, current stage ID and tracked state. For an
objective counter, bind the state field used by that objective's numeric progress.
Game time offers turns and elapsed world time; authored character levels and
equipment stats are also selectable.

**Starting-value preview** updates as text and bindings change. It shows authored
state defaults and quest values before actions run; derived and custom values may
be unavailable until play. **Use fallback text** supplies text for unresolved
values in the standalone game. The engine's editor preview marks unresolved values
for diagnosis. **Custom path** supports a source and separate object/Map keys or
numeric array-index segments, without writing JSON.

**Text translation** uses the selected key's default-language template in the
authoring preview. Edit translated templates in Localization; every language uses
this component's binding names. Appending to a translated template is disabled
here because its text may be shared. Saving validates placeholders in the source
text and translated templates. Unbound placeholders, invalid paths and pending
binding names retain the draft for correction.

**Remove binding …** removes a name; update any placeholders that still use it.
**Static text** explicitly turns interpolation off and keeps braces literal.
Bindings require game scenes. Save/discard and project Undo/Redo work as for other
component edits, and conflicts preserve binding rows and pending names. Registered
state changes and quest transitions refresh the text during play.

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

### Maps and terrain

Use the **Edit** or **Split** layout and choose **Maps** in the section rail or
explorer. Choose **New map**, enter a unique map ID, and set its width and height
in tiles. **Apply size** preserves overlapping tiles and fills new cells with the
selected terrain. Reducing either dimension asks before cropping the draft.
Maps can contain up to 65,536 tiles.
Crop, fill, and delete confirmations open inside the editor. Choose **Cancel**
or press Escape to leave the map unchanged; **Confirm** applies the action.

In **Terrain palette**, select the paint terrain or add one using **New terrain
ID** and **Add terrain**. Set its color, walkability, and movement time in
milliseconds. Removing a terrain replaces its painted cells with the selected
replacement terrain; the last terrain cannot be removed.

During play, each completed tile step advances the progression turn counter once,
including steps with zero movement time. The destination terrain's movement time
also advances action-driven world time. Code-hosted elapsed mode uses elapsed host
time instead; hybrid mode adds both. Position, progression, and the Rules clock
update together before movement observers or tile-entry actions run, so logs use
the arrival time. Blocked or cancelled steps consume no movement turn or time cost;
elapsed time can still pass. Spawning, returning, explicit entrance placement, and
loading saved positions add no step charge. An exit's Rules travel-time effect is
an additional authored cost. Map steps leave actor roster turns and phases alone.
Text and status panels can display `game.progression` fields `turn` and
`worldTimeMs`; saved progress preserves both counters with the player's position.

For image tiles, import a PNG, WebP, JPEG, or SVG image in **Assets**, then return
to **Maps**. In **Tilesets**, enter a **New tileset ID** and choose **Add tileset**.
Select its **Tileset image** and set **Tile width (pixels)** and **Tile height
(pixels)**. Margin is the border around the sheet; spacing is the gap between
tiles. For a single image per tile, use the image's full width and height with
zero margin and spacing. Use a transparent PNG, WebP, or SVG for overlays.

Choose a paint terrain, then click an image in the tileset picker to assign it.
The selected tile is outlined; the picker pages through large sheets. Keep **Use
base color** enabled for an image over a color, or switch it off for image-only
terrain. **Terrain tileset → Color only** removes the image and restores a base
color. Paint, save, and undo/redo work the same for all three appearances. A
tileset cannot be removed while a terrain still uses it. Missing images and
out-of-bounds image selections are rejected when saving, including unused maps.

Map files store reusable `tilesets` entries with `image` asset IDs, `tileWidth`,
`tileHeight`, and optional `margin` and `spacing`. Terrain `tile` selections
contain `tileset`, `column`, and `row` (zero-based in saved data). Terrain may
have a `color`, a `tile`, or both. Transparent image pixels reveal the base color;
image cropping and rendering are shared by the editor, preview, and exported game.

Click or drag to paint tiles. Arrow keys move tile focus, and Enter or Space
paints. Large maps show a movable window of up to 24 columns by 16 rows; use the
row/column controls or arrow keys at the window edges to reach other tiles.
Displayed coordinates start at 1. Stripes indicate blocked terrain and a dot
marks a scene's player spawn. **Fill map with selected terrain** asks before
replacing every tile in the draft.

Use **Layers → Paint layer** to switch between **Ground** and independent object
layers. Enter a **New layer ID** and choose **Add overlay layer**, then name it
Trees, Buildings, or another useful group. Paint terrain or image tiles on that
layer; empty cells reveal the ground and objects below. Turn off **Use base
color** on transparent object terrain so the ground image remains visible.
**Paint tool → Erase** removes only the selected layer's objects. Ground cannot
be erased. **Fill selected layer** affects only that layer; **Clear layer** and
**Remove layer** ask for confirmation. Removing an overlay keeps the ground.
The visible map area stays in place when switching layers or paint terrain.

The map canvas has **Zoom in**, **Zoom out**, and **Map zoom** (50–400%) controls.
Zooming out shows more tiles; zooming in enlarges tiles for detail work. Use
**Pan left/right/up/down** to move one tile, or the existing Previous/Next
columns and rows buttons to move one visible page. **Pan map** enables dragging
the view with the left mouse button; turn it off or press Escape to return to
the selected editing tool. Dragging with the middle mouse button temporarily
pans in any tool. Panning stops at the map edges and never paints or changes a
selection. In Pan mode, arrow keys pan the view. With focus on a grid cell,
**+ / −** changes zoom and **0** returns to 100%. **Ctrl/Cmd+wheel** zooms around
the pointer; ordinary wheel scrolling remains available for the page.

**Reset view** restores 100%, the top-left corner, and the editing tool. Zoom and
position survive brush/layer changes, edit undo/redo, and saving in the current
map, and reset on switching maps or reloading the browser. View controls do not
create unsaved changes or edit-history steps and are not stored in map JSON.
The visible grid stays bounded (up to 48 × 32 tiles at 50%) on large maps.

The **Minimap** shows the entire current map with terrain colors, image tiles,
visible overlay layers, and spawn markers. Its amber outline marks the main
grid's visible area and follows zoom and pan. Click a location to center the
view there at the current zoom; clicks near an edge stop at the map boundary.
The overview includes unsaved painting, erasing and tile-group edits, and updates
after undo/redo, resizing and layer visibility changes. Clicking it navigates
without painting, pasting, changing the selection, or creating an undo step.

With the minimap focused, arrow keys pan one tile, Shift+arrows moves one visible
page, and Home/End visits the top-left/bottom-right corner. Enter returns focus
to the main grid without painting. Click the **Minimap** heading to collapse or
expand it. Narrow editor panes let the navigation controls scroll with the page
so the overview does not cover the editing area.

In **Tile tools**, choose **Paint tool → Select tiles** and drag a rectangular
group on the active layer. Shift-click extends from the selection's first cell.
For keyboard selection, focus the grid, press Enter to select a tile, and use
Shift+arrow keys to extend the rectangle, including across the map's paged view.
The selection outline and dimensions identify the exact cells being copied.

Choose **Copy selection** (Ctrl/Cmd+C with grid focus), then click the top-left
destination cell to paste. The preview follows the pointer or arrow-key focus;
Enter pastes at the focused cell. Paste again to reuse a building several times,
or choose **Paste tiles** / Ctrl/Cmd+V to return to paste mode later. Copies can
be placed on another layer in the same map. **Skip empty clipboard cells → Yes**
preserves objects beneath holes in a copied shape; choose No to replace those
overlay cells with empty cells. Ground always skips empty clipboard cells.

**Cut selection** (Ctrl/Cmd+X) prepares a move. Source tiles stay in place until
the full group fits at a valid destination; source clearing and placement happen
together, including when source and destination overlap. For ground selections,
choose **Ground replacement for cut** to fill the cells left behind. Escape or
**Cancel paste** cancels the pending move without removing the source. The
captured group remains available as a copy. Changed or deleted cut sources and
missing terrain definitions are rejected before any tiles are changed.

Selection, clipboard, and preview controls do not save map changes themselves.
Use **Undo map edit** and **Redo map edit** to revise the draft before saving.
Each paint or erase drag is one step; each paste or move is one step, including
both source clearing and placement. Fills, applied resizes, layer changes,
terrain and tileset edits also participate. A continuous edit in a focused input
is grouped until focus leaves it. Selections, copying, canceled moves and
unchanged strokes do not create steps or clear redo. A new edit after undo
clears redo. Undo/redo cancels a pending paste or cut preview while retaining
the copied tiles for reuse.

Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes outside text fields.
The project toolbar uses the same draft history while the map is selected,
including when only redo steps remain. Pending dimension inputs are applied
with **Apply size** before they become a map history step; editable fields keep
their native text undo. Draft history stays in this browser session for the
current map, retains up to 100 steps with a 16 MiB change budget (always keeping
the latest action), and survives failed saves, conflicts, language changes and
unrelated saves. **Save map**, **Discard map draft**, switching maps, or reloading
the browser clears it. After saving, shared project Undo/Redo restores the saved
tile grids. Copies remain available through saves in the current editor
session; switching maps or reloading the browser clears this internal clipboard.
Text fields keep their normal copy/paste shortcuts.

Layers are listed from bottom to top after Ground. **Move layer up** brings it
above other object layers; **Move layer down** sends it behind them. The player
marker appears above the map layers. **Layer visible → No** hides the layer in
both the editor and game and excludes it from movement checks; show it before
painting. **Layer affects movement → No** keeps a visible decoration passable.
Otherwise, blocked terrain in any visible layer blocks movement, and the slowest
terrain under a cell determines its movement time. Walkable objects cannot make
blocked ground passable. Resizing preserves overlapping cells in every layer and
adds empty overlay cells. When resizing from an overlay, new ground cells use the
existing top-left ground tile. Save, reload, Undo, and Redo include all layers.

Saved maps retain their original `tiles` grid as Ground. Optional `layers` store
up to 32 overlays in draw order, each with a unique `id`, optional `name`,
`visible` and `collision` flags, and a matching grid of terrain IDs or `null`
for empty cells. Existing single-layer maps need no conversion.

In **Tile-entry triggers**, choose **Add tile-entry trigger**, set a unique
**Trigger ID**, zero-based **Trigger tile X/Y**, and an **Entry action** saved in
**Rules**. The editor starts each trigger on an unused walkable tile. Each tile
can have one trigger. To create an exit, give its Rules action an **Enter scene**
effect. Normal action conditions support scene-specific exits and one-time events.
The grid shows a **T** badge on every trigger tile; its tooltip includes the
trigger ID, action, and zero-based coordinates. Choose **Edit tile-entry triggers**
above the grid, or **Paint tool → Tile-entry triggers**, then click a tile to
add a trigger or focus its existing fields. The selected tile and trigger form
are highlighted together. Arrow keys navigate and **Enter/Space** opens a tile;
**Escape** returns to painting. Dragging in trigger mode does not paint or create
more triggers. New triggers require a walkable tile and a saved Rules action.
Editing the ID, coordinates, or action updates the grid immediately. Undo/Redo,
removal, and draft recovery also update the badges.
Triggers run after a completed step, including terrain delays, and run again on
later re-entry. Spawning, returning to a scene, and loading a save do not activate
them. Cancelled steps and requests from a scene that has been left do not activate
them either. Trigger edits support draft recovery and map undo/redo. When shrinking
a map, move or remove any triggers that fall outside its new bounds before saving.

To connect an exit to a particular entrance, edit its **Enter scene** effect in
**Rules**, select the **Destination scene** and its map under **Charge time from
map view**, then set **Place player at destination tile → Yes** and enter
**Destination tile X/Y**. Coordinates start at zero and must identify a walkable
tile on an interactive map with a player spawn. The selected view arrives at that
tile even if the player previously visited a different location there; other map
views keep their remembered positions. Arrival does not activate a tile trigger,
so opposing exits do not automatically bounce the player between scenes. Rules
travel time uses the destination tile's terrain. Choose **No** to preserve normal
resume/spawn behavior; existing Rules effects with a map selected still charge
time using its spawn terrain. Scene buttons and action-bar **Enter scene** actions
offer the same entrance coordinates under **Destination map view**.
Navigation buttons and action-bar slots disable while their destination tile is
blocked by the current object state, and explain the unavailable destination in
their tooltip. They update when flags change and recheck collision on activation.

Use **Place or edit map objects** above the grid, or **Paint tool → Map objects**,
to place an object by clicking a tile. Click an **O** badge to edit an existing
object. Keyboard users can navigate with arrows and open a tile with Enter/Space;
Escape returns to painting. New blocking objects cannot be placed directly on a
player spawn through the grid. The **Map objects** section also offers **Add map
object** and **Remove map object**. Set its **Object label**, **Object appearance
terrain**, **Object action**, and zero-based **Object tile X/Y**. Create and save
the Rules action first. Its appearance uses a terrain color or image tile; the
separate **Object blocks movement** setting defaults to Yes. Permanently blocking
objects invalidate spawns, tile-entry triggers, and scene entrances on their tile.

Under each object's **Object states**, use **Add object state** after saving a
boolean state field in Rules. Choose its flag and required value, then override
the appearance terrain, label, blocking setting, or visibility. Each state needs a unique ID
and at least one override. Blank labels and **Use object default** selections
inherit the base object. Move states up/down to set priority: only the first
matching state applies. No match uses the base object. The grid shows the base
appearance for all objects, including hidden ones; use the game preview to exercise
the live states. **Object visible** sets base visibility (Yes by default).
**State visible** can inherit that setting or explicitly show/hide the object.
Hidden objects disappear during play, stop blocking movement, and are excluded
from automatic and explicit interaction targets. Already queued interactions
recheck visibility before running. This allows a collected pickup to disappear
by setting its collected flag and matching a state with **State visible → No**;
no separate blocking override is needed. Visibility-only states are valid.

State changes immediately repaint the object and update movement controls.
Nonblocking objects still respect underlying ground and collision layers. A
spawn must be walkable using the initial Rules flags, while scene entrances use
their current values. Tile-entry triggers may share conditionally passable tiles.
If a destination becomes blocked during a timed step, the step is cancelled on
arrival and its trigger does not run. A player already on a newly blocked tile
can leave it and can save/load there. States participate in map saving,
Undo/Redo, and draft recovery; removing or changing the type of a referenced
Rules flag is rejected until its object states are updated.

Players can click or keyboard-activate an adjacent object's map button. Add an
**Interact with map object** action to a scene button or action-bar slot to expose
a separate control, then choose its map view and **Interaction target**. The
automatic **Only adjacent object** option works when exactly one object is one
tile north, east, south, or west of the player. Choose a specific target or click
the object when several are nearby. Interaction never activates from a diagonal,
the same tile, or during movement. Bind an action-bar Interact slot to a virtual
input to provide an E key or another authored keyboard binding. The action's
payload is the object ID, available in Rules target conditions. State conditions
can make an action one-time. Undo/Redo and draft recovery include object edits.

The `square-map` sample connects Coast Road and Pine Village with gold exit
tiles. From the coast spawn, move west once and north twice to visit the village,
then west once to return. Its [sample guide](../sample-games/square-map/README.md)
lists both exit tiles, destination coordinates, and the map and Rules files to
inspect in the editor.

The sample also places a signpost north of the coast spawn and a chest north of
`(2, 4)` in Pine Village. Press **E** at the coast spawn to read the sign; from the
village entrance, move east once and press E for the chest's one-time 25-coin
reward. Both scenes expose an **Interact** slot and bound feedback text. Inspect
`rules/interactions.json` for the object-target conditions, collected flag, and
empty-chest branch, and `input/movement.json` for the shared E binding. The chest's
**Object states** entry uses `chestOpened` to select an open sprite and allow
walking onto its tile. Closed/open artwork comes from `assets/chests.svg`.
The purple berry basket at `(4, 5)` uses a visibility-only state. Move three tiles
east from the village entrance to `(4, 4)` and press **E** to collect three berries.
The basket disappears, and its tile becomes passable. `berriesCollected` and
the three berry inventory items persist across scene visits and saves; a new game
restores the pickup and returns the items to their starting container.

To author an inventory pickup, define its item instances and destination owner in
Inventory first. Keep uncollected items with a world owner or inside a world
container. In the object's Rules action, add an effect and choose **Collect
inventory items**. Select **Destination owner** (usually `player`) and add one or
more **Pickup item** entries. Select each instance once. Add **Set state** for the
collected flag in the same branch, and hide the object when that flag is true.

Collection moves the finite instances into the recipient's carried inventory.
Every item must be available and not already owned by the recipient. If one item
is missing, reserved, or cannot transfer, nothing transfers and the state/log
effects do not run; the pickup remains available to retry. Inventory observers
see both the complete reward and updated flags. Each branch permits one inventory
operation or scene transition, plus state/log effects. Quest transactions cannot
be mixed with collection effects in the same branch.

The berry sample uses `inventory/supplies.json`: `berry-1`, `berry-2`, and `berry-3`
start inside `berry-basket`, owned by the village. `collect-berries` transfers them
to `player` and sets `berriesCollected`. Both sample scenes show the player's
**Backpack** so the three **Wild berry** entries are visible after collection.

Choose **Create map** or **Save map** to persist the draft. Pending dimensions are
applied during saving too. Save or discard a draft before switching maps or
leaving this workspace. Conflicts and validation errors preserve the draft.
Saved changes support the shared **Undo** and **Redo** controls. The editor
rejects changes that invalidate a scene's map viewport or player spawn.
**Delete map** removes an unused map; maps still referenced by scenes must first
be removed from those scenes. To display a map, add a map-view component to a scene
and select the saved map in its settings.

The revision-checked commands are `game.upsertMap` (`mapId`, `map`, optional
`createOnly`) and `game.removeMap` (`mapId`). Creation reserves a new
`maps/<id>.json` file and updates the manifest through the guarded multi-file
persistence path. Deletion and history use that same path. Existing source
extensions are retained when updating a map or its terrain definitions.

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

New status panels require an unused component ID. Creation rejects collisions
without replacing existing panels, including after a conflict or draft rerender.
Saved panel IDs remain fixed while their contents are edited. Creation requests
use `scene.upsertStatusPanel` with `createOnly: true`.

Missing or invalid bindings produce an unavailable display, with diagnostics in
editor preview. Resource bars require actual finite numeric values and a positive
maximum; they never substitute a string fallback as a resource amount. Rule edits
cannot remove or change the types of declared fields used by a saved status panel
until those bindings are updated. Status panels display values; game rules own
resource changes and effect timing.

### Combat encounter and library workflows

Before choosing **Add encounter**, declare two numeric starting-health fields in
**Rules** with positive values, such as `health = 40` and `enemyHealth = 20`.
Under **New encounter health**, select different fields for the player and enemy.
The editor uses those declared paths, preserves their starting values, and raises
the default maximum health when needed to accommodate them. Missing health fields
are explained before a draft is created, so you can go to Rules and add them.

New encounters and combat libraries require an unused ID. Creation checks IDs
without regard to letter case and cannot overwrite an existing definition.
Saved definition IDs are read-only; editing their other fields updates the
selected definition. Failed saves retain the draft for correction and retry.

For encounter-specific mechanics, expand **Resources, triggers and phases** in
the Combat form. Add meters with initial/maximum values and optional actor
ownership, then configure event triggers with filters, ANDed conditions, ordered
effects and optional once-per-encounter execution. Add named phases, choose the
initial phase, and configure phase entry effects or alternate enemy rotations.
Choose trigger-defined victory for objectives that do not require defeating all
enemies. Moves can reserve resource costs, and abilities can change a named meter.
All controls use the normal draft, validation and revision-checked save workflow.
Removing referenced definitions requires updating their references in the draft.

The `sample-games/combat-mechanics` game demonstrates an underwater fight with
stamina/exhaustion and a boss gauge filled three times. The runtime preserves
meters, phases and trigger history across pauses and saves. Initial phase entry
and encounter-start triggers run on the first committed round; previewing or
queuing does not activate them. Rotation-only enemies use changed phase rotations
in the next round. Conditional enemies choose using the current phase before each action.

Each enemy has a **Conditional enemy AI** section. Enable it, add ordered rules
and choose an available move and maximum uses per turn. Add ANDed conditions for
resource amounts, actor health, status stacks/intensity or boss phase. Raise a
rule's priority to check it earlier. Empty conditions always match; an absent
status has zero strength. Choose rotation fallback or wait when no rule can act.
Unavailable moves are skipped to allow lower rules to run. Resources and phases
come from the fight's effective inline/shared mechanics. Removing inline
conditional AI returns to the normal rotation.
Rules choose again before each action, so earlier actions can change the next
decision. Displayed enemy plans are previews of current conditions.

Combat libraries provide **Reusable enemy AI profiles**. Create a profile and
author its AI rules with the same controls. `self` means the enemy using the
profile. Declare other actor roles and apply them to the controls, then bind
those roles in each encounter. Profile moves and status conditions refer to
definitions in the same library. Resource and phase IDs can be entered directly
and are validated against the encounter when the profile is linked.

Choose **Shared AI profile** under an enemy's **Enemy AI profile** section.
The form shows its effective rules and whether each is inherited, overridden or
excluded. Editing saves only changed fields for that enemy. Conditions are
replaced as an array; untouched fields follow later library updates. Add/remove
rules, change priority or fallback, and reset a rule, setting or all overrides to
inherit again. Every chosen move must be in the enemy's available moves.
Choose **Inline enemy AI** to detach a copy while retaining required shared
move/status imports. Profiles, references and patches use normal draft recovery,
validation, revision checks, undo/redo and export. Reef and Deep water share the
Eel hunter profile; Deep water lowers its exhaustion threshold locally.

The condition editor is shared by enemy AI, AI profiles, triggers, phase-entry
and ability effects. Existing condition lists mean AND. Choose `and` (all), `or`
(any), or `not` (one inverted child) to nest expressions. Add/remove child
conditions inside each group; groups require at least one child. Trees allow
eight levels, 100 nodes, and 20 children per group. Conditions inspect health,
resources, phases, or status stacks, intensity, and remaining turns.

For health/resource thresholds choose **Percentage of maximum** and enter a
number from 0 to 100, with up to two decimal places. Runtime health uses the
effective maximum, including equipment; resources use their authored maximum.
Missing actors/resources/phases or an unavailable maximum remain unresolved,
including under NOT. An OR can still match another resolved branch. `self` and
`target` refer to the acting combatant and selected target in action/ability
conditions. For status events both aliases identify the affected combatant;
resource events have `self` only when that resource has an owner. Other events
may have no actor/target, so use an explicit actor ID/role when appropriate.

Use **Add effect condition** to gate individual ability, trigger or phase-entry
effects. Conditions are evaluated immediately before each effect, so later
effects see changes made by earlier effects. Removing all effect conditions
makes the effect unconditional. Shared definitions preserve nested expressions,
actor-role bindings, and per-encounter overrides. Combat-only conditions are not
supported for outside-combat healing items.

Lifecycle events include **Before action**, **After action**, **Status applied**,
**Status refreshed**, **Status removed**, **Status expired**, and **Status changed**.
Before-action runs for each attempted selected/queued action before paying costs;
AP, resource availability, target health and stun are checked again afterward.
A blocked action spends no action costs or RNG and does not emit after-action.
Successful actions emit the existing action-resolved event before after-action.
A terminal outcome stops further hooks. Status events run after mutation: an
actual application/refresh/removal/expiry emits its specific event followed by
status-changed; partial stack removal and duration ticks emit only status-changed.
No-op applications/removals emit nothing. A status filter selects a single status.
Hooks use the existing ordered queue, once-only flags, cascade limit and atomic
combat transaction. Debug event entries record trigger matches and failures with
nested observed values; enemy decision entries display the same expression tree.

Move forms now include **AP cost scaling**, **Resource cost scaling**, and
**Effect value scaling** for attacks/guards and damage/heal/guard ability effects.
Enable scaling, choose additive or percentage mode, and add up to 20 weighted
resource/status terms. Coefficients support two decimal places, including negative
values. Resources can use their current amount or percentage of maximum; status
terms use stacks/intensity/remaining turns. Scaling actor accepts `self`, `target`,
or an encounter actor ID. Resource IDs can be typed in shared libraries and are
validated after encounter composition resolves. Scaling-only status references
are imported automatically.

Effects round down by default and AP/resource costs round up. Optional bounds
clamp the result before rounding; the action's AP cost still has a minimum of
one. Dynamic resource scaling requires an existing resource cost entry; renaming
or removing that entry also moves/removes its formula. Disable scaling to return
to the fixed base value. Resource costs are paid before ability formulas read
live values, and before-action hooks can change the final affordability check.
Previews and planning use current values and do not assume future gains/effects.

Modifier/composite status forms expose **Percentage modifiers** for attack bonus,
defense, Guard bonus, AP budget, action AP cost, whole damage, and healing. Values
combine additively across statuses, scaling with stacks × intensity, and apply
after flat modifiers. Damage percentages apply before defense/Guard; healing
percentages apply to the source's heals/regeneration. Combat status badges show
the scaled percentages. Maximum-health percentage modifiers are not included.

Water and **underwater-boss** expose Flow strike (S), Reviving breath (F), and
Focus current (G). Replay **scaled-current**, **scaled-last-seal**, and
**pressure-surge-scaling** to inspect resource/intensity-dependent effects and
costs. The original exhaustion and three-seal scenarios remain available.

Set **Damage type** on attacks, damage ability effects and periodic damage statuses.
Leave it empty for physical damage, or use the same custom ID everywhere that type
is referenced. Actor and status forms include **Damage defenses**: enter a type ID,
choose **Add damage defense type**, then set its resistance/vulnerability percentages or
enable **Immune**. Remove a type or all defenses to clear those fields from JSON.
Shared-library statuses expose the same controls and can provide temporary wards.
Defense-only composite statuses are supported; their percentages scale with
stacks × intensity, while immunities remain active until the status is removed.

Resistance and vulnerability add across the actor and live statuses; their net
percentage applies after flat defense and before Guard, with damage rounded down.
Immunity overrides percentages and preserves Guard. Periodic damage retains its
flat-defense/Guard bypass. Damage immunity allows independent status application;
zero-damage hits/ticks do not emit damage-received hooks. Effective defenses and
typed damage ranges appear in the live view and editor preview. Simulation action
log entries retain mitigation details, including damage type and immunity.

Water's **typed-damage** scenario compares water resistance, lightning vulnerability
and poison immunity. Underwater guardian adds **typed-damage** and **seal-shell**;
the latter enters phase two and applies Tidal shell at intensity two, cancelling
the guardian's lightning vulnerability. Z/X/C select the three typed abilities.
Its diver also resists Pressure surge's water damage by 50%.

Set **Move categories (comma-separated)** on any local or shared move. Categories
are explicit IDs: use `spell` for Silence-sensitive actions, `weapon` for
Disarm-sensitive actions, and `utility` for recovery that should remain usable.
A move in multiple categories is blocked when any category matches. Untagged
moves retain their previous behavior.

Actor and status forms expose **Status immunity and action restrictions**.
Enter exact, declared status IDs in **Status immunity IDs (comma-separated)**
and categories in **Blocked move categories (comma-separated)**. A Silence
composite status can contain only `spell` in the blocked list; a temporary ward
can contain only immunity IDs. Actor and active-status contributions combine
until their sources expire or are removed. Empty controls clear saved fields.
Shared status dependencies import automatically, and deletion/reference checks
protect statuses mentioned only by immunity lists.

Immunity prevents new applications, refreshes and added stacks/intensity. It
does not cleanse existing statuses. Damage immunity remains separate from status
immunity. Use explicit remove-status effects for recovery. The runtime rechecks
restrictions after before-action hooks; rejected actions spend no costs or RNG.
Live and editor previews show blocked reasons and immunity, and simulator enemy
decisions identify blocked categories and the status causing them. Saves retain
the active controls and rejection logs.

Click **Open control techniques** in Water or Underwater guardian for companion
views of the same encounter. Brine bind applies Silence/Disarm; Clear mind
prevents future controls, while Shake off removes existing ones. Stunning bell
tests Dazed immunity. Replay Water's **brine-control**, **silence-recovery** and
**status-ward**, plus the boss's **boss-silence** and **boss-control-immunity**.
The guardian permanently rejects Disarmed/Dazed, and Tidal shell temporarily
rejects Silence. Original keyboard controls remain on the standard views.

Choose a damage/healing event on a trigger to expose **Effect source filter**,
**Effect recipient filter**, **Effect delivery filter**, and, for damage,
**Damage type filter**. Received/dealt events require positive actual HP change;
resolved events include zero damage and overheal. Move and status filters can
select a direct action or periodic status. Event conditions add numeric comparisons
and boolean flags within the existing AND/OR/NOT builder. Only fields available
on the selected event are offered; source/recipient actors can also be used in
health/status conditions.

For a resource effect, enable **Scale amount from event**, set the base Amount to
0 and select **Actual HP changed** with factor 1 to copy actual damage/healing.
Negative factors can remove exhaustion or another resource. The formula adds
the selected event value times its factor to the base amount and rounds once.
Trigger effect types **damage** and **heal** also accept these formulas. Choose
**Effect recipient** and **Reactive effect source** using actor IDs or Event
source/recipient; an empty source defaults to the recipient. Reactive damage
uses normal defenses and Guard without an extra RNG draw; healing uses normal
healing bonuses and health limits. Neither spends another action's costs.

Reactions ignore other reactive damage/healing by default. Explicitly enable
**Include effects caused by reactions** for a healing-to-exhaustion chain, and
use filters/conditions to bound its scope. Invalid event-only fields in phase
entry effects or unrelated events fail save validation. Trigger loops still
reject the entire combat transaction. These controls also work in shared
rulesets and sparse encounter overrides.

Water's **current-siphon** replays Focus current followed by Arc bolt: 27 lightning
damage produces 18 actual healing after its bonuses, relieving 18 exhaustion.
Underwater guardian's **lightning-three-seals** recovers and casts two Arc bolts
per round, filling three seals from actual damage in ten rounds without Channel.
Its Tidal shell reflects 25% of lightning damage received. Inspect simulator
event frames' `effect` facts for raw/actual amounts, mitigation, overheal,
attribution and delivery. Live and saved logs label reactive damage/healing.

The Combat editor's **Combat simulation and debugging** panel runs the current
encounter draft using saved shared libraries and starting game fields/equipment.
Set starting health, resources, status strength/duration, boss phase and seed,
then choose **Start/reset simulation**. Queue player moves with a target and
resolve a round, or repeat the plan for 1–100 rounds. Repeat retains targets and
omits unavailable moves. Simulation controls never mark the authoring draft as
edited or send save commands. They test combat moves independently of live state;
item use is simulated against an isolated inventory copy. Rewards and world
progression remain outside this sandbox.

Filter the timeline and inspect a decision, action or event/trigger step. Enemy
decision explanations show observed condition values, rule priority, AP cost,
cooldown, resource shortage and per-turn use limits. Lower-priority rules are
not evaluated after a selection. State frames show health, guard, resources,
phase, status stacks/intensity/duration, cooldowns and RNG. The current enemy plan
preview is provisional; actual conditional choices use live round state.
**Simulation report (JSON)** is a copyable reproducible snapshot with round
inputs. Trace collection stops after 500 frames while inputs/final state remain
available. Changed encounter or saved shared data requires restarting the test.
See the sample game's README for water-exhaustion and three-seal boss exercises.

**Saved combat scenarios** stores named tests in each encounter's
`simulationScenarios` source field. Select an existing test or capture the current
simulation's starting setup and recorded/queued actions. Edit its name, ordered
steps, move/target plans, repetitions, unavailable-action policy, checkpoint
checks and final checks. To change starting conditions, edit the simulator fields
and choose **Use simulator starting conditions**. **Load scenario starting
conditions** loads them into a fresh manual simulation.

**Replay scenario** tests the selected draft against current encounter changes.
**Run all saved scenarios** tests the saved scenarios for that encounter. Results
show pass, failed checks with actual values, or an execution error with its step.
Inspect a result to use the existing timeline and enemy decision debugger. Tests
default to failing on unavailable actions; explicit skip mode lists skipped
commands. Checkpoints run after a step's repetitions, and a later step cannot
execute after a terminal outcome. Final checks always run on a completed script.

**Save simulation scenario** writes only that scenario, preserving unrelated
encounter edits. Save a new encounter before saving scenarios. Capture expected
results explicitly; replay does not replace them. Duplicate/delete, conflict
retries and draft recovery use normal editor behavior. Save/discard scenario
drafts before switching encounters. Scenario references that no longer resolve
are reported during replay, allowing gameplay changes without blocking the game.
Changes to test data do not affect gameplay save compatibility.

For layered encounter mechanics, choose **Compose rulesets**. Select **Ruleset
to add** and choose **Add ruleset layer**. Add, reorder, replace or remove layers,
with independent actor-role bindings in each. Existing single references convert
without copying shared mechanics into the encounter. Library and ruleset usage
lists include every selected layer.

Duplicate resource/trigger/phase IDs show both providers and prevent saving.
Choose **When mechanic IDs collide → Replace with this layer** on the later
layer to replace a whole entry. Arrays are replaced rather than concatenated;
replaced triggers run at the later layer's position. Different initial phases
also require explicit replacement. Any layer with objective victory preserves
trigger-based victory in the composition; encounter settings can override it.

The effective mechanics form shows the supplying library/ruleset and edits only
encounter overrides. Reset an entry/setting to inherit the composed result again.
**Detach composition to inline mechanics** retains the effective mechanics and
shared move/status references. Removing the last layer also detaches. Saved
composition supports 16 distinct library/ruleset pairs, with overrides applied
last. Replays use the current composition, bindings, library data and overrides.

Select **underwater-boss** in the mechanics sample to inspect **underwater** plus
**three-seals**. The fight overrides stamina and water pressure, then adds channel
exhaustion through an after-action trigger. Replay **three-seals-underwater** and
**recover-before-seal** to verify both systems together. The harbour includes a
playable link with Q for channeling and E for recovery.

Combat libraries also provide **Reusable combat rulesets**. Add a ruleset, name
its actor roles and edit its resources, triggers and phases with the same controls.
Use **Apply actor roles to controls** after editing the role list. Roles used for
phase rotations must bind to enemy actors in an encounter. Shared rulesets can
reference moves and statuses from their own library.

In the encounter form, choose **Combat ruleset** and bind its roles to actual
actors. The displayed mechanics combine the shared ruleset with local overrides.
Editing an inherited value saves only that change for the selected fight; untouched
fields continue to follow library updates. The entry list identifies inherited,
overridden and excluded definitions. Reset individual entries, settings, or all
overrides to inherit again. Excluding an entry still requires fixing references to
it. Choosing inline mechanics detaches a copy with explicit shared dependencies.
Selecting a different ruleset resets previous local mechanics to the new defaults.

The sample's Reef and Deep water fights share `environments/underwater`, bind the
swimmer role to different actor IDs, and demonstrate inherited versus overridden
stamina and water pressure. Sources preserve their ruleset references and sparse
overrides through normal saves, draft recovery, undo/redo and export.

Status editors support stacking limits, refresh/preserve duration and intensity
with replace/maximum/add reapplication. Modifier controls include AP budget and
action AP cost. Choose a composite status to combine periodic damage,
regeneration, modifiers and stun. Ability, trigger and phase-entry status effects
can set added stacks/intensity or remove a specified number of stacks.

Numeric effects multiply by stacks × intensity. The runtime recomputes AP and
costs for planning and during resolution; a newly unaffordable queued action is
skipped without item/resource consumption or a cooldown. The combat view displays
effective budgets/costs, scaled status values and strength. Water/Reef demonstrate
exhaustion reducing AP, Deep water demonstrates higher costs, and A stacks the
Swimming rhythm defense buff without extending its remaining duration.

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

After typing a **New context ID**, choose **Add context** and configure its mappings,
or clear the name before saving. A pending name blocks saving and stays available
through validation errors, conflicts, and unrelated saves. **Discard input draft**
clears pending entries along with the other input edits.

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

To add another system such as actors or scripts, supply a
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

Preview and export read saved files. Export warns when any editor has unsaved
drafts: cancel to save them first, or confirm to export the last saved version.
Cancelling keeps the current drafts and any previous download available.
Accepting a changed revision through a save,
undo/redo, reload, or clean background refresh restarts a running or loading preview
with a fresh playthrough. This applies to every authored resource, including story,
leveling, and combat libraries. Unchanged reads and external changes held back by
unsaved drafts leave the preview running. Neither preview loading nor export is
pinned to an editor revision across its individual file reads.

The preview provides five named save slots, with **Save progress** and **Load
progress** operating on the selected **Save slot**. **Export save** downloads that
slot as JSON; **Import save** validates a file into the selected slot without
loading it. Occupied slots require confirmation before import. Slots use durable browser
storage scoped to the project folder and game ID. They preserve progress across preview
restarts and page reloads. Autosave writes a separate checkpoint after gameplay
changes and periodically while a playthrough is open, without replacing manual
slots. **Load autosave** resumes it. Preview restarts cancel pending autosaves;
the last completed checkpoint remains available. Gameplay-definition or stylesheet changes make older
saves incompatible; loading reports this before replacing the current playthrough.
Translation catalogs, key assignments and displayed text can change while keeping
saves compatible. Available/default language changes also preserve saves; a saved
language that was removed falls back to the current/default language. Older
full-content fingerprints are incompatible and have no upgrade path. See the README
for the compatibility boundary.
The component editor also offers **Save progress** and **Load saved progress** as
ordinary button actions (`save-game` and `load-game`), without a scene target.
The Basic Game's main-menu Load Game button is enabled when a slot exists.
See [Save and load](../README.md#save-and-load) for saved systems, storage behavior,
compatibility checks, and limitations.

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
MCP clients can undo/redo saved changes and upload base64 image bytes through
the same server endpoints. Capability discovery includes `features.history` and
`features.assetImport` according to the repository's available services.
MCP clients can export the active project's saved files with `ancadeba_export_game`,
which returns a standalone ZIP as an embedded binary resource. Discovery reports
`features.gameExport` based on the server's export service. See the
[MCP export guide](editor-mcp.md#export-the-active-game) for limits and downloads.

## Stylesheet authoring

Choose **Stylesheet** in the explorer or **Styles** on the section rail. Select a
saved CSS file to edit it, or choose **New stylesheet** and enter a game-relative
path such as `styles/custom.css`. Existing filenames are read-only. New paths use
letters, digits, underscores and hyphens, `/` folder separators, and a `.css`
extension. Creating a file never overwrites an existing one.

Edit **CSS source**, then choose **Check scoped CSS** to test compatibility with
the browser's game stylesheet loader. **Save and assign stylesheet** creates the
file and assigns it to the game; **Save stylesheet** edits the currently assigned
file. **Assign saved stylesheet** switches to an existing saved file without
rewriting its contents. **Use built-in styling** removes the custom assignment
and retains CSS files for reuse. File and assignment changes share project
Undo/Redo. CSS text is saved directly, without JSON quoting or extra newlines.

CSS is scoped to the game viewport. Use `.ancadeba-scene`, `.ancadeba-button`,
`:scope` and `--ge-` theme variables. Supported grouping rules include media,
supports, container and scope queries. Keep CSS self-contained: imports are
ignored and global rules such as `@font-face`, `@keyframes` and `@layer` are not
supported. The compatibility check uses the same browser parser as the game;
browsers may ignore malformed declarations. Restart **Play** to load saved CSS.
Preview and export use the game's assigned stylesheet through the normal loader.

Saved CSS files are discovered within the project, excluding nested games and
dependency/build folders (`node_modules`, `dist`, `coverage`). The currently
assigned file is always loaded. Revisions cover discovered CSS contents, so
external changes produce conflicts. Invalid paths, duplicate filenames, browser
compatibility errors, save failures and conflicts retain the draft. Save or discard
the current draft before switching files or assignments; **Discard stylesheet
draft** restores saved content. A missing assigned stylesheet can be recreated
or detached here without repairing source files manually.

`game.upsertStylesheet` accepts `file`, raw `css`, optional `createOnly` and
optional `assign` (defaults to true). Set `assign: false` to save a file without
changing the active stylesheet. `game.assignStylesheet` accepts an existing CSS
`file`, or `null` for built-in styling. New CSS is published before its manifest
reference, with guarded rollback. Inspection exposes saved text in `stylesheets`.

## Localization authoring

In **Project properties**, or a scene's properties, use **Title translation key**
and **Description translation key** to assign saved catalog keys. Both searchable
fields show the selected key's default-language text. Add languages, keys and
translations in **Localization** first, then save them to make them selectable.
Project headers and scene labels show the assigned default-language title.

Leave a key empty to use the corresponding literal title or description. Literal
fields retain their source values while a key is assigned; translated text takes
precedence. A literal title may be blank when its title key is valid. Descriptions
may translate to empty text, but titles must be nonempty in every provided
translation. Missing language entries use the default-language catalog.

Unknown keys and empty title translations block saving and retain the entries.
Metadata key drafts survive conflicts, unrelated saves, catalog refreshes and
editor-language changes. **Save game properties** or **Save scene properties**
saves the assignments using the shared revision check and project Undo/Redo.

Choose **Localization** in the explorer or **Languages** on the section rail.
Enter a **New language tag** such as `en`, `nl`, or `en-US`, then choose **Add
language**. The first language becomes the default. Language tags must be unique,
including case. The editor authors game content; **Editor language** controls the
editor interface separately.

Enter a **New translation key**, for example `story.welcome`, and choose **Add
translation key**. Select a **Translation key** to edit its multiline **Translation
text (…)** for each language. In other languages, **Text source (…)** chooses
between using default-language text and an explicit translation. An empty explicit
translation stays empty; choosing default text removes the override. Define
`language.name` to give in-game language selectors native names.

**Save localization** saves the language configuration and all catalogs together.
Saved keys and default text become available in the other editors' translation
pickers. Assign a key to a text, label, or other translation field there. Preview
and export use the saved catalogs; switch the preview's game language or add a
language-select component to try translations during play.

**Default language** changes the fallback catalog. Missing keys are copied from
the previous default into the new default, while its existing translations remain.
**Remove language …** removes that catalog; the last language cannot be removed.
Removing the default picks the next available language and carries its fallback
entries forward. **Remove translation key** removes it from every catalog.
Referenced keys cannot be removed, and required translated labels cannot be empty.
Validation also checks translated text bindings. Fix invalid drafts and retry, or
choose **Discard localization draft** to restore saved content. Add or clear any
pending language/key inputs before saving.

Unsaved localization edits survive section changes, unrelated saves, and revision
conflicts. Project Undo/Redo restores saved catalog and language changes together.
The revision-checked `game.updateLocalization` command accepts `languages`
(`default`, `available`) and `catalogs` (one complete source catalog per available
tag). Newly referenced files are protected against overwriting unlisted catalogs;
multi-file save failures use guarded rollback.

## Character levels

In **Character levels**, choose a game scene and a leveling profile, or choose
**Add leveling profile**. A custom **Profile ID** remains selected after saving.
Profiles use declared numeric state fields for XP and level.

Level displays reference shared profiles but keep their own placement and text
target. Select a specific display in the scene explorer to edit it. When a scene
has multiple displays for the same profile, **Level display** selects the one to
edit or remove. Save or discard its draft before switching displays. Profile
changes apply to every display using that profile.

## Inventory authoring

Choose **Items & equipment → Inventory definitions** to create or edit an inventory
without editing JSON. Choose an **Inventory file**, or **New inventory** and an
unused **Inventory ID**. The first save creates `inventory/<id>.json` and adds its
reference to the game. IDs for item types, owners and starting items must be
unique across all referenced inventory files.

Choose **Inventory entry kind → Owners**, enter a **New entry ID**, and choose
**Add owner**. Set **Owner name** and add named equipment slots with **New slot
ID**, **New slot name**, and **Add equipment slot**. Optional owner combat stats
use the numeric health fields declared in Rules.

Owners and their equipment slots expose **Name translation** fields. Saved inventory
definitions use `labelKey` for the owner and `equipmentSlotKeys` for slot names;
keys resolve through the same catalogs as item names. The built-in inventory controls
and feedback use English/Dutch defaults and optional `runtime.*` catalog overrides
described in the README's **Built-in runtime text** section.

Choose **Item types**, enter an ID, and choose **Add item type**. Set its name,
description, properties, artwork, icon and optional equipped graphic part.
**Can contain items** makes this type a container. **Fits slot …** selects its
compatible equipment slots. Existing equipment bonuses, shared item-use abilities,
and translation fields are available in the same form; item actions and inspection
links remain under Rules.

Choose **Starting items**, enter a unique instance ID, and choose **Add starting
item**. Select its type and a **Starting placement**: carried by an owner,
equipped in a compatible slot, or inside another container. Optional color
overrides use the selected type's icon and equipped-part color names. Every
starting item is an individual instance; create additional IDs for more copies.

**Save inventory** saves all entries in the current file together, so related
changes can be made before validation. Unknown references, containment cycles,
duplicate IDs, occupied or incompatible slots, invalid colors, and deletions
that leave references behind are rejected. The draft remains editable after an
error or conflict. Entry changes stay in the draft when switching kinds or
entries. Add or clear pending entry/slot inputs before saving. Save or discard
before switching files or editor modes. **Remove item type/owner/starting item**
changes the draft; **Discard inventory draft** restores the saved file. Existing
extension fields are retained at stable entry and property IDs. Saved inventory
changes support shared project Undo/Redo.

Starting definitions initialize new games. Editing them does not change a running
playthrough, and existing save slots can become incompatible after definition
changes. Restart the preview to play with the new definitions.

Under **Item views and advanced settings**, select a game scene and choose
**Add inventory** to place a panel showing saved owners. Configure its label,
placement, shown owners, read-only setting and main-text details target, then
choose **Save items and equipment**. Add inventory panels before equipment or
item-details views; missing prerequisites report an actionable message.

The revision-checked `game.upsertInventory` command accepts `inventoryId`, a full
`inventory` definition and optional `createOnly`. New files are published before
the manifest reference, existing unlisted files are protected, and whole-project
validation checks references across files, rules, quests, shops and scenes.

## Item details and equipment

Choose **Items & equipment → Item views and advanced settings** to edit an existing item type's name, description, large
artwork, and ordered display properties. Each string can use a language-catalog
key. Properties accept literal text, finite numbers, or existing scalar state
bindings; they do not calculate stats or change game state. Artwork accepts an
image, part, or composition from the game asset catalog. The instance's dyes
apply to image and part artwork.

Set an item view's ID before its first save. Saved IDs are read-only, and new
views reject existing component IDs. Creation requests use
`scene.upsertItemView` with `createOnly: true`. Hiding an inventory owner also
removes that owner's preview mapping when saved. Showing the owner again before
saving restores its draft mapping; discarding restores the saved configuration.

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
or referenced slots. Configure item compatibility with **Fits slot …** under
**Inventory definitions**.

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

### Equipment-granted combat mechanics

In **Inventory definitions**, select an item type, or select it under **Item views
and advanced settings**. Enable **Equipment combat mechanics**. Its equipped
mechanics form edits typed damage defenses, status immunity IDs, blocked move
categories, flat/percentage resource gain modifiers and shared move grants. Save
with the containing inventory or item form. Disable the switch to remove all
advanced mechanics; slot compatibility and flat equipment bonuses are separate.

For a rebreather, add the `exhaustion` resource modifier with **Gain modifier (%)**
`-50`, then grant the shared `environments/purge-valve` move. Set the actor's
**Equipment owner** in Combat and give that owner's profile the same health
binding. Only worn items contribute. Modifiers affect positive gains to resources
owned by that actor, before threshold triggers; recovery and costs keep their
normal values. Multiple items sum flats first, then percentages, rounding down.
Damage defenses combine with actor/status defenses; grants keep normal costs,
restrictions and cooldowns.

Enable **Show combat stats** on equipment/item-details views to compare proposed
mechanics before equipping. The combat view displays equipped mechanics and
merged damage defenses. The engine and editor preview share these rules. Loadout
locks apply until victory, defeat or escape, including when a fight is paused.

In **Combat simulation**, **Starting equipment: actor / slot** offers the starting
inventory, an empty slot, or a compatible item. Start/reset to apply the loadout;
the move picker then includes equipped grants. Capture the simulation as a saved
scenario, or use its current starting conditions to update an existing scenario.
The saved `setup.loadout` stores item IDs and re-evaluates current gear definitions
on replay. **Load scenario starting conditions** restores those selectors.
The combat-mechanics sample includes a gear room and `diving-gear` /
`rebreather-purge` scenarios in Water and Underwater boss.

## Shops and trading

Choose **Shops & trading**, select a game scene, and add a shop. Choose the player
and merchant inventory owners and their panel IDs, labels, and placements. Saving
also saves these two panels as read-only, single-owner inventories. They retain
item selection and custom item actions, but do not expose free Move controls.
Each scene supports one shop, with distinct participant owners.
Set **Shop ID** before the first save. Saved shop IDs are read-only so later
edits keep action-bar references intact.

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
Successful dialogue, quest, and quest-journal saves clear only the submitted
draft, so another pending story or journal edit stays available. After saving,
you can switch definitions or journal scenes without discarding the saved work.

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

## Action requirements on combat moves

In **Combat**, open a move's **Action requirements** group and choose **Add action
requirement**. The condition editor supports AND/OR/NOT, resource and health
percentages, status stacks/intensity/remaining turns and boss phases. `self`
means the move's user and `target` means its selected recipient. Several top-level
requirements must all match. Use **Clear action requirements** to remove them.
The same form is available for reusable moves in **Shared combat libraries**.
Requirements travel with copied, imported and equipment-granted moves.

Requirements gate the entire action. Conditional effects continue to gate only
their individual effects. Resource requirements do not themselves pay a cost;
use the separate resource-cost controls for payment. Planning accounts for
reserved costs and does not assume a queued buff or gain will succeed. Resolve
that setup action first, then queue the newly available move.

Game action buttons explain unmet requirements in tooltips/accessibility text,
including current values. The simulator shows the reason and disables Queue.
At resolution, changed statuses, resources or phases can block an already queued
move; its AP, costs, cooldown and item remain unspent. Failed actions and their
condition evaluations appear in the action trace. Enemy decision traces also
show move requirements separately from AI rule conditions. Saved scenario
fail/skip policies cover both planning and execution failures.

Try the combat-mechanics sample's harbour **Action requirements: Water** and
**Action requirements: Underwater guardian** buttons. **A** builds Swimming rhythm,
**S** queues Rhythm dive, and **B** resolves. Start with three rhythm stacks to
retain two after the eel's disruption. The dive needs at least 20% stamina and
no Exhausted status, then spends a stack. In the boss practice view, **Z** queues
Seal release, gated by the third seal and either Current focus intensity 2 (**G**)
or two rhythm stacks. Replay `rhythm-requirements`, `seal-release-ready` and
`seal-release-locked` to inspect successful and unavailable actions.

## Reusable combat passives

In **Shared combat libraries**, open **Shared combat passives**, enter a **New
passive ID** and choose **Add shared passive**. Edit its name, description,
translations and trigger definitions with the existing structured event,
condition and effect controls. `self` is the bearer. Passive trigger forms accept
typed resource/phase/actor references because their encounter context is resolved
when granted. Resource and phase declarations belong to the encounter/rulesets.
Save with **Save combat library**.

In item settings, enable **Equipment combat mechanics**, then use **Granted combat
passives → Shared passive to grant → Grant shared passive**. Status settings have
the same grant picker. Remove a reference or choose **Clear passive grants** to
stop granting it. Composite statuses can have only passive effects, but still
need at least one effect when saved. Save through the containing item, inventory
or encounter/library form. Referenced definitions cannot be deleted until their
grants are updated.

Only equipped items and active statuses grant triggers. Each granting source
reacts independently, while stacks/intensity do not multiply the number of
executions. **Run once per encounter** remembers that individual item/status and
trigger through save/load; reapplying the same status does not reset it. Removing
or expiring a status prevents its future reactions. A matched trigger completes
its own effect list. New grants do not react retroactively to earlier events.

Equipment comparisons and status descriptions show passive names. Combat logs
identify the passive and granting item/status. In **Combat simulation and
debugging**, filter to event/trigger frames and inspect `passive` for source kind,
actor, source ID, library and passive ID, alongside the tested conditions and
actual damage/healing event. Saved loadouts and starting statuses exercise these
same rules; replay after editing the shared definition to detect regressions.

In the combat-mechanics sample, equip the **Tidal charm** in the gear room and
enter either **Shared passives** practice view. **A** grants Conductive attunement;
**X** queues Arc bolt; **B** resolves. The charm relieves exhaustion after water
damage actually received. Attunement restores stamina from actual direct lightning
damage and relieves exhaustion. In the underwater boss fight that damage also
charges the existing seal gauge once. Replay `shared-passive-grants` and
`passive-expiry` in both encounters.

## Intercepting damage and healing

In an encounter's **Mechanics**, a reusable ruleset, or **Shared combat passives**,
add a trigger and select **Pending damage** or **Pending healing** as its event.
The same structured trigger editor supports both. Set target/source filters to
limit the affected packets; a shared passive can select `self` for its bearer.

Choose one of the pending effect types:

- **Adjust pending effect**: edit **Pending amount adjustment** and optional
  **Pending adjustment (%)**. The flat adjustment happens first; -100% cancels
  the packet. Both damage and healing can be adjusted.
- **Absorb damage with a resource**: select the resource and optionally set
  **Maximum per effect (empty = unlimited)**. Resource units pay for absorption
  one-for-one after defense and Guard.
- **Redirect pending damage**: choose **Redirect recipient**, **Damage redirected (%)**
  and optional maximum. Recipient defenses and shields still apply. Redirected
  packets cannot redirect again.
- **Prevent a lethal hit**: edit **Minimum surviving health**. Add an event-flag
  condition for **Lethal** = true and enable **Once** for once-per-fight protection.

The event picker limits the effect and condition fields to valid combinations.
Healing has adjustment only; damage-only operations are unavailable there.
Pending hooks cannot apply HP damage/healing or finish combat directly. Existing
resource, status and phase effects remain available. Switching effect types
clears obsolete fields while preserving extension data on save.

Use **Include reaction effects** to control protection against reactions and
redirected packets; pending hooks include these by default. Ordinary resolved
reactions keep their existing default. Event conditions expose pending **Amount**,
**Incoming amount**, shield **Absorbed**, lethal **Prevented**, **Redirected amount**
and flags for lethal/redirected damage. Later triggers see earlier adjustments.
Resolved events continue to expose actual HP changes.

Save the library/encounter, grant the passive through a status or equipment, and
open **Combat simulation and debugging**. Replay a saved scenario, filter the
trace to mechanics, then select an `absorb-damage`, `redirect-damage`,
`prevent-lethal` or `adjust-effect` step. Its `interception` details show before,
after, shield resource/spending or redirect recipient; source passive details
identify the granting item/status. Live combat previews display a notice that
interception is applied during resolution.

In the combat-mechanics sample, open either **Interception** view from the
harbour or gear room. **A** raises a stamina-funded air barrier, **F** applies
Waterlogged, **S** heals, and **B** resolves. Equip the **Rescue charm** in the
gear room before entering for lethal protection. In the underwater boss view,
**Z** awakens the guardian's conduit and **X** fires Arc bolt. Replay
`intercept-shield`, `intercept-healing` and `intercept-last-breath` in both
encounters, and `intercept-conduit` for the underwater boss. The latter confirms
9 actual guardian damage and 9 seal charge after half the bolt redirects.

## Trigger priorities, charges and cooldowns

Open **Mechanics → Triggers** on an encounter, shared ruleset or shared passive.
The trigger controls include:

- **Trigger priority (higher first; empty = 0)**: integers from -10,000 to 10,000.
  Priorities sort encounter and passive triggers together for each event. Equal
  values retain source order; **Move up** changes ordering within a tie.
- **Trigger charges (empty = unlimited)**: 1–10,000 activations for this encounter.
- **Activations per turn (empty = unlimited)**: 1–10,000 between consecutive actor
  turn starts. This resets for every combatant turn, before turn-start triggers.
- **Trigger cooldown (rounds; empty = 0)**: 0–1,000 rounds to skip after firing.
  A value of 1 fires in round 1, skips round 2, and becomes ready in round 3.

Each granting item/status has its own counters. All limits must allow activation;
**Run once per encounter** continues to cap a trigger at one execution. Removing
and reapplying the same status does not refill charges. A failed trigger condition
or filter consumes nothing; a matched trigger reserves its activation before
running effects, including when an effect does not change anything. For shields,
add conditions for positive pending damage and available shield resource to
avoid spending charges on empty packets.

Save through the containing encounter/library form. Clear a field to remove it;
inherited encounter overrides explicitly remove the inherited value. Controls
participate in draft recovery and validation, and preserve extension data when
saved. Invalid numbers remain editable until corrected.

In **Combat simulation and debugging**, filter to mechanics. Timeline choices
label **Activated**, **No charges remaining**, **Per-turn limit reached**,
**Trigger cooling down** or **Already activated once**. Select a frame to inspect
`activation.priority`, remaining budgets and blockers. An `activated: true` frame
shows the counters after reservation; a failed match shows the current blockers.
Save/load preserves live combat counters and cooldowns.

The combat-mechanics harbour and diving gear room link to **Trigger limits:
Water** and **Trigger limits: Underwater guardian**. **A** raises the Paced barrier;
**B** resolves. Its shield runs at priority 20 before priority-10 softening, has
three charges, a one-activation turn limit and a one-round cooldown. Actions also
refund 2 stamina once per turn: queue multiple actions to see the turn blocker.
Replay `trigger-priority`, `trigger-per-turn` and `trigger-limits` for both
encounters. Their health/stamina checks verify ordering, refund limits and shield
spending across six rounds; inspect traces to see the corresponding counters.

## Health, stats and round formulas on every effect

Move value/cost formulas now offer **Current health**, **Missing health**, **Stat**
and **Round number** as scaling sources. Health sources support absolute values
or percentages of maximum health. Stat sources select attack, defense, guard or
maximum health; round sources need no actor. Use `self`, `target` or a named actor;
trigger field formulas can also use event actors in damage/healing hooks.

On an ability effect, status or trigger effect, open **Numeric effect scaling**.
Select a **Numeric field** and choose **Add field scaling**. Configure its
**Scaling: <field>** section with the usual terms, mode, bounds and rounding.
This covers resource changes, periodic damage/regeneration, modifiers and status
type defenses, shield maximums, redirection percentages, lethal HP floors, and
status stacks/intensity/duration. The numeric base remains visible in the normal
effect controls. Adding an optional status strength/duration formula supplies a
base of 1, which you can edit. **Applied duration** left empty uses the status default.
Disable scaling in that field's section to remove it.

Field formulas run before existing primary/event formulas and ordinary combat
modifiers. Earlier actions can change later values. Periodic/status contributions
are evaluated live; status stat inputs use pre-status values to prevent recursion.
Applied durations and strengths respect the status's configured ceilings. Zero
scaled status strength is a no-op; omitted removal strength still removes all
stacks. Preview values are conditional on current state and do not predict queued
buffs or the next regeneration tick. Reference and numeric errors remain editable
until corrected; saves retain extensions and clear obsolete source fields.

The harbour and gear room link to **Dynamic effects: Water** and **Dynamic effects:
Underwater guardian**. **A** raises Adaptive current, **S** uses Adaptive breath,
**Z** casts Pressure lance and **B** resolves. The boss view's **F** enables its
conduit. Current defense increases when wounded; regeneration and water resistance
increase each round. The shield maximum also uses round and defense. Pressure
lance scales with target health, attack and round, with a growing stamina cost.

Replay `dynamic-recovery`, `dynamic-periodic-shield` and `dynamic-strike` in either
encounter. The periodic scenario starts at 20 HP to exercise missing-health defense
and checks health, stamina and duration every round. The underwater strike starts
with conduit active: 12 damage redirects, the guardian loses 13 HP and its seal
gains 13. Save/load retains round and status context so the same actions replay
with the same values.

## Rich scenario assertions and simulated items

In **Saved combat scenarios**, add an expected result at a step checkpoint or in
**Final results**. **Expected result type** now includes `passive-activations`,
`interception`, `damage-total`, `healing-total`, `action-choices`, `cooldown`,
`trigger-cooldown` and `item-consumption`. Configure the filters shown for that
type, choose **Expected comparison**, and enter **Expected value**. Empty optional
filters mean any matching event; unknown IDs are errors, including zero-count checks.

**Assertion scope** selects the whole scenario (default) or the current step's
repeat group. Final step-scoped assertions refer to the last step. Cooldown checks
always read current state, with **Assertion measure** selecting remaining rounds
or the stored ready round. Passive cooldown checks need all five source fields:
actor, library, passive ID, grant source kind and grant source ID.

Passive counts measure matched activations. Interception measures count, absolute
packet adjustment, or shield resource spent. Damage/healing default to actual HP
changed; packet count and mitigation/overheal measures are available separately.
Use **Effect source**, **Effect target**, move, type and delivery to isolate
redirected or periodic packets. **Action stage** distinguishes a move chosen for
resolution from one that executed; **Enemy AI rule** filters the actual rule that
selected it. Plan previews do not contribute to these counters. Completed fights
keep the engine's existing cleared-cooldown state.

Choose **Scripted item (empty = native move)** on a scenario action to select a
carried item instance. The action automatically uses its authored ability. Selecting
a native move clears the item reference. The simulator also offers **Simulation
item → Queue item**, including explanations when unavailable. Consumables disappear
only from the simulation; reusable items count as actions but not consumption.
Both share their ability cooldown with native casts and other copies. Undo/clear
releases reservations, while **Start/reset simulation** restores consumed items.
Captured plans keep item IDs and replay against the current inventory definitions.

Replay and inspect actual/expected values in the check report. The simulation JSON
report includes `metrics` and `consumedItems`. These counters are committed with
rounds, so trace truncation and failed calculations cannot hide or invent events.
Saving a scenario preserves extensions, and changing an assertion type clears
its old filters. Editing a comparison does not change the tested game mechanics.

Water adds `assert-passive-shield`, `assert-items-healing` and
`assert-enemy-choices`. Underwater boss adds the first two and
`assert-conduit-damage`. The item scenario checks 6 healing through Waterlogged,
a cooling-down round, then 12 healing from a reusable breath stone. Total healing
is 18, tonic consumption is 1 and stone consumption is 0. The boss conduit check
verifies 13 guardian damage, 12 redirected damage and 13 seal charge.
