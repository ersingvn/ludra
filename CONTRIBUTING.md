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
6. Add tests in `packages/core/test/`, and update `plugins/ludra/skills/ludra/SKILL.md` if agents need to know new rules.

## Pull requests

- Keep PRs focused. Include tests.
- `npm test` and `npm run build` must pass.
