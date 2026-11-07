# Ludra Studio (v0.97): design and protocol

Ludra Studio is a desktop app (Electron) for a person to watch an agent make a game. The game runs live in
the app, and when the agent edits a scene, prefab, script or asset, the change shows up **in place**: the
game doesn't restart. Because the simulation is deterministic, Studio rebuilds the world from the new files
and replays the inputs played so far up to the same frame. Next to the game are the scene's entities, a live
inspector, what the agent changed (with diffs), and the results of `check`, `test` and `review`.

```
ludra studio [dir] [--port 5173]
```

This document is the contract between the three parts below. Each part is built by one person or agent on its
own branch, cut from `feat/v0.97-studio`. If you need to change the contract, change this file in that same
commit and say so.

## Parts and who owns which files

| Part | Branch | Files |
| --- | --- | --- |
| **Engine and server.** Hot reload with replay, the game ↔ Studio link, server endpoints | `feat/studio-engine` | `packages/core/src/browser.ts`, new `packages/core/src/studio-link.ts`, `packages/cli/src/server.ts`, `packages/cli/src/commands/dev.ts`, new `packages/cli/src/studio-api.ts`, their tests |
| **UI.** Every panel a person sees | `feat/studio-ui` | `packages/studio/ui/**` |
| **Shell.** The Electron app, `ludra studio`, packaging, docs, integration | `feat/studio-shell` | `packages/studio/{package.json,tsconfig.json,src/**}`, `packages/cli/src/commands/studio.ts`, the `studio` case in `packages/cli/src/index.ts`, root `tsconfig.json`/`package.json`, `README.md`, this file |

Don't edit another part's files. Ask the owner instead.

## How it fits together

```
Electron main (packages/studio/src/main.ts)
 ├─ starts `ludra dev <dir> --studio --port P --no-record` as a child process, waits for the port
 └─ BrowserWindow → packages/studio/ui/index.html?server=http://127.0.0.1:P
        ├─ UI panels (packages/studio/ui)
        ├─ <iframe src="http://127.0.0.1:P/?studio=1">  ← the game page from ludra dev, in studio mode
        │      ⇅ window.postMessage (the game link, below)
        ├─ EventSource  http://127.0.0.1:P/__ludra/events   (file changes)
        ├─ fetch        http://127.0.0.1:P/__ludra/project, /__ludra/run
        └─ window.studio (preload, IPC to main): openProject, reveal, openInEditor, ...
```

The UI must also run in a normal browser: as `ui/index.html?server=...` against a real `ludra dev --studio`,
and as `ui/index.html?mock=1` with no server at all (a mock that plays a fake game and fake changes). Then
it can be built and looked at without Electron. When `window.studio` is missing, the features that need it
are hidden.

## Server endpoints (engine part)

These are added by `ludra dev --studio`. Plain `ludra dev` keeps working as it does today. All endpoints send
`Access-Control-Allow-Origin: *`, because the UI is a `file://` page.

- `GET /__ludra/project` →
  `{ name, dir, entry: "scenes/main.scene.json", scenes: string[], window: { width, height, pixelated } }`
- `GET /__ludra/events` is Server-Sent Events. Each `data:` line is one JSON message:
  - `{ type: "hello", version }` once, on connect.
  - `{ type: "change", version, at: ISO time, files: FileChange[] }` when files in the project change.
    Changes are batched over about 100 ms.
    `FileChange = { path, kind: "scene"|"prefab"|"script"|"asset"|"config"|"test"|"design"|"other", change: "added"|"changed"|"removed", diff?: string }`.
    `path` is relative to the project, with `/`. `diff` is a unified diff for text files of 1 MB or less
    against the last version the server saw, cut at 400 lines.
- `POST /__ludra/run` takes `{ command: "check"|"test"|"review", args?: string[] }` and responds with
  `{ ok: boolean, exitCode, result }`. `result` is exactly what `ludra <command> <dir> --json ...args` prints,
  parsed. Only one run per command at a time: a second run of the same command waits for the first.

## The game link (engine part, in the game page; UI part, on the other side)

When the page is opened with `?studio=1`, the game page doesn't reload when a version changes, doesn't show
the recording hint, and talks to `window.parent` with `postMessage`. Every message has the shape
`{ ludra: 1, type: string, ...fields }`. Both sides ignore messages without `ludra: 1`.

### Game → Studio

| type | fields | when |
| --- | --- | --- |
| `ready` | `scene` (path), `dimensions` (2 or 3), `width`, `height`, `physics` | each time a scene starts, including after a restart or a level change |
| `status` | `frame`, `paused`, `won`, `lost`, `score`, `lives`, `deaths`, `fps` | 10 times a second at most, and right after any change |
| `entities` | `list: EntitySummary[]` | when a scene starts, and whenever the set of entities or their names changes |
| `entity` | `id`, `data` (the entity as JSON, live values: `{ id, name?, prefab?, components: {...} }`), or `data: null` if it's gone | in answer to `inspect`, then 10 times a second at most while it's selected and changing |
| `picked` | `id` or `null` | the person clicked the game while picking |
| `hot` | `result: "kept"|"restarted"|"rejected"`, `frame`, `files: string[]`, `reason?` | after a hot reload (below) |
| `event` | `event`: a world event (`die`, `win`, `collect`, ...) as the engine records it | as they happen, 20 a second at most |
| `error` | `message`, `diagnostics?` (as in `ludra check --json`) | a script error, or a changed scene that doesn't pass check |

`EntitySummary = { id, name?, prefab?, parent?, components: string[], x, y, z? }`

### Studio → Game

| type | fields | effect |
| --- | --- | --- |
| `pause` / `resume` | | stops or starts the simulation clock. Rendering goes on. |
| `step` | `frames?` (default 1) | while paused, advance exactly this many frames |
| `restart` | | like pressing R |
| `goto` | `scene` | start this scene |
| `inspect` | `id` or `null` | select an entity for `entity` messages |
| `highlight` | `id` or `null` | draw an outline or box around it in the game view (studio only, never in a build) |
| `pick` | `on: boolean` | while on, a click in the game answers `picked` with the entity under the cursor |
| `mute` | `on: boolean` | |
| `focus` | | give keyboard focus to the game, so the person can play |

## Hot reload (engine part)

When `/__ludra/events` reports a change to a scene, prefab, script or asset that the running scene uses:

1. Fetch the scene again. If it doesn't pass check, keep running the old version and send `error` with the
   diagnostics plus `hot` with `rejected`.
2. Otherwise build a new world from the new scene and replay, without drawing, the exact inputs played since
   the scene started, up to the current frame. Keep paused/running as it was.
3. If the replay finishes the scene earlier (won, lost, or the scene changed) or throws, start the scene fresh
   instead, and send `hot` with `restarted` and a `reason`. Otherwise send `kept`.
4. Changes to `ludra.json` or `game.md` aren't hot: send `hot` with `restarted` and reload the page.

Replay is capped at 2 minutes of game time (7,200 frames). Past that, it restarts with the reason "too far in
to replay".

### Engine notes (as built on `feat/studio-engine`)

What the engine does where the contract above leaves room. The UI can rely on these:

- **Only the three studio endpoints send `Access-Control-Allow-Origin: *`.** The game page and its files
  (`/`, `/__ludra/scene`, `/__ludra/script/...`) don't, because the iframe loads them from their own origin.
  Otherwise any web site open in a browser could read the game's code from `127.0.0.1`.
- **A token, for the shell to set.** When `ludra dev --studio` runs with `LUDRA_STUDIO_TOKEN` in its
  environment, every studio request must carry it as `?token=...`. Without it the answer is 401.
  EventSource can't send headers, so it goes in the query. The shell should make a random one, put it in
  the child's environment, and pass it on to the UI. The UI adds it to `/project`, `/events` and `/run`, and
  to the iframe's URL (`/?studio=1&token=...`), and the game page passes it on to its own `/events`.
  Without a token, the endpoints are open to any page, as the contract first said.
- **The studio endpoints only answer a local Host** (`localhost`, `127.0.0.1`, `[::1]`, any port), so a web page
  that points its own name at this machine can't read the project through them. Anything else gets 403.
- **`/__ludra/run` takes only these `args`:** `review`: `--fast`, `--strict`. `check` and `test`: none.
  Anything else is a 400 with `{ error }` saying what it takes. An unknown command and a non-POST request are
  400 and 405.
- **`diff`**: a file rewritten past 2,000 edits gets an all-removed, all-added diff instead of a minimal one.
  Like any diff, it's cut at 400 lines, and the last line then says `… N more lines`. A removed file's diff
  removes every line, and an added one adds them.
- **`ready`**: `width` and `height` are the game canvas in pixels. `physics` is the engine's name
  (`arcade`, `rapier`, `rapier3d`).
- **`status`**: `lives` is `null` when the scene has unlimited retries. A `status` goes out right after
  `pause`, `resume` and every `hot`.
- **`entities` and `entity`**: the engine doesn't keep a name or a prefab after validation, so those fields are
  left out. `components` lists the live component states, `script` included. `entity.data` is
  `{ id, components, state }`. Another entity it refers to is `{ entity: "<id>" }`, and functions are left
  out. `entities` goes out again when an entity is added or removed or its components change, not when it
  moves.
- **`pick` and `highlight` work in 2D.** They use the entity's body, or its sprite, or a 24 px square. Where
  several overlap, the smallest one under the cursor wins. In 3D, `picked` is `null` and `highlight` draws
  nothing yet.
- **`event`**: past 20 a second, the rest of a burst is dropped rather than sent late.
- **`hot`**: changes to a prefab, a script or an asset are hot. So is a change to a scene, but only to the
  running one. A changed script loads again, not from the module cache. A scene that doesn't pass check is
  `rejected` with `error.diagnostics`, and so is one that can't be loaded, such as a script with a syntax
  error. Its `reason` says which.
- **A page that opens on a broken scene** sends `error` with the diagnostics and reloads on the next change.


## UI (UI part)

Dark, dense and calm, like a pro tool (Godot or Unity), not like a website. Layout:

- **Toolbar:** project name, scene picker, ▶ play / ⏸ pause / ⏭ step / ⟲ restart, frame and fps, a pick
  tool, and Check, Test and Review buttons, each with a badge for its last result.
- **Left: Hierarchy.** The entities, with search, an icon by main component (player, enemy, hazard, goal,
  platform, light, camera...), and selection synced with the game (`inspect`, `highlight`, `picked`).
- **Center: Game.** The iframe at its aspect ratio. A small overlay shows the frame, paused state and hot-reload
  toasts ("AI changed scenes/main.scene.json: state kept at 12.4 s").
- **Right: Inspector.** The selected entity's components, collapsible, values live, numbers rounded, the raw
  JSON on demand.
- **Bottom, tabs:**
  - *Activity*: a timeline of file changes from `/events`, each with its diff (syntax colored), the hot
    result, and "open file" when `window.studio` is available.
  - *Problems*: `check` diagnostics with their `fix`.
  - *Tests*: `test` results, with rerun.
  - *Review*: findings grouped by area and level.
  - *Console*: game events and errors.
- Panels can be resized and the split is remembered (localStorage). Shortcuts: F5 play/pause, F10 step,
  Ctrl+R restart, Ctrl+Shift+C check, Ctrl+Shift+T test.
- After each `change`, run `check` on its own (debounced) so Problems is always current. `test` and `review` run
  only on demand.

Tech: TypeScript, compiled by `tsc` to ES modules that the page loads directly (no bundler), and no runtime
dependencies unless one is clearly worth it. Must work in Chromium (Electron) at 1280×720 and up.

## Shell (shell part)

- `packages/studio` is `@ludra/studio`, version 0.97.0, with Electron as a dependency. `@ludra/cli` doesn't
  depend on it. `ludra studio` finds it if it's installed, and otherwise says how to install it.
- In the main process: start the server, open the window, a native menu (File: Open project…, Recent; Game:
  Play/Pause, Step, Restart; View; Help), remember window size and recent projects, and stop the child process
  on quit.
- Preload, `window.studio`: `{ version, platform, project: { dir }, openProject(), openRecent(dir), reveal(path), openInEditor(path), onMenu(cb) }`.
  `onMenu` passes menu commands (`"play"`, `"step"`, `"restart"`, `"check"`, ...) to the UI.

## Edits: server and inspector (v0.99, part A of docs/editor.md)

What `feat/editor-edits` built, where `docs/editor.md` leaves room. Parts B and C can rely on these:

- **The file is printed the way it was written.** `packages/cli/src/scene-edit.ts` parses the file keeping where
  each value is, applies the edits to the JSON, and prints the result by copying every value the edits didn't
  change byte for byte from the old text: key order (integer-like keys too), indentation (spaces or tabs), CRLF,
  objects and arrays the agent wrote on one line, and number spelling (`1.50` stays `1.50`). A changed object
  keeps its layout (one line stays one line); a new entity is printed like `JSON.stringify(…, null, 2)` at its
  depth. So moving an entity is a one-line diff. A trailing newline is kept, or added.
- **`version`** is the first 16 hex digits of the SHA-1 of the file's text, for `GET /__ludra/file` and
  `POST /__ludra/edit` alike. `/__ludra/file` reads only text files inside the project (not in `node_modules`,
  `build`, `.git` …): 404 otherwise.
- **`/__ludra/edit` answers:** `400 { error }` for a bad edit, a path that isn't one of the project's scenes, or a
  body that isn't a JSON object. Several edits that fail name the one: `edits[1]: There is no entity "x"…`.
  An id that a tilemap makes (`<tilemap>-<row>-<col>`) says to edit that tilemap. `409 { error, version }` when
  stale. `422 { error, diagnostics }` lists only the errors the edit would **add** (by code and message), so a
  scene that already has an error can still be edited; each diagnostic carries `file`. `200 { ok, version,
  diagnostics }` lists the result's warnings. An edit that changes nothing writes nothing.
- **`set`** makes the objects on its path (an override of a prefab's component on an entity that only had
  `transform`), takes list indexes (`components.dialogue.lines.2`), and without `value` removes the field.
  `value: null` is written as `null` (on a component it drops the prefab's). `__proto__`, `constructor` and
  `prototype` are refused anywhere in a path or a value. Renaming (`field: "id"`) doesn't rewrite references to
  the old id in other entities or scripts: check reports those.
- **Undo and redo** hold Studio's last 200 writes (edits and palette adds), across all scenes, newest last. Each
  remembers the file's text before and after: undo needs the file to be exactly as that write left it, redo as
  it was before, else 409. A new edit clears redo. The history lives in the `ludra dev` process.
- **`by: "studio"`** comes from the server remembering what it wrote and what the file read as right after. When
  the watcher reports the file with that content, the change is Studio's (with `label`; undo and redo are
  labelled "Undo <label>" / "Redo <label>"). Studio's files and other files changed in the same 100 ms go out as
  two `change` messages. Every other change says `by: "files"`.
- **`/__ludra/run` `add`** takes exactly `[block, "--at", "x,y"]` and optionally `"--id", name` (a known block,
  numbers, a plain id): anything else is 400. It runs `ludra add` on the **entry scene** (that's what `ludra add`
  does), and is an undoable Studio write labelled "Added <block>"; the files it copies are attributed to Studio
  too. Undo takes the entities out, not the copied files.
- **`/__ludra/project`** also has `components`: the component schema, as `ludra components --json` gives it
  without `effects` (`ProjectInfo.components` in `protocol.ts`). `prefabs` are the names of `prefabs/*.prefab.json`.

The inspector (`packages/studio/ui/src/panels/inspector.ts`, with `scene-doc.ts` holding the running scene's file):

- It reads the scene the game reports in `ready` with `/__ludra/file`, and again on every `change` to it (or
  to a prefab its entities use). Studio keeps nothing else.
- An entity in the file shows every field of its components' schema: the file's value in an input, the default
  as a placeholder, and in green beside it the live value when the game has moved away from the file (a moving
  body). In 2D, 3D-only fields show only when the file sets them. Components the game added while playing show
  as "live only", read-only.
- Enter, or leaving the field, writes it; Esc puts it back. Dragging a number field's name sideways scrubs it
  (Shift for fine steps, Esc cancels) and writes once, on release. Booleans, enums and colors write at once.
  Lists and objects are typed as JSON. An empty field removes the value from the file (so the default or the
  prefab's applies); so does the ↺ button on a field the file sets.
- Values from the prefab are in italics; a value the entity overrides has a blue bar, and ↺ takes it back to
  the prefab's. Removing a prefab's component writes `null` for it. "Add component…" lists the schema's
  components the entity doesn't have, and fills their required fields with a start value.
- Clicking the id renames it (a taken id is refused before it's sent); the selection follows the new id.
- A `422` shows each diagnostic under its field, with its `fix`, and keeps what was typed; diagnostics about
  another entity or the scene go on top. A `409` says the agent changed the scene, reads it again and shows
  it as it is now; the edit isn't retried.
- Entities the file doesn't hold are read-only, with why: a tilemap cell (with a link to select the tilemap)
  or an entity made while playing.
- Keys typed in the inspector don't reach the viewport's shortcuts (Delete, Ctrl+Z).
- The mock (`?mock=1`) serves a copy of the real schema for some components (`src/mock/components.ts`).
