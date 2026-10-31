# {{name}}

A top-down game built with Ludra, a game engine designed for AI agents.

## Layout

- `game.md`: what this game means to be and look like
- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level, seen from above. Entities are made of components; `effects` adds particles, sound and shake to game events.
- `assets/`: SVG art. Spritesheets are frames side by side; tiles repeat, and `"variants"` mixes in more cells so the grid doesn't show.
- `scripts/`: TypeScript. `night.ts` draws the darkness, the lantern, colored lights and fireflies; `portal.ts` the vortex; `hud.ts` the whole interface. Run `npx @ludra/cli components script` for the API.
- `shaders/dream.frag`: the post-processing shader (bloom, warm/cool grade, vignette).
- `tests/*.test.json`: gameplay tests, run headlessly

## Before any art

Decide the look in `game.md` first, and make it this game's own: what comes with a project is only an example, and the easy path gives a game that looks like every other. `## Promise` says what a player remembers; `## Look` has `- style:`, `- type:` and `- palette:`. One strong constraint does more than many effects: for example `"window": { "width": 480, "height": 270, "pixelated": true }` in `ludra.json` with `ctx.pixelText` for text gives hard pixels throughout, and a theme per level (walls, accent, light) tells a player where they are from one frame.

## Loop

1. Edit `scenes/main.scene.json`. Run `npx @ludra/cli components` for every component and field, and `npx @ludra/cli blocks` for ready-made pieces you can drop in with `npx @ludra/cli add <block> --at x,y`.
2. Run `npx @ludra/cli check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx @ludra/cli play --inputs "right:1s, up:0.5s" --ascii` to see what actually happens. Add `--screenshot 0.5s,end` to save real rendered frames to `screenshots/` and look at them.
4. Write the behavior you want into `tests/*.test.json` and run `npx @ludra/cli test`.
5. Run `npx @ludra/cli review` and fix every issue it lists: it catches what makes a game feel unfinished (untested mechanics, silent events, the default HUD, flat looks).
6. Run `npx @ludra/cli dev` so a human can play it in the browser.

Never call a change done until `ludra check`, `ludra test` and `ludra review` are all clean. Clean means it isn't broken, not that it's good: then look at the frames against `game.md` and keep making it better.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down. The world has no gravity (`"gravity": 0`).
- The hero uses `topdown`: arrow keys move it in 8 directions at `speed` px/s. Inputs like `"right+up:0.5s"` move diagonally. A `dynamic` body collides with walls.
- Walls are `static` bodies. Hazards, collectibles and goals need `"sensor": true`.
- Enemies are kinematic sensor bodies with a `patrol` (`axis` "x" or "y") and a `hazard`. In top-down games they can't be stomped.
- A floor is an entity with only a tiled `sprite` (no body) on `layer` -1, sized to the world.
- The level is done when a test proves `won == true` with `deaths == 0`, and every enemy crossing works across a wide timing window (sweep `wait:` values with `play`).
- For a game that is about physics (stacking, ropes, hinges, rolling, vehicles), set `"physics": "rapier"` in `"world"`: rotation, round and free shapes, friction, mass and joints. See the skill's physics section and `npx @ludra/cli components body` / `joint`.
- The scene has its own `"sounds"` (used by `effects`) and `"music"` (tracks of notes). Change them with the game's mood; `npx @ludra/cli components sounds` shows every field. A script's `sound` hook gets the real Web Audio API for sound that follows the game.
- Bigger levels: a `tilemap` draws a level as rows of characters, `cameraZone` frames rooms and vistas, and `tween` eases lifts, doors and pickups. See `npx @ludra/cli components tilemap` (and `cameraZone`, `tween`).
- Art and effects never change gameplay. Make it playable first, then dress it in the look `game.md` chose: SVG in `assets/`, or draw hooks when code paints it better (lighting, rock, water).

## Looks

The sprites are SVG; the mood comes from code. `night.ts` lights the scene (keep every hazard lit in its warning color), and the scene loads the Cinzel font and runs `shaders/dream.frag`.

There are no limits on looks. A script's `draw(ctx)` paints with the real Canvas 2D context (`ctx.g`), `drawUI(ctx)` replaces the HUD, `"fonts"` loads Google Fonts, and `"postfx"` runs a GLSL shader over every frame. Run `npx @ludra/cli components script` for the API. Draw hooks only paint: they can't change the game, so tests stay valid. After every visual change, look at real frames with `play --screenshot`.
