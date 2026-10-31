# Moonlit Shrine

A 3D game built with Ludra, a game engine designed for AI agents. Night over a still lake: a hooded wanderer carries a lantern along a path of floating stones toward a moon gate, gathering the six shards of the moon. Stepping stones, two pillars that rise and sink out of step, a vermilion gate that keeps a spirit lantern (the checkpoint), a wisp guarding the bridge, a spirit spring that throws the wanderer up to the sanctum, and the gate itself, which opens only when every shard is back.

## Layout

- `ludra.json`: project config (title, entry scene, window size).
- `scenes/main.scene.json`: the level. `"world": { "dimensions": 3 }` makes it 3D (metres, +y up, -z away from the camera). `"environment"` sets the night sky gradient, fog and tone mapping; `"sounds"` and `"music"` are the game's own (a slow D-minor pentatonic theme).
- `scripts/`:
  - `spring.ts`: the only gameplay script. Touching the spring sets the player's `vy` to `params.launch` (12.5 m/s), counts `state.launches` and emits `spring`. Its render hook draws the pool, the rune and the rising motes.
  - Everything else is presentation (render, drawUI), so tests never depend on it:
    - `sky.ts`: stars (a shader), the low moon and its halo, the mountain ring, and the bloom post-processing chain (`params.bloom`).
    - `lake.ts`: the water shader (sky reflection, moon path, haze), floating paper lanterns and lily pads.
    - `stone.ts`: paving tiles, moss and rune lines on each slab; a ring of light on round stones.
    - `pillar.ts`: glowing bands that brighten while a pillar rises and dim as it sinks.
    - `shard.ts`, `lantern.ts`, `shrine.ts` (the torii and its spirit lantern), `wisp.ts`, `gate.ts` (sockets per shard, the veil opens at 6), `wanderer.ts` (the player), `fireflies.ts`.
    - `hud.ts`: flames for lives, crescents for shards, the title card, controls, notes and end screens.
- `tests/gameplay.test.json`: each mechanic on its own, the timing window of the pillars, and the full route.

## The route

| Piece | Where | How it works |
| --- | --- | --- |
| Plaza | z 4 .. -4, top 0 | Start. Shard 1 on the way out. |
| Stepping stones | z -10, -17, -23.5 | Round slabs 3.4 m wide, 0.5 m higher each time. Jump right after each landing. Shard 2 floats over the first gap and is caught mid-jump. |
| Terrace | z -27 .. -33, top 1 | Shard 3 sits to the right. |
| Pillars | z -37.5 and -43 | Kinematic cylinders with a `tween` on y (3 m, 1.8 s, pingpong), out of step. Shard 4 is above pillar 1. |
| Bridge | z -45.5 .. -57.5, top 2.5 | Only reachable while pillar 2 is up. Torii checkpoint at z -47, wisp (`hazard`, `stompable`, `patrol` on x) at z -51.5, shard 5, then the spring. |
| Sanctum | z -60.5 .. -68.5, top 8 | Shard 6 to the right, the moon gate (`goal`, `requireScore: 6`) at the back. |

Falling below `world.fallLimit` (-9) costs a life; three lives in all.

## Before any art

Decide the look in `game.md` first, and make it this game's own: what comes with a project is only an example, and the easy path gives a game that looks like every other. `## Promise` says what a player remembers; `## Look` has `- style:`, `- type:` and `- palette:`. One strong constraint does more than many effects: for example `"window": { "width": 480, "height": 270, "pixelated": true }` in `ludra.json` with `ctx.pixelText` for text gives hard pixels throughout, and a theme per level (walls, accent, light) tells a player where they are from one frame.

## Loop

1. Edit the scene or a script. `npx @ludra/cli components` lists every component; `components mesh`, `light`, `camera3d`, `character` and `components script` cover 3D.
2. `npx @ludra/cli check` after every edit (it also runs every render hook once in Node, so no `document` or canvas in render hooks: compute textures into a `THREE.DataTexture`).
3. `npx @ludra/cli play --inputs "up:1.1s, up+jump:0.6s, up:0.9s" --watch player,pillar-1 --every 0.25s`, and `--screenshot 4.5s,15s` to see real frames.
4. Find timings by sweeping a wait before a jump and keeping the middle of the window that works. The pillar-to-bridge jump works for waits of 0.1 to 1.1 s in the test route and fails for 1.3 to 1.9 s.
5. `npx @ludra/cli test`, `npx @ludra/cli review --strict`, then `npx @ludra/cli dev` to play.

Never call a change done until `check`, `test` and `review` are all clean.

## Rules of thumb

- With speed 5 and jumpSpeed 7, a running jump covers about 7 m on the level and 6.5 m landing 0.5 m higher; it rises 2.5 m.
- Hold a direction through a jump: with no key held the wanderer stops moving sideways, even in the air.
- Point lights are the night's budget: each lantern, shard, wisp and the player's own lantern carries one. Keep them small (distance under 10 m) and without shadows; only the moon casts shadows.
- Keep emissive and light intensities moderate: the bloom pass turns anything bright into glow, and too much of it washes the frame out.
