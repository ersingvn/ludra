---
name: ludra
description: Build, debug and test 2D games with the Ludra engine. Use when the user asks to make, change or fix a game (platformer, level, player movement, coins, enemies) in a project that has a ludra.json, or asks to start a new game with Ludra.
---

# Building games with Ludra

Ludra is a game engine designed for agents. A game is plain JSON (scenes made of entities and components) and every step has a command whose output you can read: validate, simulate, look at a frame, run tests. Use them. Never guess whether a game works.

## Start

- New game: `npx ludra new <folder>` (template `platformer`), then work inside that folder.
- Existing game: read `ludra.json`, the entry scene and `tests/` first.
- Component reference: `npx ludra components` (or `npx ludra components <name>`). It is generated from the engine, so it is always current. Trust it over memory.

## The loop

Repeat until the game does what the user asked:

1. **Edit** the scene JSON.
2. **Check**: `npx ludra check`. Fix every error before doing anything else. Each diagnostic gives the JSON path and a `fix:` line. Apply it.
3. **Play**: `npx ludra play --inputs "<script>" --ascii`. Read the timeline (position, velocity, grounded per sample), the events (jump, land, collect) and the ASCII map of the final frame. Use `--watch <ids>` for other entities and `--every 0.1s` for finer timing.
4. **Test**: encode the requirement in `tests/<name>.test.json` and run `npx ludra test`.
5. **Hand off**: tell the user to run `npx ludra dev` to play it.

## Input scripts

Comma-separated segments that run back to back: `action[+action]:duration`.

- Actions: `left right up down jump action`, plus `wait` for no input.
- Durations: `1s`, `250ms`, `30f` (frames at 60 fps). No duration = 0.1s tap.
- `jump` triggers only on a new press. Put `wait:0.1s` between two jump segments.
- Holding jump longer gives a higher jump (until the apex), because `variableJump` cuts it short on release.

Example: `"right:0.55s, right+jump:0.45s, right:0.45s, right+jump:0.45s"`

## Tests

```json
{
  "tests": [
    {
      "name": "the level can be completed",
      "inputs": "right:0.55s, right+jump:0.45s, right:0.45s",
      "duration": "3s",
      "assert": ["score == 1", "player.grounded == true at end", "coin-1.exists == false"]
    }
  ]
}
```

Assertions: `<subject> <op> <value> [at <time|end>]`, with op one of `< <= > >= == !=`.

- Subjects: `score`, `events.jump|land|collect` (count so far), `<entityId>.x|y|vx|vy|grounded|exists`.
- `at` defaults to `end`. The run lasts the input script plus 1s unless `duration` is set.

Write at least one test proving the level can be completed. If you cannot find an input script that completes it, the level is probably impossible. Fix the level, not the test.

## Level design numbers

- Coordinates are entity centers in pixels; +y is down. The world defaults to 960x540.
- An entity resting on a surface has `y = surfaceTop - height / 2`.
- Jump height = `jumpSpeed² / (2 · gravity)`. Defaults 680 and 1800 give about 128px, so keep platform rises at or below about 100px.
- Horizontal reach of a full jump ≈ `speed · 2 · jumpSpeed / gravity` (about 180px with the defaults).
- Collectibles need `"sensor": true`. Platformers need a `"dynamic"` body.
- Add static walls just outside the world edges so the player cannot leave.

## Making it look good

Use `sprite` colors with a coherent palette: a dark background, mid-tone platforms, and a bright player and pickups. Use `layer` so the player draws above everything. Keep sizes consistent, for example a 28x36 player, 20px pickups and 20px-thick platforms.
