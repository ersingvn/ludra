# {{name}}

A breakout game built with Ludra, a game engine designed for AI agents.

## Layout

- `game.md`: what this game means to be and look like
- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level. Entities are made of components; `effects` adds particles, sound and shake to game events.
- `shaders/neon.frag`: the post-processing shader (bloom, chromatic aberration, scanlines, CRT curve).
- `scripts/`: the game rules in TypeScript. Run `npx @ludra/cli components script` for the API.
  - `ball.ts` rests on the paddle, launches, keeps a constant speed and costs a life when it falls out.
  - `paddle.ts` aims the ball by where it hits the paddle.
  - `brick.ts` breaks on contact and adds `points` to the score.
  - `rules.ts` wins the level when no entity whose id starts with `prefix` is left, and draws the brick-break feedback and the whole interface (`drawUI`).
  - `backdrop.ts` and `wall.ts` only draw: the synthwave sky and the neon walls.
- `tests/*.test.json`: gameplay tests, run headlessly

## Before any art

Decide the look in `game.md` first, and make it this game's own: what comes with a project is only an example, and the easy path gives a game that looks like every other. `## Promise` says what a player remembers; `## Look` has `- style:`, `- type:` and `- palette:`. One strong constraint does more than many effects: for example `"window": { "width": 480, "height": 270, "pixelated": true }` in `ludra.json` with `ctx.pixelText` for text gives hard pixels throughout, and a theme per level (walls, accent, light) tells a player where they are from one frame.

## Loop

1. Edit `scenes/main.scene.json` or a script. Run `npx @ludra/cli components` for every component and field.
2. Run `npx @ludra/cli check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx @ludra/cli play --watch ball,paddle --ascii` to see what actually happens. Add `--screenshot 1s,end` to save real rendered frames to `screenshots/` and look at them.
4. Write the behavior you want into `tests/*.test.json` and run `npx @ludra/cli test`.
5. Run `npx @ludra/cli review` and fix every issue it lists: it catches what makes a game feel unfinished (untested mechanics, silent events, the default HUD, flat looks).
6. Run `npx @ludra/cli dev` so a human can play it in the browser.

Never call a change done until `ludra check`, `ludra test` and `ludra review` are all clean. Clean means it isn't broken, not that it's good: then look at the frames against `game.md` and keep making it better.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down. The world has no gravity (`"gravity": 0`).
- The paddle is a `kinematic` body with `topdown` `"directions": "x"`: left/right only, and it stops at walls.
- The ball is a `dynamic` body with `"bounce": 1` and `"gravityScale": 0`. Bounce does the reflecting; `ball.ts` keeps the speed constant and never lets it fly almost flat.
- Bricks are `static` bodies with `brick.ts`. Give each brick an id starting with `brick-` so `rules.ts` counts it.
- The bottom of the world is open on purpose: that is where the ball is lost.
- A level is done when a test proves `won == true` with `deaths == 0`. Long routes are easiest to find by writing a small autopilot that steers the paddle under the ball, then pasting its input (frame counts like `"left:24f"`) into the test.
- For a game that is about physics (stacking, ropes, hinges, rolling, vehicles), set `"physics": "rapier"` in `"world"`: rotation, round and free shapes, friction, mass and joints. See the skill's physics section and `npx @ludra/cli components body` / `joint`.
- The scene has its own `"sounds"` (used by `effects`) and `"music"` (tracks of notes). Change them with the game's mood; `npx @ludra/cli components sounds` shows every field. A script's `sound` hook gets the real Web Audio API for sound that follows the game.
- Bigger levels: a `tilemap` draws a level as rows of characters, `cameraZone` frames rooms and vistas, and `tween` eases lifts, doors and pickups. See `npx @ludra/cli components tilemap` (and `cameraZone`, `tween`).
- Art and effects never change gameplay. Make it playable first, then dress it.

## Looks

Everything is drawn in code, no image files: each script has a `draw` hook next to its game logic. The scene loads the Orbitron font and runs `shaders/neon.frag` over every frame (tune it with `postfx.uniforms`).

There are no limits on looks. A script's `draw(ctx)` paints with the real Canvas 2D context (`ctx.g`), `drawUI(ctx)` replaces the HUD, `"fonts"` loads Google Fonts, and `"postfx"` runs a GLSL shader over every frame. Run `npx @ludra/cli components script` for the API. Draw hooks only paint: they can't change the game, so tests stay valid. After every visual change, look at real frames with `play --screenshot`.
