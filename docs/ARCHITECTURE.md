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
| `browser.ts` | Canvas renderer and keyboard input for humans. It uses the same `World`, so tests and play match. Draws sprites, spritesheet animations and tiles, and turns world events into effects. |
| `particles.ts` | Seeded, visual-only particle system for effect bursts and `emitter`s. |
| `audio.ts` | Web Audio sound player: synthesized presets plus audio files. |

`browser.ts` is a separate entry point (`@ludra/core/browser`) so Node code never loads DOM code.

### Presentation is a one-way street

Everything visual or audible reads from the `World` and never writes to it. Effects react to `world.events` (which carry the position where they happened), animations derive from velocity and `grounded`, and particles use their own seeded random numbers. So adding art or effects can never change what `ludra test` verifies, and a test asserts exactly this.

### `ludra` (CLI)

The CLI is a thin layer over core: project loading (`ludra.json`), output formatting (`--json` everywhere), templates and the dev server. `ludra check` adds file-system checks core can't do, such as `E_ASSET_MISSING`. The dev server serves only media files from the project and reloads the page when the scene or any asset it uses changes. It has no bundler. In development it type-strips the engine's TypeScript on request, and in a published install it serves the compiled JavaScript.

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
