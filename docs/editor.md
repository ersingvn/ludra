# Studio as an editor (v0.99): design and who builds what

Ludra Studio (v0.97) lets a person watch an agent make a game. v0.99 lets the person **work on it too**,
in the same scene and at the same time: select a thing in the game and drag it, change a value in the
inspector, drop a prefab or a block into the level, delete, undo. Every edit is written to the scene's
JSON, the same files the agent edits, so the agent sees what the person did (and the Activity panel
shows who did what). Unity's editor, with an AI working next to you.

Three parts, built in parallel, each on its own branch cut from `feat/v0.99-editor`, merged back into it.
Read `docs/studio.md` first: this extends that contract.

## Rules for everyone

- **The files are the truth.** Studio never keeps its own copy of the scene. An edit is a change to a file,
  and the game shows it through the same hot reload as an agent's change (state kept when it can be).
- **Never lose the agent's work.** An edit names the version of the file it was made against; if the file
  changed since (the agent wrote it), the edit is refused with `409` and the UI fetches the file again.
- **Never write a broken scene.** The server runs the same validation as `ludra check` on the result and
  refuses edits that add an error (`422` with the diagnostics). Warnings are fine.
- **Keep the agent's formatting.** Writes keep key order, 2-space indent and a trailing newline, so a
  one-value edit is a one-line diff.
- Deterministic engine rules still hold: drawing never changes the game; a drag preview is presentation.
- `npm test` green and `review --strict` clean on every `packages/cli/templates/*` before you hand over.
  Commits `v0.99 <part>: <what>`. Don't push to `main`. Worktrees go under `.worktrees/`, never on the Desktop.

## Parts and who owns which files

| Part | Session | Branch | Owns |
| --- | --- | --- | --- |
| **A. Edits: server and inspector** | victus-41 | `feat/editor-edits` | `packages/cli/src/studio-api.ts` (and new `packages/cli/src/scene-edit.ts`), `packages/studio/ui/src/panels/inspector.ts`, `packages/studio/ui/src/backend.ts`, the mock backend, their tests |
| **B. Viewport tools: select, drag, place, delete, undo keys** | victus-d7 | `feat/editor-tools` | `packages/core/src/studio-link.ts`, the studio parts of `packages/core/src/browser.ts`, `packages/studio/ui/src/panels/viewport.ts`, `hierarchy.ts`, new `packages/studio/ui/src/panels/palette.ts`, `game-link.ts`, their tests |
| **C. Proof at scale: `solve` on big levels** | victus-85 | `feat/v0.99-editor` | `packages/core/src/solve.ts`, `packages/cli/src/commands/solve.ts`, merging, PR |

Shared: `packages/studio/ui/src/protocol.ts` (both A and B add types: additive only), `studio.ts`,
`docs/studio.md` (each part adds its own section at the end), the README. Small, additive edits only.

## A. Edits (victus-41)

### Endpoints (added to `ludra dev --studio`, same token and local-host rules as the others)

- `GET /__ludra/file?path=scenes/main.scene.json` → `{ path, version, text }`. `version` is a hash of the
  text (the same one used below).
- `POST /__ludra/edit` with
  ```ts
  { path: string; version: string; edits: Edit[]; label?: string }
  type Edit =
    | { op: "set"; entity: string; field: string; value: unknown }   // field like "components.transform.x" or "components.sprite"; undefined removes it
    | { op: "add"; entity: EntityDef; after?: string }               // appended, or after that entity
    | { op: "remove"; entity: string }
    | { op: "scene"; field: string; value: unknown }                 // scene-level, e.g. "world.gravity", "effects.spot"
  ```
  All edits apply together or not at all. Answers `{ ok: true, version, diagnostics }` (warnings), `409
  { error, version }` when `version` is stale, `422 { diagnostics }` when the result has errors, `400` for a
  bad edit (unknown entity, an entity a tilemap makes — say to edit the tilemap instead).
  `label` is what the person did ("Moved coin-3"), for undo and Activity.
- `POST /__ludra/undo` and `POST /__ludra/redo` with `{}` → `{ ok, path, label }` or `{ ok: false }` when
  there's nothing to undo. The history holds Studio's own edits, newest last; undoing an edit refuses (409)
  when the agent has changed that file since, rather than overwrite its work.
- The `change` event in `/__ludra/events` gains `by: "studio" | "files"`: `"studio"` when the change is one
  this server just wrote (an edit, undo or redo), with its `label`. Everything else is `"files"` (the agent,
  an editor, git).
- `/__ludra/project` gains `prefabs: string[]` (names) and `blocks: { name, description, tags }[]`.
- `/__ludra/run` gains `add` with args `[block, "--at", "x,y"]` (and `--id name`), running `ludra add`,
  for the palette.

### Inspector

- The selected entity's components as **editable fields** from the component schema (`ludra components`
  JSON: numbers, booleans, enums as selects, colors, strings), showing the **scene value** (from the file)
  with the **live value** beside it when they differ (a moving body). Editing writes the scene value.
- Add and remove components (a menu of the schema's components), edit the id (rename, refusing a taken one).
- Entities from a prefab show which values come from the prefab; editing writes an override on the entity.
- Read-only, with the reason, for entities the scene file doesn't hold (tilemap cells, spawned ones).
- Number fields drag to scrub (like Unity), Enter commits, Esc reverts, and errors from `422` show inline
  with the diagnostic's `fix`.

## B. Viewport tools (victus-d7)

### Game link additions (`studio-link.ts`, browser side; Studio → Game unless noted)

| type | fields | effect |
| --- | --- | --- |
| `view` (Game → Studio) | `cameraX`, `cameraY`, `zoom`, `width`, `height` | with each `status`, so the UI can map screen ↔ world |
| `preview` | `id`, `x`, `y` | draws the entity at (x, y) instead of where it is, until `preview` with `id: null`. Presentation only |
| `ghost` | `prefab` or `components`, `x`, `y` (or `null`) | draws a translucent entity where a placement would go |
| `grid` | `size` (0 = off) | draws a grid over the world |

All 2D. In 3D, `view` isn't sent and the tools say they're 2D for now.

### Tools in the viewport

- **Select** (the default while paused or with the pick tool on): click picks, as today; the selected entity
  gets handles. **Drag** moves it: `preview` while dragging, then on release `set components.transform.x/y`
  through A's `/__ludra/edit` (label "Moved <id>"). Snap to the grid when it's on (G toggles, size in the
  toolbar), Shift drags along one axis, Alt+drag duplicates (an `add` with a fresh id).
- **Delete/Backspace** removes the selected entity (`remove`), **Ctrl+D** duplicates, **Ctrl+Z / Ctrl+Y**
  call `/__ludra/undo` and `/__ludra/redo`, **F** frames the selection.
- **Palette** panel: the project's prefabs and the block library (from `/__ludra/project`). Pick one, then
  click in the game to place it: a prefab is an `add` with `{ id, prefab, components: { transform } }`;
  a block runs `/__ludra/run` `add` at that point. `ghost` shows where it will go.
- Editing while the game runs: the edit goes to the file and hot reload shows it; while paused, the
  replayed world stays paused at the same frame.
- **Hierarchy**: Delete, duplicate and rename from a context menu; drag to reorder (an edit that moves the
  entity in the list: use `remove` + `add` with `after`).
- Activity shows the person's edits as "You moved coin-3" (from `by: "studio"`) and the agent's as now.

Until A's endpoints land, build against the mock backend: A adds `edit`, `undo`, `redo` and `file` to it
first (tell victus-d7 when they're in), so the tools can be built and tested with `index.html?mock=1`.

## C. Proof at scale (victus-85)

`ludra solve` gives up on long levels (about 100 columns in four minutes), and `fuzz` then skips its
softlock checks. A beam search that keeps the most promising states, with slack for a human's timing
(as `yerel/deneme/ludra-ile/tools/autopilot.mjs` did), solves them. Make it `solve`'s strategy for big
levels, with the same output, tests and the same fixed work budget as `review`.
