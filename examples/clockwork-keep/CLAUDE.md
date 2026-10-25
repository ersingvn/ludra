# Clockwork Keep

A two-floor castle built with Ludra to show its world-building tools: the level is a **tilemap**, each floor is a **camera zone**, and everything that moves on its own is a **tween**. Cross the cellar, ride the lift up, light the lantern to raise the gate, glide over the hall's spike pit and reach the flag with all four coins.

## Layout

- `scenes/main.scene.json`: the level. The `keep` entity's `tilemap` draws the whole castle as 27 rows of 48 characters (`#` stone, `^` spikes, `c` a coin prefab, `.` empty); it becomes ordinary entities named `keep-<row>-<col>`.
- `prefabs/coin.prefab.json`: a coin that bobs with a `tween`. The tilemap places it.
- `scripts/keep-wall.ts`: the castle wall behind the level, windows and torches, drawn in code. `hud.ts` and `lantern.ts` come from the platformer template.
- `tests/gameplay.test.json`: each moving part on its own, and the full route.

## How the pieces work

- **Tilemap:** `"tilemap": { "tileSize": 40, "rows": [...], "legend": { ... } }` on an entity whose transform is the map's top-left corner. A legend entry is a tile (`image`, `color`, `solid`, `sensor`, `layer`, `components`) or a prefab name. Neighboring cells of the same tile merge into one body, so the cellar floor is a single collider. Edit the rows like a drawing; `ludra check` names any character missing from the legend with its row and column.
- **Camera zones:** `cellar-room` and `hall-room` are `"mode": "room"` zones: the view follows the player but never shows the other floor. `vista` is `"mode": "fixed"` with `"zoom": 0.5` and a higher `priority`: near the flag the camera eases out to show the whole keep. `blend` is how many seconds each change eases over. Zones only move the camera, so tests never see them; look at them with `play --screenshot ... --debug` (violet frames).
- **Tweens:**
  - The lift is `"property": "y", "by": -520, "repeat": "pingpong", "delay": 1.2`. It rests 1.2 s at each floor and eases between them.
  - The glider does the same along x.
  - The gate is `"on": "checkpoint"`, so lighting the lantern raises it once.
  - Tweened kinematic bodies move by velocity, so they carry the player like a patrol does. In scripts, `self.tween({ ... })` starts one.

## Loop

1. Edit the scene or a script. `npx @ludra/cli components tilemap`, `cameraZone` and `tween` list every field.
2. `npx @ludra/cli check`, then `npx @ludra/cli play --inputs "right:2s" --watch player,lift --every 0.5s`.
3. Timed parts are found by sweeping: run `play` with different waits before the lift or the glider and keep the middle of a window that works.
4. `npx @ludra/cli test`, `npx @ludra/cli review`, and `npx @ludra/cli dev` to play it.
