# {{name}}

A 3D game built with Ludra, a game engine designed for AI agents: Sky Islands. Hop between floating islands above a sea of clouds, collect five sky crystals, ride the raft across the widest gap, avoid (or stomp) the storm puff and step through the portal.

## Layout

- `ludra.json`: project config (name, entry scene, window size).
- `scenes/main.scene.json`: the level. `"world": { "dimensions": 3 }` makes it 3D: metres, +y up, +z toward the camera, gravity 9.81, Rapier 3D physics. `"environment"` sets the sky gradient, fog and tone mapping; `"sounds"` and `"music"` are the game's own.
- `scripts/` (all presentation; tests never run them):
  - `hero.ts` (the hero's face and scarf, a render hook).
  - `clouds.ts` (the cloud sea, one InstancedMesh).
  - `beacon.ts` (the checkpoint lights up when reached).
  - `portal.ts` (motes swirl in once enough crystals are found).
  - `hud.ts` (hearts, crystals, title card, end screens, a drawUI hook).
- `tests/gameplay.test.json`: each mechanic on its own, and the full route.

## How the 3D pieces work

- **The player** has a `character` component on a dynamic capsule body.
  - Left/right walk along x; up/down along z, where up walks away from the camera (toward -z).
  - It faces where it walks.
  - Defaults: speed 5 m/s, jumpSpeed 7 m/s (a 2.5 m jump).
  - Slopes up to `maxSlope` and steps up to `stepHeight` are walked over.
  - It pushes dynamic bodies and rides moving platforms.
- **Islands** are static cylinder bodies with a `mesh`; the rock hanging under each is a mesh-only entity (no body). A `mesh` with `"shape": "auto"` takes its body's shape and size.
- **Crystals** are sensor bodies with `collectible`, and two tweens make them turn and bob.
- **The raft** is a kinematic box with a `patrol` along z, whose ends overlap each shore so the player can step on and off at the ends.
- **The storm puff** is a kinematic sensor sphere with `hazard` (`stompable`) and a patrol along x.
- **The beacon** is a `checkpoint`.
- **The portal** is a `goal` that needs 5 crystals.
- **Falling** below `world.fallLimit` (-12) costs a life and respawns the player at the start or the last checkpoint.
- **Light:** a `directional` sun with shadows (`shadowSize` metres around what the camera watches) and a `hemisphere` sky fill.
- **The camera** is a `camera3d` in `"follow"` mode: behind the player and above, never turning with it, smoothed.

## Loop

1. Edit the scene or a script. `npx @ludra/cli components` lists every component; `components mesh`, `light`, `camera3d`, `character` and `components script` (the render hook) cover 3D.
2. `npx @ludra/cli check` after every edit.
3. `npx @ludra/cli play --inputs "up:1s, up+jump:0.6s, up:1s" --watch player --every 0.25s` shows x, y and z. Add `--screenshot 1s,end` to see real frames, and `--debug` for colliders.
4. Find timings by sweeping: run `play` with a few values (a wait before boarding the raft, the moment of a jump) and keep the middle of the window that works. Hold a direction through a jump: with no key held, the player stops moving sideways, even in the air.
5. Write the behavior into `tests/*.test.json`, run `npx @ludra/cli test`, then `npx @ludra/cli review` and `npx @ludra/cli dev`.

Never call a change done until `ludra check`, `ludra test` and `ludra review` are all clean.

## Rules of thumb

- Sizes are metres: a person is about 1.8 m tall, a crate 1 m. Jump height = jumpSpeed² / (2 · gravity).
- Jumps between islands: with the defaults a running jump crosses about 7 m on the level, about 6 m when landing 1 m higher. Design gaps at about 60% of that.
- Masses are kilograms (density × volume, density 1 by default), so an impulse is mass × the speed change you want: `other.applyImpulse({ y: 12 * other.mass })` launches anything up at 12 m/s.
- Kinematic platforms move by velocity (patrol, tween), so riders are carried; static bodies never move.
- Looks have no limits. A script's `render` hook gets the real three.js (`ctx.THREE`), the scene, the camera, the renderer and its own group that moves with the entity. Build custom meshes, shaders, particles and instancing there. `ctx.addon("postprocessing/UnrealBloomPass.js")` loads any three.js addon, and `ctx.setRender(fn)` draws the frame yourself (bloom, depth of field, outlines).
- Sound has no limits either: `"sounds"` and `"music"` in the scene, or the Web Audio API in a script's `sound` hook. Run `npx @ludra/cli components sounds`.
- Art never changes gameplay: render, draw and sound hooks are read-only, so tests stay valid.
