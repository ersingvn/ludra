# Contributing to Ludra

Thanks for helping build the game engine for AI agents.

## Setup

```bash
npm install
npm test
npm run build
```

## Principles

1. **Every feature must be checkable from text.** If an agent can't verify it with `check`, `play` or `test`, it isn't done.
2. **Errors are instructions.** A diagnostic names the JSON path and a fix an agent can apply without guessing.
3. **Deterministic always.** Same scene + same inputs = same result. No randomness or wall-clock time in the simulation.
4. **One source of truth.** Component fields live only in `packages/core/src/components.ts`.

## Adding a component

1. Add its spec to `COMPONENTS` in `components.ts`: description, `requires` and fields with defaults.
2. Add its resolved type and wire it into `createEntity` in `world.ts`.
3. Implement its behavior as a system in `World.step`.
4. Add any cross-component validation rules to `validate.ts`, each with a `fix`.
5. Draw it in `ascii.ts` (and `browser.ts` if it has visuals).
6. Add tests in `packages/core/test/`, and update `plugins/ludra/skills/make-2d-platformer-games/SKILL.md` if agents need to know new rules.

## Adding a block

Blocks are the easiest way to contribute gameplay. A block lives in `packages/cli/blocks/<name>/`:

- `block.json`: `name`, `description`, `tags`, `usage` (what `--at` means and how to tune it), `entities` (with `transform: { dx, dy }` offsets from the anchor, where the anchor's y is the top of the surface), `files` (copied into projects at the same path) and optional `effects`. Use `{id}` in strings so several copies can coexist and parts can find each other.
- `scripts/` and `assets/`: what the block needs. Draw art as SVG, following the style of the existing blocks.
- `demo.json`: an anchor (`at`) in a plain test level (ground top at y 500, player at (100, 482), walls at the edges) and tests that prove the block works. Isolate each behavior in its own test. `playerAt` per test moves the player.

`npm test` places every block in its demo level and runs its tests, so a block that stops working fails CI.

## Pull requests

- Keep PRs focused. Include tests.
- `npm test` and `npm run build` must pass.
