# Graphics assets and layered appearances

Set `assets` in the game manifest to a catalogue ID. For example,
`"assets": "wardrobe"` loads `assets/wardrobe.json`. The catalogue has
`"schema-version": "1.0.0"` and `images`, `parts`, and `compositions` dictionaries.
Visual IDs are unique across those dictionaries.

`sample-games/graphics` is the complete reference game: two independent characters,
matching item icons, tunic palettes, sword materials, and a cloak with rear fabric
and a front clasp selected together. In the editor's Assets panel, select `paper-doll`
to swap `tunic-part` (wayfarer) with `ranger-tunic-part` (longer, split hem), and
`sword-part` (straight blade) with `saber-part` (curved blade and knuckle guard).
Both tunics share fabric, trim, and metal slots and the wayfarer/royal/ember presets;
both swords share blade, edge, hilt, and grip slots and the steel/bronze/obsidian
presets. The gallery shows both silhouettes; the ember scene uses the alternate
parts with matching item previews. Export it using:

```sh
pnpm export:game sample-games/graphics
```

The development page `/asset-lab.html` loads that same game, artwork, palettes,
and supported renderer. Its controls are temporary and reset on reload. This
page is not included in regular engine builds or standalone game exports.

## Images and prepared SVG

Image entries contain `format` (svg, png, jpeg, or webp), a game-relative `source`,
and `bounds` (x, y, width, height). SVG bounds must equal the source viewBox;
raster bounds start at (0, 0) and match encoded dimensions. An optional `preview`
rectangle crops an image preview while retaining its original coordinates when
used in a part. Remote source URLs and parent-directory paths are unsupported.

`colors` maps named slots to six-digit hex defaults. `palettes` maps preset names
to partial color overrides. Raster images cannot declare colors or palettes.

```json
{
  "format": "svg",
  "source": "assets/images/tunic.svg",
  "bounds": { "x": 62, "y": 120, "width": 196, "height": 174 },
  "colors": { "fabric": "#397c73", "trim": "#e4c58b", "metal": "#c99b50" },
  "palettes": { "royal": { "fabric": "#665191", "trim": "#e7c783" } }
}
```

Create SVG artwork externally. Recolorable paint uses presentation attributes
such as `fill="var(--fabric, #397c73)"` or `stop-color="var(--gem, #123456)"`.
A slot must have the same fallback wherever it occurs. The importer discovers
slots; Ancadeba edits their defaults and presets. Fixed outlines, highlights,
and translucent shadows remain artwork.

The static profile supports svg, g, path, rect, circle, ellipse, line, polyline,
polygon, defs, linearGradient, radialGradient, stop, clipPath, mask, use, title,
and desc. Geometry, paints, opacity, transforms, and local definitions are supported.
References use `href="#id"` or `url(#id)` and must target an existing local ID.
A valid SVG namespace and finite positive viewBox are required.

Convert visible text to paths and styles to presentation attributes before import.
Stylesheets, style attributes, scripts, event handlers, external resources,
foreignObject, DTDs, processing instructions, and animation are rejected. Each
source is limited to 10 MiB, 20,000 elements, and 128 nesting levels.

SVG is parsed with saxes without browser/Node globals. Recoloring serializes an
isolated SVG image; imported markup never enters the page DOM. An engine-owned
SVG canvas places images, so gradients, clipping, and IDs stay local to each source.

## Parts and compositions

A part has bounds, color defaults/presets, and a nonempty `pieces` array. Each
piece has a unique `id`, an `image` ID, a `layer`, a destination `anchor`, a
`sourceAnchor` point, positive `scale`, and finite `rotation` in degrees. Defaults
are anchor origin, source point (0, 0), scale 1, and rotation 0.

Piece `slots` maps image color-slot names to shared part color-slot names. A cloak's
fabric and separate clasp can take colors from one part appearance. Unmapped image
slots retain image defaults.

A composition declares bounds, back-to-front ordered `layers`, named `anchors`,
and selectable `slots`. Each slot lists allowed `parts` and a `default` part ID
or null. Every allowed part must use layers and anchors declared by the composition.
Selecting a part changes all pieces together. Equal-layer pieces retain catalogue
slot/piece order. Nested compositions are unsupported.

Placement is translate(destination), rotate(rotation), scale(scale), then
translate(-sourceAnchor), preserving artwork coordinates. The sample sword's grip
at (40, 215) meets the right hand at (250, 257). When previewing a part by itself,
each source attachment point is its own destination; part bounds frame the preview.

## Scene graphics and bindings

A `graphic` component references an image, part, or composition with `visual` and
uses normal grid placement. `fit` defaults to contain; cover crops at component
edges. `alt` is required: empty means decorative. Optional `altKey` follows existing
translation rules and can resolve to an empty decorative label.

`appearance` supports palette, colors, visible, and, for compositions, a slots
dictionary. Each slot can override part (null removes it), palette, colors, or
visibility. Composition colors and presets belong to its slots.

The following appearance fragment illustrates live customization in a game scene:

```json
{
  "slots": {
    "tunic": {
      "part": "tunic-part",
      "colors": { "fabric": "#397c73" },
      "bindings": {
        "colors": { "fabric": { "source": "game.state", "path": ["hero", "fabric"] } }
      }
    },
    "sword": {
      "palette": "steel",
      "visible": true,
      "bindings": {
        "palette": { "source": "game.state", "path": ["hero", "material"] },
        "visible": { "source": "game.state", "path": ["hero", "showSword"] }
      }
    },
    "cloak": {
      "part": "cloak",
      "partBinding": { "source": "game.state", "path": ["hero", "cloakPart"] }
    }
  }
}
```

Bindings read scalar paths from game.state or game.progression and require game
scenes. Parts use allowed IDs or an empty string for no part; visibility requires
a boolean, presets require known names (or an empty string for defaults), and
colors require six-digit hex strings. Explicit static values, or catalogue defaults
when omitted, supply typed fallbacks. Invalid/unavailable values use that static
appearance and produce diagnostics. Dynamic part slots require static overrides
compatible with every allowed part. This layer defines no inventory/equipment rules.

Color precedence is image defaults, mapped part defaults, selected preset,
explicit component colors, then valid bound colors. Inventory graphics and parts
can bind to the same state paths. Resolution does not mutate other instances.

## Authoring and lifecycle

Load a project in the editor's Game project panel. Assets imports/registers images,
browses thumbnails, edits defaults/presets, and places scene graphics. Choose
**Add definition** or select an existing part or composition to open structured
authoring with a live preview. Scene graphics also have visual appearance controls;
advanced image definitions retain a JSON form. Restart engine preview to see saved changes.

### Visual scene appearance authoring

Select a graphic in the scene explorer, or choose **Add graphic** in a scene.
Choose **Graphic visual** from the registered images, parts and compositions, then
edit **Graphic appearance**. These settings affect this scene instance only.
Changing the visual resets its appearance; the shared asset stays unchanged.

**Static visibility** shows or hides the whole graphic or an individual composition
slot. Images and parts expose **Static palette** and their named colors. Choose
**Override color** to use a color picker or enter a six-digit hex color; choose
**Inherit palette / default** to remove that override. Explicit colors override
the selected palette. Raster artwork exposes visibility without recoloring controls.

Composition **Slot** groups offer **Default**, **None**, and each allowed part.
Each slot has its own palette, colors and visibility. **Reset slot appearance**
restores the catalogue default and removes its overrides and bindings. Changing
a part retains compatible overrides and clears incompatible colors and palettes.

In game scenes, each property has a **binding** group. Choose a declared state
field or another compatible game value, or use **Custom path** to choose a source
and edit individual object/Map keys and array indexes. **Use static value** removes
the binding. Static appearance supplies the fallback if a bound value is missing
or invalid. Colors require `#rrggbb`, palettes require a preset name (empty text
means default colors), visibility requires a boolean, and part selection requires
an allowed part ID (empty text means no part). With a part binding, static palette
and color overrides must work for every allowed part; the form offers shared
choices and clears incompatible overrides when enabling the binding.

**Preview values** switches between **Static fallback values** and **Starting game
values** without saving or changing the draft. The latter uses declared initial
state and quest values; runtime-derived or custom values may be unavailable until
play. Hidden graphics and unavailable bindings are explained beside the preview.
Stand-alone scenes expose static appearance controls only.

**Save scene graphic** uses revision-checked persistence and shared project Undo/Redo.
Invalid edits, failed saves, conflicts and unrelated saves retain the draft.
**Discard scene graphic draft** restores the saved component. Saved component IDs
are read-only, and new graphics cannot replace another component with the same ID.

### Visual part authoring

Choose **Definition kind → Parts**, enter a **New graphic definition ID**, and
choose **Add part**. Set its **Preview bounds**, then enter a **New piece ID** and
choose **Add image piece**. Import an image first if none are registered.
For each piece, choose its image, layer and destination anchor; edit source anchor
coordinates, scale and rotation. **Move piece … up/down** controls the order of
pieces on equal layers. Preview markers label each source attachment point.

**Part colors and palettes** adds shared part color slots and palette presets.
Map each image color to a part color, or leave it at the image default. Palette
overrides may inherit the part's defaults. **Preview palette** tries a preset
without changing the draft. Removing a part color clears its palette overrides and
piece mappings, leaving the image defaults in effect.

### Visual composition authoring

Choose **Definition kind → Compositions** and add a definition. Edit its bounds
and its layers in back-to-front order with **Move layer … back/forward**. Add
named destination anchors and edit their coordinates; markers in the preview show
where pieces attach. Layer names and piece attachment references must match.

Add a named slot, select its allowed parts, and choose **Default part**, including
**None**. Adding an allowed part includes any missing layers and anchors it needs;
existing anchor positions remain unchanged. Newly included anchors start at the
part's source attachment point. Each slot changes all of a selected part's pieces
together. Slots can select parts, never nested compositions.

**Save parts and compositions** saves all part and composition changes together.
Switch entries within this form to update shared references before saving. Add or
clear pending identifiers before changing entries or saving. Invalid references,
duplicate IDs, empty parts, missing layers/anchors, invalid transforms, and
deletions still referenced by scenes or inventory are rejected. Drafts survive
save failures, revision conflicts and unrelated saves. **Discard graphic definitions
draft** restores saved definitions. Saved changes use shared project Undo/Redo.

The revision-checked `assets.updateDefinitions` command accepts complete `parts`
and `compositions` dictionaries. It preserves registered images and extension
fields at stable definition/piece IDs. Changing layer names or anchor references
can require changes to multiple related definitions; the shared draft lets those
changes pass validation together.

POST /api/editor/assets/import accepts multipart fields metadata (JSON with path,
expectedRevision, id, format) and file. The entire request, including multipart
overhead, is limited to 10 MiB. Source names are unique; replacements never overwrite
old artwork. Compatible colors/presets are retained. Definitions publish only after
validation. An uncertain save reports the new source path: inspect before retrying.
Unreferenced sources can remain after publication failure and are not auto-deleted.
Unused broken images can be replaced or unregistered through guarded repair
operations. Removing definitions still referenced elsewhere is rejected.

Project revisions cover catalogue JSON and registered artwork bytes. MCP exposes
single-definition asset edits through ancadeba_edit_assets, with catalogue/source diagnostics
from ancadeba_inspect_assets. MCP registers files already inside the game; browser
or HTTP import handles binary uploads.

Each mounted game/preview owns its graphics service. Sources load lazily; concurrent
reads and decodes are deduplicated. Variants are keyed by source content and palette.
Active variants plus 64 unused variants are retained; URLs are revoked on eviction
or disposal. Grouped appearances replace their predecessors only when all pieces
are ready. Stale completions are released. Source failures show accessible
placeholders, with detailed diagnostics in the editor.

Export validates references and registered source format, bounds, profile, and slots
before publishing. Normal regular-file copying remains, including unused files.
Exported games need no editor server and can move under a nested hosting path.
