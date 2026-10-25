# Architecture

Ludra has one design rule: **anything a human would check by looking at the screen, an agent must be able to check from text.**

## Packages

### `@ludra/core` (zero dependencies)

| File | Responsibility |
| --- | --- |
| `components.ts` | The component table. It is the single source of truth: validation, defaults and `ludra components` are generated from it. |
| `validate.ts` | Turns raw JSON into diagnostics: code, JSON path, message and a concrete fix. Typos get "did you mean" suggestions. |
| `world.ts` | The simulation. A `World` advances only through `step(input)`, at a fixed 60 Hz, with no randomness or wall-clock time. |
| `input.ts` | Input scripts such as `"right:1s, jump:0.4s"` for headless runs. |
| `simulate.ts` | Runs a world against a script. |
| `assertions.ts` | Parses and evaluates `"<subject> <op> <value> [at <time>]"` and runs test cases. |
| `ascii.ts` | Draws a frame as text so agents can see layout and positions. |
| `effects.ts` | Scene `effects` schema, sound presets, and `collectAssetPaths` (every image and audio file a scene references). |
| `browser.ts` | Canvas renderer and keyboard input for humans. It uses the same `World`, so tests and play match. Draws sprites, spritesheet animations and tiles, and turns world events into effects. `captureFrames` runs the same view deterministically for screenshots. |
| `postfx.ts` | Runs a scene's GLSL fragment shader over each rendered frame (WebGL). |
| `drawcheck.ts` | Runs `draw`/`drawUI` hooks against a mock canvas for `ludra check`. |
| `particles.ts` | Seeded, visual-only particle system for effect bursts and `emitter`s. |
| `audio.ts` | Web Audio sound player: synthesized presets plus audio files. |

`browser.ts` is a separate entry point (`@ludra/core/browser`) so Node code never loads DOM code.

### Scripts

`script.ts` defines the API scripts see (`Script`, `ScriptContext`, `ScriptEntity`, `ScriptWorld`) and `ScriptError`. Core never imports script files itself. Hosts load them and pass the modules in, with `new World(scene, { scripts })`:

- **CLI:** `loadGame` in `project.ts` imports each script with Node's built-in type stripping. It loads every file the scene references plus all of `scripts/`, so `world.spawn` can attach any of them, and turns load problems (syntax errors with line and caret, forbidden imports, misspelled hooks) into diagnostics.
- **Browser:** the server serves those same files type-stripped at `/__ludra/script/`, and `startGame` and `captureFrames` import them.

In a frame, scripts run after player input (`platformer`, then `topdown`) and before patrols and physics (`start` once, then `update`). `touch` runs after physics, for bodies that started overlapping or touching within 1px. Scripts see entities through stable handles whose setters write straight to the entity. Per-entity data lives in `entity.state`, which snapshots copy, so tests can assert on it. `world.random()` is seeded by `world.seed`, which keeps scripted runs deterministic as long as scripts avoid `Math.random` and `Date`, as the skill instructs. Hook errors are rethrown as `ScriptError` with file, entity, hook and frame; `runTest` turns them into a failed test.

### Presentation is a one-way street

Everything visual or audible reads from the `World` and never writes to it. Effects react to `world.events` (which carry the position where they happened), animations derive from velocity and `grounded`, and particles use their own seeded random numbers. So adding art or effects can never change what `ludra test` verifies, and a test asserts exactly this.

### Drawing in code

Scripts can have `draw` (world space, ordered with sprites by `sprite.layer`) and `drawUI` (screen space) hooks, called by `View.draw` through `World.callDrawHook` with the real Canvas 2D context. While one runs, `World.drawing` is set: handle setters and mutating world methods call `guard()` and throw, and `state` is a frozen copy, so presentation can never change the simulation. Each call is wrapped in `save`/`restore`. Per-entity presentation memory (`ctx.local`) lives in the `View` and resets with it. If any entity has `drawUI`, the default HUD and win screen are skipped. `checkDrawHooks` (used by `ludra check`) runs the hooks in Node against a Proxy that accepts any canvas call, at a few frames of an idle run.

Scene `fonts` load before the game starts (Google Fonts CSS or FontFace, capped at 4 s). With `postfx`, `prepare()` compiles the shader (`postfx.ts`) on a WebGL canvas that replaces the page's canvas; the game keeps drawing into the original, now offscreen, canvas, and each frame is uploaded as a texture and drawn through the shader. Shader errors keep the 2D canvas visible and show the compiler message with the shader file's own line numbers (`#line 1` after the engine's header).

### Game structure

`validateScene` expands prefabs first: an entity with `"prefab"` gets the prefab's components with its own merged over them (`mergeComponents`, one level deep, `null` removes), so everything after it, and the `World`, only sees plain entities. The expanded scene keeps its `prefabs` map, so `world.spawn({ prefab })` works at runtime. The CLI adds `prefabs/*.prefab.json` to every scene it reads.

`World.over` (won, lost, or `exit` set) stops the simulation. Deaths cost `lives` when the scene has them; the last one sets `lost` and fires `gameover` without respawning. A checkpoint moves the player's `spawn` once per player. A goal's `next` and `world.goto` set `exit`: headless runs simply end there (each scene is tested on its own), while `startGame` with a `loadScene` option shows the win screen or fades, loads the next scene and builds a new `World` with `carry` (score, deaths, lives).

### `ludra` (CLI)

The CLI is a thin layer over core: project loading (`ludra.json`), output formatting (`--json` everywhere), templates and the dev server. `ludra check` adds file-system checks core can't do, such as `E_ASSET_MISSING`.

`server.ts` serves a project to a browser: the engine's browser module (type-stripped on the fly when running from source; no bundler), the validated scene, and only media files from the project. `ludra dev` puts a game page in front of it and reloads when the scene or any asset changes.

### Review

`commands/review.ts` loads every scene, runs every test (`runTest` reports the events each run fired) and reads the scripts' sources. It reports findings by area (proof, feel, looks, identity) as issues or ideas: no passing win test without deaths, a script with gameplay hooks whose entities and emitted events no assertion mentions, important events that fired with no `effects` entry and no `recent("…")` in a draw hook, no `drawUI`, no backdrop, sprites without art, no postfx. It's heuristic on purpose: it can't judge beauty, but it reliably catches the signs of unfinished work. `--strict` exits 1 on issues; CI runs it on the templates.

### Blocks

`blocks.ts` reads the library in `packages/cli/blocks/` (shipped in the npm package). `placeBlock` turns a block's entity templates into entities: transforms are offsets from the `--at` anchor, `{id}` is replaced by a prefix that doesn't clash with the scene (`turret`, `turret-2`…), so linked parts (a key and its door) find each other. `addBlock` copies the block's files without overwriting ones the user changed (unless `--force`), appends the entities and merges only effects the scene lacks. The block test places every block in its `demo.json` level with that same code and runs the demo tests, so the library is verified on every commit.

### Screenshots

`ludra play --screenshot` starts that server on a random port, launches the Chrome, Edge or Chromium already installed in headless mode (`headless.ts` finds it, or uses `LUDRA_BROWSER`), and drives it over the DevTools protocol with Node's built-in WebSocket. The page calls core's `captureFrames`, which steps a `World` and the same view as `startGame` frame by frame with no clock, so a given frame always renders the same. PNGs come back as data URLs and are written to `screenshots/`. No npm dependencies are involved, and the browser and its temporary profile are removed afterwards. In development it type-strips the engine's TypeScript on request, and in a published install it serves the compiled JavaScript.

## Determinism

- Fixed timestep (`FIXED_DT = 1/60`). The browser uses an accumulator to run whole steps.
- No `Math.random` and no `Date.now` in the simulation.
- Input is a set of held actions per step. "Pressed" is derived from the previous step's set, so scripts and keyboards behave identically.

## Physics

Bodies are moved by a `PhysicsEngine` (`physics.ts`): it is told about every created and removed entity, advances all bodies one fixed step, and answers overlap queries. Gameplay in `World` (platformer and top-down controls, patrols, pickups, hazards, goals, checkpoints) only talks to bodies through their velocities, `grounded`/`standingOn` and `overlaps`, so engines can be swapped without changing a game's rules. The entity's transform is the source of truth between steps, so gameplay can teleport an entity (a respawn) and the engine follows. `new World(scene, { physics })` takes any engine.

### Arcade (default, `arcade.ts`)

Axis-aligned boxes. Dynamic bodies integrate gravity, then move and resolve along x, then along y, against static and kinematic solids. Top-down movers skip gravity, and a kinematic top-down body (a paddle) is pushed out of static walls; other kinematic movers pass through. `body.bounce` reflects the velocity on the axis that hit (`-v · bounce`) and emits a `bounce` event; rebounds slower than 40 px/s stop instead, so bouncing things come to rest. This is simple on purpose: predictable, easy to explain to an agent, and tight enough for classic platformers.

### Rapier (`@ludra/physics`)

A scene opts in with `"world": { "physics": "rapier" }`. Engines are found by name in a registry (`engines.ts`, shared through `globalThis` so a second copy of the module still sees it); core only knows arcade, and `loadRapierPhysics()` from `@ludra/physics` loads Rapier's WebAssembly and registers "rapier". The CLI does that in `loadGame` when a scene asks for it, so arcade games never load Rapier.

`@ludra/physics` wraps Rapier's **deterministic** 2D build (`@dimforge/rapier2d-deterministic-compat`, pinned to an exact version): the same scene gives bit-identical frames on every OS, Node version and browser, which a golden-hash test checks on every CI machine. The "compat" build embeds the WebAssembly in one file, so it loads without a bundler. Rapier works in pixels directly (`lengthUnit` = 50 px per meter tunes its tolerances). Each step hands gameplay's changes to Rapier (a moved transform is a teleport, dynamic velocities are written, kinematic bodies move by velocity and patrol limits), steps, and reads positions, accumulated rotation (not wrapped to ±180°) and velocities back. A body is grounded when a non-sensor contact pushes it upward; sensors use Rapier's intersection test. Restitution combines with "max", so `bounce` means the same as in arcade.

## Development

```bash
npm install
npm test           # node --test, runs TypeScript directly
npm run build      # tsc -b, type-checks and emits dist/
npm run ludra -- <command>
```

The `ludra-dev` export condition points package imports at `src/*.ts`, so Node (22.18 and newer) runs the TypeScript sources without a build step.
