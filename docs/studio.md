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
