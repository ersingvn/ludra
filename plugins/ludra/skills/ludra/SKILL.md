---
name: ludra
description: Build, debug, test and polish 2D games with the Ludra engine. Use when the user asks to make, change or fix a game (platformer, level, player movement, coins, enemies, hazards, moving platforms, goals, sprites, animations, particles, sound) in a project that has a ludra.json, or asks to start a new game with Ludra.
---

# Building games with Ludra

Ludra is a game engine designed for agents. A game is plain JSON (scenes made of entities and components) and every step has a command whose output you can read: validate, simulate, look at a frame, run tests. Use them. Never guess whether a game works.

## Start

Commands below use `npx ludra`. Inside a clone of the Ludra repository itself (its root `package.json` is named `ludra-monorepo`), use `npm run ludra -- <command>` from the repo root instead. If `npx ludra` cannot find the package, tell the user it requires Node.js 22.18+ and the `ludra` npm package, and point them to https://github.com/ersingvn/ludra.

- New game: `npx ludra new <folder>` (template `platformer`), then work inside that folder.
- Existing game: read `ludra.json`, the entry scene and `tests/` first.
- Component reference: `npx ludra components` (or `npx ludra components <name>`). It is generated from the engine, so it is always current. Trust it over memory.

## The loop

Repeat until the game does what the user asked:

1. **Edit** the scene JSON.
2. **Check**: `npx ludra check`. Fix every error before doing anything else. Each diagnostic gives the JSON path and a `fix:` line. Apply it.
3. **Play**: `npx ludra play --inputs "<script>" --ascii`. Read the timeline (position, velocity, grounded per sample), the events (jump, land, collect, stomp, die, win) and the ASCII map of the final frame. Use `--watch player,lift,enemy` to time moving things, `--every 0.1s` for finer timing and `--columns 160` for wide worlds.
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

- Subjects: `score`, `deaths`, `won`, `events.jump|land|collect|stomp|die|win` (count so far), `<entityId>.x|y|vx|vy|grounded|exists`.
- `at` defaults to `end`. The run lasts the input script plus 1s unless `duration` is set.

Write at least one test proving the level can be completed: `"won == true"` and `"deaths == 0"`. If you cannot find an input script that completes it, the level is probably impossible. Fix the level, not the test.

### Finding a winning input script

Build it section by section. Get past one obstacle, print the timeline to see where the player is and when, then extend the script. Moving things are deterministic, so you can compute where a lift or enemy will be. To try several timings, loop in the shell and grep the events:

```bash
for w in 0.4s 0.5s 0.6s; do npx ludra play --inputs "<prefix>, wait:$w, right+jump:0.45s" | grep -E "stomp|die|win"; done
```

Prefer routes with some slack: if only one exact timing works, a human will find the level frustrating. Widen the platform or slow the enemy.

## Gameplay building blocks

- **Hazard** (spikes, lava): sensor body + `hazard`. Touching it kills the player, who respawns at its start position. Collected items stay collected.
- **Enemy**: kinematic sensor body + `patrol` + `hazard`. Add `"stompable": true` so landing on it from above destroys it and bounces the player.
- **Moving platform**: kinematic solid body + `patrol`. It carries players standing on it. `patrol` runs from the start position to `distance` px along +x (or +y) and back.
- **Pit**: a gap in the ground. Falling more than 100px below the world kills the player.
- **Goal**: sensor body + `goal`. Use `requireScore` to make collecting things mandatory. `ludra check` errors if the scene cannot offer enough points.
- Make the world wider than the window (for example `"width": 1920`) and the camera scrolls with the player.

## Level design numbers

- Coordinates are entity centers in pixels; +y is down. The world defaults to 960x540.
- An entity resting on a surface has `y = surfaceTop - height / 2`.
- Jump height = `jumpSpeed² / (2 · gravity)`. Defaults 680 and 1800 give about 128px, so keep platform rises at or below about 100px.
- Horizontal reach of a full jump ≈ `speed · 2 · jumpSpeed / gravity` (about 180px with the defaults).
- Collectibles, hazards and goals need `"sensor": true`. Platformers need a `"dynamic"` body. Patrols need a `"kinematic"` body.
- Add static walls just outside the world edges so the player cannot leave.

## Making it look good

Get the level playable with colored shapes first, then dress it. Images, effects and emitters are presentation only: they never change the simulation, so tests that passed keep passing.

### Art: write SVG

You can't draw with a mouse, but you can write SVG. Put files in `assets/` and point `sprite.image` at them.

- **Spritesheets** are frames side by side, left to right, each `frameWidth` x `frameHeight` (`width`/`height` on the `<svg>` must match the sheet). Draw characters facing right; `flip` mirrors them when moving left.
- **Animations**: set `idle`, `run`, `jump`, `fall` to frame lists (`"0"`, `"1-2"`, `"0,2-4"`) and `fps`. Platformers switch automatically. Other entities play `run` while moving and `idle` otherwise, so a spinning coin is `"idle": "0-3"`.
- **Tiles**: `"tile": true` repeats the image at its natural size to fill the sprite. Use it for ground, platforms and spikes instead of stretching.
- Match each frame's size to the body size so collisions match what players see. Leave a pixel or two of padding inside the frame.
- Keep `color` set even with an image: it is the fallback if the image fails to load.
- Style: chunky shapes with flat colors, a darker shade underneath, a light highlight on top, and big readable eyes. Pick one palette and reuse it.

`ludra check` fails with `E_ASSET_MISSING` (and lists what does exist) if a referenced file is missing, so run it after adding art.

### Juice: effects and emitters

Scene-level `effects` map events (`jump`, `land`, `collect`, `stomp`, `die`, `win`) to a particle burst at the event position, a `sound` and a screen `shake`:

```json
"effects": {
  "collect": { "sound": "coin", "particles": { "count": 14, "color": "#ffd166", "speed": 140, "life": 0.45 } },
  "die": { "sound": "explosion", "shake": 10, "particles": { "count": 30, "color": "#ff5d73", "speed": 220 } }
}
```

- Sounds are synthesized presets: `jump`, `coin`, `hit`, `explosion`, `powerup`, `blip`, `thud`. Use those unless the user supplies audio files (`.wav`, `.mp3`, `.ogg` paths also work).
- Particles: `direction` is degrees (-90 = up, 90 = down), `spread` is the cone width, and negative `gravity` floats up.
- An `emitter` component streams particles continuously (sparkles on a goal, torch fire, steam).
- Feedback for every player action makes a game feel good: a small dust puff on jump and land, a burst plus sound on pickups, and shake plus a big burst on death.

Run `npx ludra components effects` for every field.

### Layout and color

Use a coherent palette: a dark background, mid-tone platforms, a bright player and pickups, and a warning color (red, magenta) for anything that kills. Use `layer` so the player draws above everything. Keep sizes consistent, for example a 28x36 player, 20px pickups and 20px-thick platforms.
