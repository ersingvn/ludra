---
name: make-2d-platformer-games
description: Make 2D games, such as platformers with levels, coins, enemies, hazards, moving platforms, custom game logic in scripts (chasing enemies, keys and doors, timers, shooting, bosses), sprites, animations, particles and sound. Use whenever the user asks to make, build, change, fix, test or polish a game, or works in a project with a ludra.json. Builds with the Ludra engine and proves the game works by play-testing it headlessly.
---

# Building games with Ludra

Ludra is a game engine designed for agents. A game is plain JSON (scenes made of entities and components) and every step has a command whose output you can read: validate, simulate, look at a frame, run tests. Use them. Never guess whether a game works.

## Start

Commands below use `npx @ludra/cli`, which downloads the CLI from npm on first use; its command is `ludra`. Always write the full `@ludra/cli`: a bare `npx ludra` would fetch an unrelated package. Inside a clone of the Ludra repository itself (its root `package.json` is named `ludra-monorepo`), use `npm run ludra -- <command>` from the repo root instead. Ludra needs Node.js 22.18 or newer; if `npx` fails, tell the user and point them to https://github.com/ersingvn/ludra.

- New game: `npx @ludra/cli new <folder>` (template `platformer`), then work inside that folder.
- Existing game: read `ludra.json`, the entry scene and `tests/` first.
- Component reference: `npx @ludra/cli components` (or `npx @ludra/cli components <name>`). It is generated from the engine, so it is always current. Trust it over memory.

## The loop

Repeat until the game does what the user asked:

1. **Edit** the scene JSON.
2. **Check**: `npx @ludra/cli check`. Fix every error before doing anything else. Each diagnostic gives the JSON path and a `fix:` line. Apply it.
3. **Play**: `npx @ludra/cli play --inputs "<script>" --ascii`. Read the timeline (position, velocity, grounded per sample), the events (jump, land, collect, stomp, die, win) and the ASCII map of the final frame. Use `--watch player,lift,enemy` to time moving things, `--every 0.1s` for finer timing and `--columns 160` for wide worlds.
4. **Look**: add `--screenshot 1s,end` (any times, or `end`) to `play` to render real frames as PNGs into `screenshots/`, then open them with your image-reading tool. The ASCII map shows layout; screenshots show what players see: art, animation, particles, overlaps, readability. Do this after every visual change. It needs Chrome, Edge or Chromium installed; if none is found, say so and rely on the ASCII map.
5. **Test**: encode the requirement in `tests/<name>.test.json` and run `npx @ludra/cli test`.
6. **Hand off**: tell the user to run `npx @ludra/cli dev` to play it.

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
for w in 0.4s 0.5s 0.6s; do npx @ludra/cli play --inputs "<prefix>, wait:$w, right+jump:0.45s" | grep -E "stomp|die|win"; done
```

Prefer routes with some slack: if only one exact timing works, a human will find the level frustrating. Widen the platform or slow the enemy.

## Gameplay building blocks

- **Hazard** (spikes, lava): sensor body + `hazard`. Touching it kills the player, who respawns at its start position. Collected items stay collected.
- **Enemy**: kinematic sensor body + `patrol` + `hazard`. Add `"stompable": true` so landing on it from above destroys it and bounces the player.
- **Moving platform**: kinematic solid body + `patrol`. It carries players standing on it. `patrol` runs from the start position to `distance` px along +x (or +y) and back.
- **Pit**: a gap in the ground. Falling more than 100px below the world kills the player.
- **Goal**: sensor body + `goal`. Use `requireScore` to make collecting things mandatory. `ludra check` errors if the scene cannot offer enough points.
- Make the world wider than the window (for example `"width": 1920`) and the camera scrolls with the player.

## Scripts: custom game logic

When no built-in component does what the user wants (an enemy that chases, a door that needs a key, a timer, shooting, a boss with phases, a switch, a jump pad), write a script. Prefer built-ins when they fit; they are already tested.

1. Run `npx @ludra/cli components script` for the full API. It is generated from the engine.
2. Write `scripts/<name>.ts`:

   ```ts
   import type { Script } from "@ludra/core";

   /** Runs toward the player once they come within params.range px. */
   export default {
     update({ self, world, params }) {
       const player = world.player();
       const distance = player ? player.x - self.x : Infinity;
       self.state.chasing = Math.abs(distance) < (params.range as number);
       self.vx = self.state.chasing ? Math.sign(distance) * (params.speed as number) : 0;
     },
   } satisfies Script;
   ```

3. Attach it: `"script": { "src": "scripts/chase.ts", "params": { "speed": 70, "range": 220 } }`. Give scripted movers a body (`kinematic` for things that move on their own).
4. Run `check`: it loads every script and reports syntax errors with the line and a caret, forbidden imports, and misspelled hooks.
5. Prove the behavior in tests. Scripts expose what they do through `self.state` and `world.emit`:
   - `"chaser.state.chasing == true"`, `"boss.state.phase == \"angry\""`
   - `"events.door-open == 1"` for `world.emit("door-open")`
   - plus everything else: `won`, `deaths`, `<id>.exists`, positions.

Rules:
- Only `import type` is allowed. Put helpers in the same file.
- Use `world.random()` (seeded) instead of `Math.random()`, and `world.time` instead of `Date`, so tests stay deterministic.
- Keep data in `self.state` (or another entity's `state`, e.g. `player.state.hasKey`), not in module variables: module variables are shared by every entity using the script and survive restarts.
- `touch` fires once when touching starts, including solids that only touch. For "while touching", use `self.touches(other)` in `update`.
- Custom event names can drive `effects` too: `"effects": { "door-open": { "sound": "explosion", "shake": 6 } }`.
- Scripts in `scripts/` load even if nothing uses them, so `world.spawn({ components: { ..., script: { src: "scripts/bullet.ts" } } })` works.
- A script error names the file, entity, hook and frame. Fix the script and rerun.

See `examples/key-quest` in the Ludra repo for a jump pad, a key, a locked door, a chasing enemy and a time limit, all with tests.

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

`ludra check` fails with `E_ASSET_MISSING` (and lists what does exist) if a referenced file is missing, so run it after adding art. Then take screenshots and look at them: check that sprites face the right way, sit on the ground instead of floating or sinking, tiles line up, and the player stands out from the background.

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

Run `npx @ludra/cli components effects` for every field.

### Layout and color

Use a coherent palette: a dark background, mid-tone platforms, a bright player and pickups, and a warning color (red, magenta) for anything that kills. Use `layer` so the player draws above everything. Keep sizes consistent, for example a 28x36 player, 20px pickups and 20px-thick platforms.
