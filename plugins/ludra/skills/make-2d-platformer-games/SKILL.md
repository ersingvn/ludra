---
name: make-2d-platformer-games
description: Make beautiful 2D games of any genre: platformers, top-down adventures and arena games, breakout and other bouncing-ball games, with levels, coins, enemies, hazards, moving platforms, bounce physics, custom game logic in scripts (chasing enemies, keys and doors, timers, shooting, bosses), sprites, animations, particles, sound, code-drawn art and lighting, custom HUDs, fonts and post-processing shaders. Use whenever the user asks to make, build, change, fix, test or polish a game, or works in a project with a ludra.json. Builds with the Ludra engine proves the game works by play-testing it headlessly, and reviews it for anything that makes it feel unfinished.
---

# Building games with Ludra

Ludra is a game engine designed for agents. A game is plain JSON (scenes made of entities and components) and every step has a command whose output you can read: validate, simulate, look at a frame, run tests. Use them. Never guess whether a game works.

Working is the floor, not the goal. **Before designing a game, read `DESIGN.md` in this skill's folder.** It covers level design, fairness checks, game feel, art direction and palettes, and a checklist to finish with.

## Start

Commands below use `npx @ludra/cli`, which downloads the CLI from npm on first use; its command is `ludra`. Always write the full `@ludra/cli`: a bare `npx ludra` would fetch an unrelated package. Inside a clone of the Ludra repository itself (its root `package.json` is named `ludra-monorepo`), use `npm run ludra -- <command>` from the repo root instead. Ludra needs Node.js 22.18 or newer; if `npx` fails, tell the user and point them to https://github.com/ersingvn/ludra.

- New game: `npx @ludra/cli new <folder> --template <name>`, then work inside that folder. Pick the template closest to the genre and reshape it:
  - `platformer` (default): side view, gravity, running and jumping.
  - `topdown`: seen from above, no gravity, the hero moves in 8 directions through a maze of walls.
  - `breakout`: a paddle, a bouncing ball and bricks, all game rules in scripts.

  For other genres, start from the nearest one: a shmup or Pong is `breakout`'s paddle and bounce; a dungeon crawler, twin-stick or snake-like game is `topdown`; an auto-runner or one-button game is `platformer`.
- Existing game: read `ludra.json`, the entry scene and `tests/` first.
- Component reference: `npx @ludra/cli components` (or `npx @ludra/cli components <name>`). It is generated from the engine, so it is always current. Trust it over memory.
- **Blocks:** `npx @ludra/cli blocks` lists ready-made, tested gameplay pieces (jump pads, keys and doors, chasing and patrolling enemies, turrets, falling and moving platforms, teleporters, coins, spikes, time limits). `npx @ludra/cli add <block> --at x,y` copies its scripts and art into the project and places its entities, with `y` being the top of the surface it sits on. Prefer blocks over writing the same thing from scratch, then customize their `params`, art and combinations. Each block prints how to tune it.

## The loop

Repeat until the game does what the user asked:

1. **Edit** the scene JSON.
2. **Check**: `npx @ludra/cli check` validates every scene. Fix every error before doing anything else. Each diagnostic gives the JSON path and a `fix:` line. Apply it.
3. **Play**: `npx @ludra/cli play --inputs "<script>" --ascii`. Read the timeline (position, velocity, grounded per sample), the events (jump, land, collect, stomp, die, win, bounce, checkpoint, gameover, goto) and the ASCII map of the final frame. `--scene scenes/level-2.scene.json` plays another scene. Use `--watch player,lift,enemy` to time moving things, `--every 0.1s` for finer timing and `--columns 160` for wide worlds.
4. **Look**: add `--screenshot 1s,end` (any times, or `end`) to `play` to render real frames as PNGs into `screenshots/`, then open them with your image-reading tool. The ASCII map shows layout; screenshots show what players see: art, animation, particles, overlaps, readability. Do this after every visual change. It needs Chrome, Edge or Chromium installed; if none is found, say so and rely on the ASCII map.
5. **Test**: encode the requirement in `tests/<name>.test.json` and run `npx @ludra/cli test`.
6. **Review**: `npx @ludra/cli review` lists what makes a game feel unfinished: untested mechanics, events nothing answers, the default HUD, a flat backdrop, plain shapes. Fix every issue (✗) and consider the ideas (○). A game with review issues is not done, even if its tests pass.
7. **Hand off**: tell the user to run `npx @ludra/cli dev` to play it.

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

- Subjects: `score`, `deaths`, `won`, `lost`, `lives`, `events.<name>` (count so far: jump, land, collect, stomp, die, win, bounce, checkpoint, gameover, goto, or a custom script event), `<entityId>.x|y|vx|vy|grounded|exists`, `<entityId>.state.<key>`.
- A test runs the entry scene unless it says `"scene": "scenes/level-2.scene.json"`.
- `at` defaults to `end`. The run lasts the input script plus 1s unless `duration` is set.

Write at least one test proving the level can be completed: `"won == true"` and `"deaths == 0"`. If you cannot find an input script that completes it, the level is probably impossible. Fix the level, not the test.

### Finding a winning input script

Build it section by section. Get past one obstacle, print the timeline to see where the player is and when, then extend the script. Moving things are deterministic, so you can compute where a lift or enemy will be. To try several timings, loop in the shell and grep the events:

```bash
for w in 0.4s 0.5s 0.6s; do npx @ludra/cli play --inputs "<prefix>, wait:$w, right+jump:0.45s" | grep -E "stomp|die|win"; done
```

Prefer routes with some slack: if only one exact timing works, a human will find the level frustrating. Widen the platform or slow the enemy.

When a route is long or reactive (a breakout level, an arena), write a small autopilot instead of guessing: a Node script that creates `new World(scene, { scripts })` from `@ludra/core`, picks the input each frame from the world state (steer the paddle under the ball, walk toward the next gem), calls `world.step(new Set([...]))`, and prints the inputs compressed into segments with frame counts (`"left:24f, wait:71f"`). Paste that into the test. Keep the autopilot out of the project.

## Genres

### Platformer

The player has a `platformer` component and a `dynamic` body; gravity pulls everything down. See the building blocks and level numbers below.

### Top-down

- Set `"gravity": 0` on the world. The hero has `topdown` (`speed`, `directions`) and a `dynamic` body. `directions` is `"8"` (default), `"4"` (no diagonals), `"x"` or `"y"`.
- Arrow keys move it: `"right+up:0.5s"` goes diagonally. Walls are `static` bodies; `clampToWorld` (default true) keeps the hero on screen.
- Enemies are `patrol` + `hazard` on kinematic sensors, on either axis. They can't be stomped. Make them cross the hero's path so passing them takes timing, then sweep `wait:` values to prove the window is wide.
- A floor is an entity with only a tiled `sprite` on `layer` -1, sized to the world.

### Bouncing balls (breakout, Pong, pinball-like)

- `body.bounce` is how much speed a dynamic body keeps when it hits a solid: `1` reflects it perfectly, `0.5` loses half each hit, `0` (default) stops it. Each hit emits a `bounce` event (good for a `blip` sound).
- A ball is `dynamic`, `"bounce": 1`, `"gravityScale": 0`. Keep its speed constant in a script and never let it travel almost horizontally.
- A paddle is `kinematic` with `topdown` `"directions": "x"`: player-steered kinematic bodies stop at walls, and the ball rebounds off them. Aim the ball in the paddle's `touch` script by where it hit.
- Bricks are `static` bodies with a script that scores and destroys itself on `touch`. Leave the bottom of the world open and treat a lost ball as a death (`world.kill(paddle)`).
- With gravity on and `bounce` below 1 you get bouncy balls, rubber enemies and grenades.

## Game structure: lives, checkpoints, prefabs, scenes

- **Lives**: `"world": { "lives": 3 }`. Each death costs one; the last ends the game (`lost`, a `gameover` event, the simulation stops). Leave it out for unlimited retries. Scripts read and write `world.lives` (an extra life) and call `world.lose()` (a time limit ran out).
- **Checkpoints**: a sensor body with `checkpoint: {}`. The first touch makes it the player's respawn point (standing on its bottom edge) and fires `checkpoint` once. Put them before hard parts, where the player naturally stands, and light them up when reached (`ctx.recent("checkpoint", 1e9)`; the event's `data.checkpoint` is its id).
- **Prefabs**: `prefabs/<name>.prefab.json` holds `{ "components": { ... } }`. An entity uses one with `"prefab": "slime"` and only the components that differ: `"components": { "transform": { "x": 400, "y": 487 }, "patrol": { "speed": 120 } }` (merged field by field; `null` removes a component). Scripts spawn them: `world.spawn({ prefab: "bullet", components: { transform: { x, y } } })`. Use prefabs for anything placed more than once, so a change to the slime changes every slime.
- **Scenes**: more scenes live in `scenes/`. A goal's `"next": "scenes/level-2.scene.json"` moves on after the win screen; `world.goto("scenes/level-1.scene.json")` moves on from anything (a title screen, a door). Score, deaths and lives carry over; R restarts the current scene, and after game over the whole run. Each scene is checked by `check` and tested on its own (`"scene"` in a test); `world.exit` tells draw hooks whether a win leads on.

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

### No limits: draw hooks, fonts and shaders

Sprites and effects are the floor. For real art, paint with code; read "Paint with code" in `DESIGN.md` for what to do with it.

- **`draw(ctx)`** in any script paints that entity every rendered frame, in world coordinates, after its sprite (or instead of one).
  - `ctx.g` is the real `CanvasRenderingContext2D`: gradients, `shadowBlur` glow, `globalCompositeOperation = "lighter"` for light, paths, `roundRect`, text, `filter`, `drawImage`. Anything the canvas can do.
  - Draw order follows `sprite.layer` (0 without a sprite), then entity order. A backdrop is an entity with only a draw hook, first in the list.
- **`drawUI(ctx)`** paints in screen space above the world. If any script has it, the default HUD and "Level complete" screen disappear and the game draws its own: score, meters, title card, win screen (`world.won`, `world.deaths`, `world.score`).
- **Draw helpers on `ctx`:**
  - `time` (animate with it), `local` (per-entity memory for trails and tweens), `view` (size and camera), `recent(name?, seconds)` (events to flash or pop text on; custom event `data` included).
  - `image(path)` (may be undefined, so check it), `burst(x, y, particles)`, `shake(px)`, `random()`.
- **Draw hooks only paint.** `self` and `world` are read-only there: setting `x`, `score`, `state`, or calling `emit`, `spawn` or `world.random` throws, so the browser can never drift from what tests verified. Do game logic in `update`/`touch`, and `world.emit("name", data)` there for the visuals to react to.
- **Fonts:** `"fonts": { "Orbitron": "google" }` in the scene (or a `.woff2` in `assets/`), then `g.font = "900 32px Orbitron, sans-serif"`.
- **Post-processing:** `"postfx": { "shader": "shaders/x.frag", "uniforms": { "bloom": 1.5 } }`.
  - It runs a GLSL ES 1.0 fragment shader over every frame. The engine declares `u_image`, `u_resolution`, `u_time`, `v_uv` and each uniform as a `float`; write `void main()` and set `gl_FragColor`.
  - Bloom, CRT scanlines, chromatic aberration, color grading, vignette, pixelation, water ripples: whatever the mood needs. Compile errors appear in the game and in `play --screenshot` with the line number.
- `ludra check` runs every draw hook against a mock canvas, so typos and accidental game changes show up as `E_DRAW_HOOK` before the browser. Then look at real frames with `play --screenshot`: that is the only way to judge how it looks.

See `scripts/` and `shaders/` in the `breakout` (everything drawn in code) and `topdown` (lighting over SVG sprites) templates.
