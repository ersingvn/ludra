# Ludra

[![CI](https://github.com/ersingvn/ludra/actions/workflows/ci.yml/badge.svg)](https://github.com/ersingvn/ludra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ludra/cli?label=%40ludra%2Fcli)](https://www.npmjs.com/package/@ludra/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**The game engine built for AI agents.**

<p align="center">
  <img src="docs/media/demo.gif" alt="A Ludra platformer: a green character collects coins, rides a moving platform over a pit, stomps a slime and reaches the goal flag" width="960">
  <br>
  <sub>The <code>platformer</code> template, replayed from its own test script: <code>won == true</code>, <code>deaths == 0</code>.</sub>
</p>

Unity, Unreal and Godot are designed for humans clicking around an editor. Ludra is designed for an agent like Claude: games are plain JSON, every problem comes with a machine-readable fix, and the agent can **play its own game headlessly** to prove it works before a human ever touches it.

You describe the game. The agent builds it with Ludra, checks it, plays it, tests it and hands it to you.

```
you    > make me a platformer with spikes, a moving platform over a pit and an enemy to stomp
claude > ludra new slime-valley
         ludra check     ✓ 15 entities, no problems
         ludra play --inputs "right:0.3s, right+jump:0.45s, ..." --watch player,lift,slime
         ludra test      ✓ 6 passed, 0 failed (won == true, deaths == 0)
         Done. Run `ludra dev` to play it.
```

> **Status:** early (v0.7). 2D games in several genres (platformers, top-down adventures, breakout), art drawn in code with lighting, custom interfaces and GLSL post-processing, a library of ready-made gameplay blocks, custom TypeScript scripts, enemies, hazards, moving platforms, goals, animated SVG sprites, particles and sound, plus the full agent toolchain including real rendered screenshots, work today. 3D is on the [roadmap](#roadmap).

## Why an engine for agents?

When an AI writes a game with a normal engine, it is coding blind. It cannot see the screen, cannot press keys, and does not find out that the player falls through the floor until a human tries it. Ludra closes that loop:

| What an agent needs | What Ludra gives it |
| --- | --- |
| A format it can read and write reliably | Scenes are JSON: entities made of components. No binary files, no editor. |
| To know what is wrong and how to fix it | `ludra check`: every diagnostic has a JSON path and a concrete `fix:` |
| To see what happens | `ludra play`: deterministic headless simulation with a timeline, events and an ASCII map of the frame |
| To see what players see | `ludra play --screenshot 1s,end`: real rendered frames as PNGs that a multimodal agent can look at |
| To prove a feature works | `ludra test`: scripted inputs plus assertions like `"score == 3"` or `"player.grounded == true at 1s"` |
| To know the API without guessing | `ludra components`: a reference generated from the engine itself |
| To hand off to a human | `ludra dev`: the same simulation in the browser with keyboard controls and live reload |

The simulation is fixed-step and deterministic, so the game a test verifies is exactly the game a player gets.

## Quick start

Requires Node.js 22.18 or newer.

### With Claude Code (recommended)

Install the plugin by running these two commands inside Claude Code:

```
/plugin marketplace add ersingvn/ludra
/plugin install ludra@ludra
```

Then just ask, in any folder:

> make me a platformer with spikes, a moving platform and an enemy to stomp

The plugin's [`make-2d-platformer-games` skill](plugins/ludra/skills/make-2d-platformer-games/SKILL.md) teaches Claude the whole loop: create the game, `check` after every edit, `play` it headlessly, prove it with `test`, add art and effects, and hand it to you with `ludra dev`. Every project created with `ludra new` also has a `CLAUDE.md` with the same loop, so other agents know how to work in it too.

To update later, run `/plugin marketplace update ludra`.

### From npm

```bash
npx @ludra/cli new my-game
npx @ludra/cli play my-game --inputs "right:1s, jump:0.4s" --ascii
npx @ludra/cli dev my-game
```

Or install it once with `npm install -g @ludra/cli` and run `ludra new my-game`. The packages are [`@ludra/cli`](https://www.npmjs.com/package/@ludra/cli) and [`@ludra/core`](https://www.npmjs.com/package/@ludra/core).

### From source

```bash
git clone https://github.com/ersingvn/ludra.git && cd ludra
npm install
npm run ludra -- new my-game
npm run ludra -- play my-game --inputs "right:1s, jump:0.4s" --ascii
npm run ludra -- dev my-game
```

## A tour

### A scene

```json
{
  "id": "player",
  "components": {
    "transform": { "x": 80, "y": 482 },
    "body": { "type": "dynamic", "width": 28, "height": 36 },
    "sprite": { "color": "#7cf29c", "layer": 2 },
    "platformer": { "speed": 240, "jumpSpeed": 680 }
  }
}
```

### `ludra check`: errors that explain themselves

```
✗ error E_UNKNOWN_COMPONENT scenes/main.scene.json → entities[0].components.platfromer
  Unknown component "platfromer" on entity "player".
  fix: Did you mean "platformer"? Run `ludra components` to list every component.
```

### `ludra play`: the agent's eyes

```
▶ coin-climb: simulated 4.30s (258 frames)  inputs: right:0.55s, right+jump:0.45s, ...

Events
  0.57s   jump     player
  1.08s   land     player
  1.08s   collect  player → coin-1 (+1)
  ...
Final: score 3 · 7 entities

t=4.30s  frame 258  score 3  (1 char = 12x24px)
+--------------------------------------------------------------------------------+
|                                                                     @@@        |
|                                                                     @@@        |
|                                                               ######@@@#####   |
|                                           ##############                       |
|                       ##############                                           |
|################################################################################|
+--------------------------------------------------------------------------------+
```

Add `--json` to any command for machine-readable output.

### `ludra play --screenshot`: real frames, not guesses

ASCII shows the layout. To check the art, an agent asks for real frames of the same deterministic run:

```
$ ludra play --inputs "right:0.3s, right+jump:0.45s, ..." --screenshot 0.85s,3.7s

Screenshots (open these PNGs to see the frames)
  0.85s   screenshots/t-0.85s.png
  3.70s   screenshots/t-3.70s.png
```

<p align="center">
  <img src="docs/media/screenshot-lift.png" alt="Screenshot at 3.7 seconds: the player rides the moving lift over the pit while gold coin particles fade, and the slime waits on the far side" width="720">
</p>

Frames come from the same renderer players use, with sprites, animation and particles, driven by Chrome, Edge or Chromium already on the machine in headless mode. Ludra adds no dependencies for this, and three frames take about a second.

### `ludra test`: proof, not vibes

```json
{
  "name": "the level can be completed without dying",
  "inputs": "right:0.3s, right+jump:0.45s, right:0.85s, ..., right:1.5s",
  "assert": ["won == true", "deaths == 0", "score == 4", "events.stomp == 1"]
}
```

```
gameplay.test.json
  ✓ player rests on the ground
  ✓ player runs right
  ✓ jumping leaves the ground and lands again
  ✓ spikes kill the player, who respawns at the start
  ✓ the lift carries the player over the pit
  ✓ the level can be completed without dying

6 passed, 0 failed
```

Assertions can check `score`, `deaths`, `won`, event counts (`events.jump`, `events.stomp`, ...) and any entity's `x`, `y`, `vx`, `vy`, `grounded` or `exists`, at the end or `at 1.5s`.

### Blocks: tested pieces, combined with taste

Like a video agent assembling scenes from a library of transitions and titles, a Ludra agent starts from **blocks**: ready-made, tested pieces of gameplay, each with its scripts, SVG art and effects.

```
$ ludra blocks
chasing-enemy     An enemy that waits, then runs at the player once they come close.
falling-platform  A cracked platform that shakes when stood on, falls, then comes back.
key-and-door      A key and the locked door it opens.
teleporter        Two linked pads. Stepping on one moves the player to the other.
turret            A turret that fires deadly bullets at a steady rhythm.
...

$ ludra add key-and-door --at 400,500
✓ Added "key-and-door" to scenes/main.scene.json
  entity  key-and-door-key       at (400, 460)
  entity  key-and-door-door      at (600, 440)
  file    scripts/key.ts         added
  ...
```

- Blocks link their parts by id, so you can add several, and never overwrite files you changed.
- Every block ships a demo that CI plays on each commit, so the library stays working.
- The agent then makes them its own: tuning `params`, restyling art, and combining blocks into new mechanics.

The skill also teaches **taste**: a [design guide](plugins/ludra/skills/make-2d-platformer-games/DESIGN.md) on level design (teach, test, twist), fairness checks it can run (timing windows of at least 0.2 s, no blind jumps), game feel, palettes and SVG art direction, and a finishing checklist.

### Art without limits

Sprites are where looks start, not where they stop. Any script can paint with the real Canvas 2D context, replace the HUD, load Google Fonts and run a GLSL shader over every frame. That's the whole toolbox a human artist-programmer would use, and agents are very good at writing code. Both of these are the templates, untouched:

<p align="center">
  <img src="docs/media/neon-breakout.png" alt="Neon Breakout: glowing neon bricks over a synthwave sun and a scrolling perspective grid, with +1 popups and shockwaves where bricks broke, a comet-tailed ball and a CRT bloom finish" width="49%">
  <img src="docs/media/crystal-grove.png" alt="Crystal Grove at night: a lantern lights the hero, crystals glow blue, slimes purple, thorns red and the portal swirls, with fireflies and crystal slots in the corner" width="49%">
</p>

```ts
// scripts/ball.ts: game logic and looks side by side
export default {
  update({ self, params }) { /* keep the speed constant... */ },
  draw({ g, self, local }) {
    g.globalCompositeOperation = "lighter";           // additive light
    g.shadowColor = "#ffd60a";
    g.shadowBlur = 18;                                 // glow
    g.beginPath();
    g.arc(self.x, self.y, 7, 0, Math.PI * 2);
    g.fill();
  },
} satisfies Script;
```

```json
"fonts": { "Orbitron": "google" },
"postfx": { "shader": "shaders/neon.frag", "uniforms": { "bloom": 1.6, "scanlines": 0.5 } }
```

Draw hooks can read the game but not change it (that throws), so the browser never drifts from what the tests verified. `ludra check` runs them against a mock canvas to catch errors early, and `ludra play --screenshot` renders the real thing, shader included, for the agent to look at.

### Genres

Start from the template closest to your idea and reshape it:

```bash
npx @ludra/cli new my-game                       # platformer: run, jump, stomp
npx @ludra/cli new my-game --template topdown    # seen from above: gems, hedges, slimes
npx @ludra/cli new my-game --template breakout   # paddle, bouncing ball, bricks
```

Each template ships with tests that prove it can be won without dying, and its own look: the platformer in SVG sprites, the breakout drawn entirely in code, the grove lit by code over SVG sprites. The breakout route is 28 seconds long, so the skill teaches agents to write a small autopilot that plays the level and prints the input, instead of guessing.

### Scripts: any game logic, still testable

Built-in components cover the basics. For everything else (enemies that chase, keys and locked doors, timers, shooting, boss phases) the agent writes a short TypeScript script, the way Unity developers write C# behaviours:

```ts
// scripts/locked-door.ts
import type { Script } from "@ludra/core";

export default {
  update({ self, world }) {
    const player = world.player();
    if (player?.state.hasKey && self.touches(player)) {
      world.emit("door-open");
      world.destroy(self);
    }
  },
} satisfies Script;
```

```json
"script": { "src": "scripts/locked-door.ts" }
```

Unlike in other engines, the agent can prove the script works, because scripts run in the same deterministic simulation as everything else:

```json
"assert": ["events.door-open == 1", "player.state.hasKey == true", "chaser.state.chasing == true"]
```

- **Hooks:** `start`, `update` and `touch`. Scripts get the entity (`self`), the `world` (`get`, `all`, `player`, `spawn`, `destroy`, `kill`, `win`, `emit`, a seeded `random`) and `input`.
- **No build step:** Node and the dev server strip types on the fly.
- **Errors:** `ludra check` loads every script and reports syntax errors with the line and a caret. Runtime errors name the file, entity, hook and frame.
- **Reference:** run `ludra components script` for the API, or see [`examples/key-quest`](examples/key-quest) for a jump pad, a key, a locked door, a chasing enemy and a time limit, all with tests.

### Art, effects and sound, all as text

Agents can't use a paint program, so Ludra's art pipeline is text too. Sprites are **SVG files the agent writes itself**: spritesheets with `idle`, `run`, `jump` and `fall` animations that switch automatically, and tiles for ground and platforms. Game events trigger particles, synthesized sounds and screen shake from a few lines of JSON:

```json
"effects": {
  "collect": { "sound": "coin", "particles": { "count": 14, "color": "#ffd166", "speed": 140 } },
  "die": { "sound": "explosion", "shake": 10, "particles": { "count": 30, "color": "#ff5d73" } }
}
```

No audio files are needed: `jump`, `coin`, `hit`, `explosion`, `powerup`, `blip` and `thud` are synthesized in the browser. Presentation never touches the simulation, so polishing a game can't break its tests, and `ludra check` reports any missing image along with the files that do exist.

## Components (v0.7)

| Component | What it does |
| --- | --- |
| `transform` | Position (entity center, +y is down) |
| `body` | Box collider: `static`, `dynamic` (gravity and collisions) or `kinematic`; `sensor` for triggers; `bounce` for balls that rebound |
| `sprite` | A colored shape, or an image: animated spritesheets (idle/run/jump/fall), tiles and mirroring |
| `platformer` | Run and jump controls with coyote time, jump buffering and variable jump height |
| `topdown` | Movement seen from above: 8 directions, 4 directions, or a single axis for paddles |
| `collectible` | Picked up by the player and adds to the score |
| `patrol` | Moves a kinematic body back and forth: moving platforms (they carry the player) and walking enemies |
| `hazard` | Kills the player on touch, who respawns at the start. `stompable` enemies die when landed on |
| `goal` | Completes the level, optionally only after reaching `requireScore` |
| `emitter` | Streams particles continuously: sparkles, fire, smoke |
| `script` | Custom behavior in TypeScript: `start`, `update` and `touch` hooks with `params` |
| `camera` | The browser camera follows this entity through worlds wider than the window |

Falling out of the bottom of the world also counts as a death. Scene-level `effects` add particles, sound and shake to game events. Run `ludra components effects` for every option.

Run `ludra components` for every field, its type and its default.

## Repository layout

```
packages/core     Engine: scene format, validation, deterministic world, input scripts,
                  assertions, ASCII renderer, browser runtime (zero dependencies)
packages/cli      The `ludra` command, project templates and the block library (blocks/)
plugins/ludra     Claude Code plugin: the skill that teaches agents the workflow
.claude-plugin    Marketplace manifest, so the repo installs with /plugin
examples/         Games built with Ludra
docs/             Architecture and design notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Roadmap

- ~~**v0.2: more game.** Enemies and patrol paths, hazards, goals, moving platforms that carry the player.~~ Done.
- ~~**v0.3: looks.** Image sprites and spritesheets, particles, screen shake, sound.~~ Done.
- ~~**v0.4: real screenshots.** `ludra play --screenshot` renders actual frames headlessly so multimodal agents can see the game.~~ Done.
- ~~**v0.5: scripting.** Custom game logic in TypeScript, deterministic and testable.~~ Done.
- ~~**v0.6: blocks and taste.** `ludra blocks` / `ludra add`, a library of tested gameplay blocks, and a design guide in the skill.~~ Done.
- ~~**v0.7: genres.** A top-down controller, bounce physics, and templates for top-down adventures and breakout-style games.~~ Done.
- **v0.8: game structure.** Multiple scenes and level transitions, prefabs, text and UI, lives and checkpoints.
- **v0.9: worlds.** Tilemaps, camera zones, parallax backgrounds, and a real physics engine (Rapier).
- **v0.10: shipping.** Export to a single HTML file or a desktop app, touch controls for mobile.
- **v1.0: 3D.** The same scene format and agent tools on a WebGL renderer with 3D physics.

## Contributing

Ludra is MIT licensed and contributions are very welcome. New components are the easiest place to start. See [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers: releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
