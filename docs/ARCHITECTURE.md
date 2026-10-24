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
| `particles.ts` | Seeded, visual-only particle system for effect bursts and `emitter`s. |
| `audio.ts` | Web Audio sound player: synthesized presets plus audio files. |

`browser.ts` is a separate entry point (`@ludra/core/browser`) so Node code never loads DOM code.

### Scripts

`script.ts` defines the API scripts see (`Script`, `ScriptContext`, `ScriptEntity`, `ScriptWorld`) and `ScriptError`. Core never imports script files itself. Hosts load them and pass the modules in, with `new World(scene, { scripts })`:

- **CLI:** `loadGame` in `project.ts` imports each script with Node's built-in type stripping. It loads every file the scene references plus all of `scripts/`, so `world.spawn` can attach any of them, and turns load problems (syntax errors with line and caret, forbidden imports, misspelled hooks) into diagnostics.
- **Browser:** the server serves those same files type-stripped at `/__ludra/script/`, and `startGame` and `captureFrames` import them.

In a frame, scripts run after platformer input and before patrols and physics (`start` once, then `update`). `touch` runs after physics, for bodies that started overlapping or touching within 1px. Scripts see entities through stable handles whose setters write straight to the entity. Per-entity data lives in `entity.state`, which snapshots copy, so tests can assert on it. `world.random()` is seeded by `world.seed`, which keeps scripted runs deterministic as long as scripts avoid `Math.random` and `Date`, as the skill instructs. Hook errors are rethrown as `ScriptError` with file, entity, hook and frame; `runTest` turns them into a failed test.

### Presentation is a one-way street

Everything visual or audible reads from the `World` and never writes to it. Effects react to `world.events` (which carry the position where they happened), animations derive from velocity and `grounded`, and particles use their own seeded random numbers. So adding art or effects can never change what `ludra test` verifies, and a test asserts exactly this.

### `ludra` (CLI)

The CLI is a thin layer over core: project loading (`ludra.json`), output formatting (`--json` everywhere), templates and the dev server. `ludra check` adds file-system checks core can't do, such as `E_ASSET_MISSING`.

`server.ts` serves a project to a browser: the engine's browser module (type-stripped on the fly when running from source; no bundler), the validated scene, and only media files from the project. `ludra dev` puts a game page in front of it and reloads when the scene or any asset changes.

### Blocks

`blocks.ts` reads the library in `packages/cli/blocks/` (shipped in the npm package). `placeBlock` turns a block's entity templates into entities: transforms are offsets from the `--at` anchor, `{id}` is replaced by a prefix that doesn't clash with the scene (`turret`, `turret-2`…), so linked parts (a key and its door) find each other. `addBlock` copies the block's files without overwriting ones the user changed (unless `--force`), appends the entities and merges only effects the scene lacks. The block test places every block in its `demo.json` level with that same code and runs the demo tests, so the library is verified on every commit.

### Screenshots

`ludra play --screenshot` starts that server on a random port, launches the Chrome, Edge or Chromium already installed in headless mode (`headless.ts` finds it, or uses `LUDRA_BROWSER`), and drives it over the DevTools protocol with Node's built-in WebSocket. The page calls core's `captureFrames`, which steps a `World` and the same view as `startGame` frame by frame with no clock, so a given frame always renders the same. PNGs come back as data URLs and are written to `screenshots/`. No npm dependencies are involved, and the browser and its temporary profile are removed afterwards. In development it type-strips the engine's TypeScript on request, and in a published install it serves the compiled JavaScript.

## Determinism

- Fixed timestep (`FIXED_DT = 1/60`). The browser uses an accumulator to run whole steps.
- No `Math.random` and no `Date.now` in the simulation.
- Input is a set of held actions per step. "Pressed" is derived from the previous step's set, so scripts and keyboards behave identically.

## Physics (v0.1)

Axis-aligned boxes. Dynamic bodies integrate gravity, then move and resolve along x, then along y, against static and kinematic solids. This is simple on purpose. It is predictable, easy to explain to an agent, and easy to replace with a full physics engine (for example Rapier) behind the same component interface later.

## Development

```bash
npm install
npm test           # node --test, runs TypeScript directly
npm run build      # tsc -b, type-checks and emits dist/
npm run ludra -- <command>
```

The `ludra-dev` export condition points package imports at `src/*.ts`, so Node (22.18 and newer) runs the TypeScript sources without a build step.
