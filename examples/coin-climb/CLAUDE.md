# coin-climb

A game built with Ludra, a game engine designed for AI agents.

## Layout

- `ludra.json`: project config (name, entry scene, window size)
- `scenes/main.scene.json`: the level. Entities are made of components.
- `tests/*.test.json`: gameplay tests, run headlessly

## Loop

1. Edit `scenes/main.scene.json`. Run `npx ludra components` for every component and field.
2. Run `npx ludra check` after every edit. Each problem names the JSON path and a fix.
3. Run `npx ludra play --inputs "right:1s, jump:0.4s" --ascii` to see what actually happens.
4. Write the behavior you want into `tests/*.test.json` and run `npx ludra test`.
5. Run `npx ludra dev` so a human can play it in the browser.

Never call a change done until `ludra check` and `ludra test` both pass.

## Rules of thumb

- Coordinates are entity centers in pixels; +y is down.
- Jump height = jumpSpeed² / (2 · gravity). The defaults (680, 1800) give about 128px.
- Collectibles need `"sensor": true` on their body.
- A jump only triggers on a new press, so put `wait:0.1s` between two jump segments.
