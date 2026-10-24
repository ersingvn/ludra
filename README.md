# Ludra

[![CI](https://github.com/ersingvn/ludra/actions/workflows/ci.yml/badge.svg)](https://github.com/ersingvn/ludra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**The game engine built for AI agents.**

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

> **Status:** early (v0.3). 2D platformers with enemies, hazards, moving platforms, goals, animated SVG sprites, particles and sound, plus the full agent toolchain, work today. 3D is on the [roadmap](#roadmap).

## Why an engine for agents?

When an AI writes a game with a normal engine, it is coding blind. It cannot see the screen, cannot press keys, and does not find out that the player falls through the floor until a human tries it. Ludra closes that loop:

| What an agent needs | What Ludra gives it |
| --- | --- |
| A format it can read and write reliably | Scenes are JSON: entities made of components. No binary files, no editor. |
| To know what is wrong and how to fix it | `ludra check`: every diagnostic has a JSON path and a concrete `fix:` |
| To see what happens | `ludra play`: deterministic headless simulation with a timeline, events and an ASCII map of the frame |
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

The plugin's [`ludra` skill](plugins/ludra/skills/ludra/SKILL.md) teaches Claude the whole loop: create the game, `check` after every edit, `play` it headlessly, prove it with `test`, add art and effects, and hand it to you with `ludra dev`. Every project created with `ludra new` also has a `CLAUDE.md` with the same loop, so other agents know how to work in it too.

To update later, run `/plugin marketplace update ludra`.

> [!NOTE]
> The skill runs the CLI through `npx ludra`, which needs the `ludra` npm package. Until it is published, clone this repo and work inside it with `npm run ludra -- <command>` instead (see below).

### From source

```bash
git clone https://github.com/ersingvn/ludra.git && cd ludra
npm install
npm run ludra -- new my-game
npm run ludra -- play my-game --inputs "right:1s, jump:0.4s" --ascii
npm run ludra -- dev my-game
```

Once the packages are published, this becomes `npx ludra new my-game`.

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

### Art, effects and sound, all as text

Agents can't use a paint program, so Ludra's art pipeline is text too. Sprites are **SVG files the agent writes itself**: spritesheets with `idle`, `run`, `jump` and `fall` animations that switch automatically, and tiles for ground and platforms. Game events trigger particles, synthesized sounds and screen shake from a few lines of JSON:

```json
"effects": {
  "collect": { "sound": "coin", "particles": { "count": 14, "color": "#ffd166", "speed": 140 } },
  "die": { "sound": "explosion", "shake": 10, "particles": { "count": 30, "color": "#ff5d73" } }
}
```

No audio files are needed: `jump`, `coin`, `hit`, `explosion`, `powerup`, `blip` and `thud` are synthesized in the browser. Presentation never touches the simulation, so polishing a game can't break its tests, and `ludra check` reports any missing image along with the files that do exist.

## Components (v0.3)

| Component | What it does |
| --- | --- |
| `transform` | Position (entity center, +y is down) |
| `body` | Box collider: `static`, `dynamic` (gravity and collisions) or `kinematic`; `sensor` for triggers |
| `sprite` | A colored shape, or an image: animated spritesheets (idle/run/jump/fall), tiles and mirroring |
| `platformer` | Run and jump controls with coyote time, jump buffering and variable jump height |
| `collectible` | Picked up by the player and adds to the score |
| `patrol` | Moves a kinematic body back and forth: moving platforms (they carry the player) and walking enemies |
| `hazard` | Kills the player on touch, who respawns at the start. `stompable` enemies die when landed on |
| `goal` | Completes the level, optionally only after reaching `requireScore` |
| `emitter` | Streams particles continuously: sparkles, fire, smoke |
| `camera` | The browser camera follows this entity through worlds wider than the window |

Falling out of the bottom of the world also counts as a death. Scene-level `effects` add particles, sound and shake to game events. Run `ludra components effects` for every option.

Run `ludra components` for every field, its type and its default.

## Repository layout

```
packages/core     Engine: scene format, validation, deterministic world, input scripts,
                  assertions, ASCII renderer, browser runtime (zero dependencies)
packages/cli      The `ludra` command and project templates
plugins/ludra     Claude Code plugin: the skill that teaches agents the workflow
.claude-plugin    Marketplace manifest, so the repo installs with /plugin
examples/         Games built with Ludra
docs/             Architecture and design notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Roadmap

- ~~**v0.2: more game.** Enemies and patrol paths, hazards, goals, moving platforms that carry the player.~~ Done.
- **v0.2.x:** multiple scenes and level transitions, checkpoints, lives.
- ~~**v0.3: looks.** Image sprites and spritesheets, particles, screen shake, sound.~~ Done.
- **v0.3.x:** tilemaps, parallax backgrounds, text and UI, music, and importing asset packs.
- **v0.4: real screenshots.** `ludra play --screenshot` renders actual frames headlessly so multimodal agents can see the game.
- **v0.5: 3D.** The same scene format and agent tools on a WebGL renderer with real 3D physics.
- **Later:** top-down and other genres, a component registry (`ludra add <component>`), multiplayer, and desktop and mobile export.

## Contributing

Ludra is MIT licensed and contributions are very welcome. New components are the easiest place to start. See [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers: releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
