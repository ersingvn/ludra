# {{name}}

A physics platformer built with Ludra, a game engine designed for AI agents: Crate & Chasm. Push a crate to climb a cliff, then cross a rope bridge under a swinging spiked ball. It runs on real physics (Rapier): `"physics": "rapier"` in `"world"`.

## Layout

- `game.md`: what this game means to be and look like
- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level. Entities are made of components; `effects` adds particles, sound and shake to game events.
- `assets/`: SVG art. `rock.svg` and `ground.svg` tile; the cliffs are a rock body with a grass strip (drawing only) on top.
- `scripts/`: `backdrop.ts` (sky and parallax hills), `lantern.ts` (lights a reached checkpoint), `chain.ts` (draws the pendulum's chain from `params.pivot`), `ambience.ts` (the place's sound), `hud.ts` (hearts, points, title card, end screens). Run `npx @ludra/cli components script` for the API.
- `shaders/glow.frag`: the finishing shader (bloom, grade, vignette).
- `tests/*.test.json`: gameplay tests, run headlessly.

## Before any art

Decide the look in `game.md` first, and make it this game's own: what comes with a project is only an example, and the easy path gives a game that looks like every other. `## Promise` says what a player remembers; `## Look` has `- style:`, `- type:` and `- palette:`. One strong constraint does more than many effects: for example `"window": { "width": 480, "height": 270, "pixelated": true }` in `ludra.json` with `ctx.pixelText` for text gives hard pixels throughout, and a theme per level (walls, accent, light) tells a player where they are from one frame.

## Loop

1. Edit `scenes/main.scene.json`. Run `npx @ludra/cli components` for every component and field, `components body` and `components joint` for the physics ones.
2. Run `npx @ludra/cli check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx @ludra/cli play --inputs "right:3s" --watch player,crate --every 0.5s` to see what actually happens. Add `--screenshot 2s,end` to save real rendered frames to `screenshots/`, and `--debug` to see colliders, joints and velocities on them.
4. Write the behavior you want into `tests/*.test.json` and run `npx @ludra/cli test`.
5. Run `npx @ludra/cli review` and fix every issue it lists: it catches what makes a game feel unfinished (untested mechanics, silent events, the default HUD, flat looks).
6. Run `npx @ludra/cli dev` so a human can play it in the browser. The backquote key (`) toggles the debug view there.

Never call a change done until `ludra check`, `ludra test` and `ludra review` are all clean. Clean means it isn't broken, not that it's good: then look at the frames against `game.md` and keep making it better.

## How the physics pieces work

- The crate is a plain `dynamic` body: the player pushes it (platformer `push`), it has friction and mass, and it is a step once it rests against the cliff. Puzzles come free: anything dynamic can be pushed, stacked, knocked over or stood on.
- The bridge is 8 dynamic planks, each with a `revolute` joint to the one before it. The first is hinged to a point in the world (a joint with no `to`); the last has a list of two joints, to its neighbor and to the right cliff. `anchor` is the hinge point, relative to the plank's center.
- The pendulum is a `dynamic` circle with one `revolute` joint to a world point 190px away. It starts level with the pivot and swings forever (no friction in the air). It's a `sensor` with `hazard`, so it kills without pushing. `chain.ts` only draws.
- Physics is deterministic: the same inputs give the same frames on every machine, so timing a crossing between swings is a fair, testable puzzle.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down. Rotation is in degrees, clockwise.
- Jump height = jumpSpeed² / (2 · gravity). The defaults (680, 1800) give about 128px: the cliff (160px) is out of reach, the crate (60px) and crate-to-cliff (100px) are not.
- Players never rotate; everything else can. Use `"fixedRotation": true` for a body that must stay upright.
- Collectibles, hazards and goals need `"sensor": true` on their body.
- A jump only triggers on a new press, so put a segment without jump between two jump segments.
- Timing puzzles are found by sweeping: run `play` with `wait:0.1s`, `wait:0.3s`, ... before the hard part and keep the middle of a window that works. The test for the whole level uses that route.
- The game has 3 lives (`world.lives`); the lantern is a `checkpoint` before the bridge.
- A level is done when a test proves `won == true` with `deaths == 0`.
- Scripts can reach physics directly: `self.applyImpulse`, `self.applyForce`, `world.raycast`, and `world.physics.raw` for the whole Rapier API. See `npx @ludra/cli components script`.
- The scene has its own `"sounds"` (used by `effects`) and `"music"` (tracks of notes). Change them with the game's mood; `npx @ludra/cli components sounds` shows every field. `scripts/ambience.ts` is a `sound` hook: wind, the pendulum's hiss and the crate's scrape follow the physics through the real Web Audio API.
- Bigger levels: a `tilemap` draws a level as rows of characters, `cameraZone` frames rooms and vistas, and `tween` eases lifts, doors and pickups. See `npx @ludra/cli components tilemap` (and `cameraZone`, `tween`).
- Art and effects never change gameplay. Make it playable first, then dress it in the look `game.md` chose: SVG in `assets/`, or draw hooks when code paints it better (lighting, rock, water).
- For behavior no component provides, write a script and attach it with a `script` component. Use `world.random()`, never `Math.random()`.
