# {{name}}

A game built with Ludra, a game engine designed for AI agents.

## Layout

- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level. Entities are made of components; `effects` adds particles, sound and shake to game events.
- `assets/`: SVG art. Spritesheets are frames side by side; tiles repeat.
- `scripts/`: custom game logic in TypeScript (create it when needed). Run `npx @ludra/cli components script` for the API.
- `tests/*.test.json`: gameplay tests, run headlessly

## Loop

1. Edit `scenes/main.scene.json`. Run `npx @ludra/cli components` for every component and field, and `npx @ludra/cli blocks` for ready-made pieces you can drop in with `npx @ludra/cli add <block> --at x,y`.
2. Run `npx @ludra/cli check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx @ludra/cli play --inputs "right:1s, jump:0.4s" --ascii` to see what actually happens. Add `--screenshot 0.5s,end` to save real rendered frames to `screenshots/` and look at them.
4. Write the behavior you want into `tests/*.test.json` and run `npx @ludra/cli test`.
5. Run `npx @ludra/cli dev` so a human can play it in the browser.

Never call a change done until `ludra check` and `ludra test` both pass.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down.
- Jump height = jumpSpeed² / (2 · gravity). The defaults (680, 1800) give about 128px.
- Collectibles, hazards and goals need `"sensor": true` on their body.
- Moving platforms and enemies are kinematic bodies with a `patrol`. Players standing on a moving platform are carried.
- A jump only triggers on a new press, so put a segment without jump between two jump segments.
- The level is done when a test proves `won == true` with `deaths == 0`.
- For more than sprites (lighting, glow, your own HUD, fonts, shaders), scripts can have `draw` and `drawUI` hooks with the real Canvas 2D context, and the scene can set `"fonts"` and `"postfx"`. See `npx @ludra/cli components script`.
- Art and effects never change gameplay. Make it playable first, then dress it. Write new art as SVG in `assets/`.
- For behavior no component provides (chasing, keys, timers, shooting), write a script and attach it with a `script` component. Use `world.random()`, never `Math.random()`, and test what it does through `self.state` and `world.emit`.
