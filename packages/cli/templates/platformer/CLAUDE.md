# {{name}}

A platformer built with Ludra, a game engine designed for AI agents: two levels, Night Meadow and Moonlit Cliffs.

## Layout

- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: level 1 (the entry scene). Its flag's `next` leads to `scenes/level-2.scene.json`. Entities are made of components; `effects` adds particles, sound and shake to game events.
- `prefabs/`: `coin` and `slime`, reused by both levels. An entity says `"prefab": "slime"` and lists only what differs.
- `assets/`: SVG art. Spritesheets are frames side by side; tiles repeat.
- `scripts/`: `backdrop.ts` (the night sky and parallax hills), `lantern.ts` (lights a reached checkpoint), `hud.ts` (hearts, points, title card, end screens). Run `npx @ludra/cli components script` for the API.
- `shaders/glow.frag`: the finishing shader (bloom, grade, vignette).
- `tests/*.test.json`: gameplay tests, run headlessly. Tests for level 2 say `"scene": "scenes/level-2.scene.json"`.

## Loop

1. Edit `scenes/main.scene.json`. Run `npx @ludra/cli components` for every component and field, and `npx @ludra/cli blocks` for ready-made pieces you can drop in with `npx @ludra/cli add <block> --at x,y`.
2. Run `npx @ludra/cli check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx @ludra/cli play --inputs "right:1s, jump:0.4s" --ascii` to see what actually happens. Add `--screenshot 0.5s,end` to save real rendered frames to `screenshots/` and look at them.
4. Write the behavior you want into `tests/*.test.json` and run `npx @ludra/cli test`.
5. Run `npx @ludra/cli review` and fix every issue it lists: it catches what makes a game feel unfinished (untested mechanics, silent events, the default HUD, flat looks).
6. Run `npx @ludra/cli dev` so a human can play it in the browser.

Never call a change done until `ludra check`, `ludra test` and `ludra review` are all clean.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down.
- Jump height = jumpSpeed² / (2 · gravity). The defaults (680, 1800) give about 128px.
- Collectibles, hazards and goals need `"sensor": true` on their body.
- Moving platforms and enemies are kinematic bodies with a `patrol`. Players standing on a moving platform are carried.
- A jump only triggers on a new press, so put a segment without jump between two jump segments.
- The game has 3 lives (`world.lives`); the lantern is a `checkpoint`, placed where the player already stands before a hard part.
- A level is done when a test proves `won == true` with `deaths == 0`. Add a level: copy a scene, point the last flag's `next` at it, and give it its own tests.
- For more than sprites (lighting, glow, your own HUD, fonts, shaders), scripts can have `draw` and `drawUI` hooks with the real Canvas 2D context, and the scene can set `"fonts"` and `"postfx"`. See `npx @ludra/cli components script`.
- For a game that is about physics (stacking, ropes, hinges, rolling, vehicles), set `"physics": "rapier"` in `"world"`: rotation, round and free shapes, friction, mass and joints. See the skill's physics section and `npx @ludra/cli components body` / `joint`.
- The scene has its own `"sounds"` (used by `effects`) and `"music"` (tracks of notes). Change them with the game's mood; `npx @ludra/cli components sounds` shows every field. A script's `sound` hook gets the real Web Audio API for sound that follows the game.
- Art and effects never change gameplay. Make it playable first, then dress it. Write new art as SVG in `assets/`.
- For behavior no component provides (chasing, keys, timers, shooting), write a script and attach it with a `script` component. Use `world.random()`, never `Math.random()`, and test what it does through `self.state` and `world.emit`.
