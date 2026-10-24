# Ludra

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

> **Status:** early (v0.2). 2D platformers with enemies, hazards, moving platforms and goals, plus the full agent toolchain, work today. 3D and an asset pipeline are on the [roadmap](#roadmap).

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

```bash
git clone https://github.com/ersingvn/ludra.git && cd ludra
npm install
npm run ludra -- new my-game
npm run ludra -- play my-game --inputs "right:1s, jump:0.4s" --ascii
npm run ludra -- dev my-game
```

Once the packages are published, this becomes `npx ludra new my-game`.

### Use it with Claude Code

This repo is also a Claude Code plugin. The [`ludra` skill](skills/ludra/SKILL.md) teaches Claude the workflow: edit, check, play, test, then hand off. Every project created with `ludra new` also includes a `CLAUDE.md` with the same loop, so any agent that reads it knows how to work.

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

## Components (v0.2)

| Component | What it does |
| --- | --- |
| `transform` | Position (entity center, +y is down) |
| `body` | Box collider: `static`, `dynamic` (gravity and collisions) or `kinematic`; `sensor` for triggers |
| `sprite` | Rectangle or circle with a color and draw layer |
| `platformer` | Run and jump controls with coyote time, jump buffering and variable jump height |
| `collectible` | Picked up by the player and adds to the score |
| `patrol` | Moves a kinematic body back and forth: moving platforms (they carry the player) and walking enemies |
| `hazard` | Kills the player on touch, who respawns at the start. `stompable` enemies die when landed on |
| `goal` | Completes the level, optionally only after reaching `requireScore` |
| `camera` | The browser camera follows this entity through worlds wider than the window |

Falling out of the bottom of the world also counts as a death.

Run `ludra components` for every field, its type and its default.

## Repository layout

```
packages/core     Engine: scene format, validation, deterministic world, input scripts,
                  assertions, ASCII renderer, browser runtime (zero dependencies)
packages/cli      The `ludra` command and project templates
skills/ludra      Claude skill that teaches agents the workflow
examples/         Games built with Ludra
docs/             Architecture and design notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Roadmap

- ~~**v0.2: more game.** Enemies and patrol paths, hazards, goals, moving platforms that carry the player.~~ Done.
- **v0.2.x:** multiple scenes and level transitions, checkpoints, lives.
- **v0.3: looks.** Image sprites and spritesheets, tilemaps, particles, screen shake, text and UI, sound, plus asset packs and AI-generated assets.
- **v0.4: real screenshots.** `ludra play --screenshot` renders actual frames headlessly so multimodal agents can see the game.
- **v0.5: 3D.** The same scene format and agent tools on a WebGL renderer with real 3D physics.
- **Later:** top-down and other genres, a component registry (`ludra add <component>`), multiplayer, and desktop and mobile export.

## Contributing

Ludra is MIT licensed and contributions are very welcome. New components are the easiest place to start. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
