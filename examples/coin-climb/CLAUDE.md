# coin-climb

A game built with Ludra, a game engine designed for AI agents.

## Layout

- `game.md`: what this game means to be and look like
- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level. Entities are made of components; `effects` adds particles, sound and shake to game events, and `sounds` and `music` are the game's own.
- `assets/`: SVG art. Spritesheets are frames side by side; tiles repeat, and `"variants"` mixes in more cells so the grid doesn't show.
- `scripts/`: `sunset.ts` (the desert backdrop), `shrine.ts` (the shrine's glow once all coins are found) and `hud.ts` (coin slots, title card, end screen). All presentation: tests never depend on them.
- `tests/*.test.json`: gameplay tests, run headlessly

## Before any art

Decide the look in `game.md` first, and make it this game's own: what comes with a project is only an example, and the easy path gives a game that looks like every other. `## Promise` says what a player remembers; `## Look` has `- style:`, `- type:` and `- palette:`. One strong constraint does more than many effects: for example `"window": { "width": 480, "height": 270, "pixelated": true }` in `ludra.json` with `ctx.pixelText` for text gives hard pixels throughout, and a theme per level (walls, accent, light) tells a player where they are from one frame.

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
- Collectibles need `"sensor": true` on their body.
- A jump only triggers on a new press, so put `wait:0.1s` between two jump segments.
