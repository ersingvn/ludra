# Architecture

Ludra has one design rule: **anything a human would check by looking at the screen, an agent must be able to check from text.**

## Packages

### `@ludra/core` (zero dependencies)

| File | Responsibility |
| --- | --- |
| `components.ts` | The component table. It is the single source of truth: validation, defaults and `ludra components` are generated from it. |
| `validate.ts` | Turns raw JSON into diagnostics: code, JSON path, message and a concrete fix. Typos get "did you mean" suggestions. |
| `world.ts` | The simulation. A `World` advances only through `step(input)`, at a fixed 60 Hz, with no randomness or wall-clock time. |
| `input.ts` | Input scripts such as `"right:1s, jump:0.4s"` for headless runs. |
| `simulate.ts` | Runs a world against a script. |
| `assertions.ts` | Parses and evaluates `"<subject> <op> <value> [at <time>]"` and runs test cases. |
| `ascii.ts` | Draws a frame as text so agents can see layout and positions. |
| `effects.ts` | Scene `effects` schema, sound presets, and `collectAssetPaths` (every image and audio file a scene references). |
| `browser.ts` | Canvas renderer and keyboard input for humans. It uses the same `World`, so tests and play match. Draws sprites, spritesheet animations and tiles, and turns world events into effects. `captureFrames` runs the same view deterministically for screenshots. |
| `postfx.ts` | Runs a scene's GLSL fragment shader over each rendered frame (WebGL). |
| `drawcheck.ts` | Runs `draw`/`drawUI` hooks against a mock canvas for `ludra check`. |
| `particles.ts` | Seeded, visual-only particle system for effect bursts and `emitter`s. |
| `audio.ts` | Web Audio sound player: synthesized presets plus audio files. |

`browser.ts` is a separate entry point (`@ludra/core/browser`) so Node code never loads DOM code.

### Scripts

`script.ts` defines the API scripts see (`Script`, `ScriptContext`, `ScriptEntity`, `ScriptWorld`) and `ScriptError`. Core never imports script files itself. Hosts load them and pass the modules in, with `new World(scene, { scripts })`:

- **CLI:** `loadGame` in `project.ts` imports each script with Node's built-in type stripping. It loads every file the scene references plus all of `scripts/`, so `world.spawn` can attach any of them, and turns load problems (syntax errors with line and caret, forbidden imports, misspelled hooks) into diagnostics.
- **Browser:** the server serves those same files type-stripped at `/__ludra/script/`, and `startGame` and `captureFrames` import them.

In a frame, scripts run after player input (`platformer`, then `topdown`) and before patrols and physics (`start` once, then `update`). `touch` runs after physics, for bodies that started overlapping or touching within 1px. Scripts see entities through stable handles whose setters write straight to the entity. Per-entity data lives in `entity.state`, which snapshots copy, so tests can assert on it. `world.random()` is seeded by `world.seed`, which keeps scripted runs deterministic as long as scripts avoid `Math.random` and `Date`, as the skill instructs. Hook errors are rethrown as `ScriptError` with file, entity, hook and frame; `runTest` turns them into a failed test.

### Presentation is a one-way street

Everything visual or audible reads from the `World` and never writes to it. Effects react to `world.events` (which carry the position where they happened), animations derive from velocity and `grounded`, and particles use their own seeded random numbers. So adding art or effects can never change what `ludra test` verifies, and a test asserts exactly this.

### Drawing in code

Scripts can have `draw` (world space, ordered with sprites by `sprite.layer`) and `drawUI` (screen space) hooks, called by `View.draw` through `World.callDrawHook` with the real Canvas 2D context. While one runs, `World.drawing` is set: handle setters and mutating world methods call `guard()` and throw, and `state` is a frozen copy, so presentation can never change the simulation. Each call is wrapped in `save`/`restore`. Per-entity presentation memory (`ctx.local`) lives in the `View` and resets with it. If any entity has `drawUI`, the default HUD and win screen are skipped. `checkDrawHooks` (used by `ludra check`) runs the hooks in Node against a Proxy that accepts any canvas call, at a few frames of an idle run.

Scene `fonts` load before the game starts (Google Fonts CSS or FontFace, capped at 4 s). With `postfx`, `prepare()` compiles the shader (`postfx.ts`) on a WebGL canvas that replaces the page's canvas; the game keeps drawing into the original, now offscreen, canvas, and each frame is uploaded as a texture and drawn through the shader. Shader errors keep the 2D canvas visible and show the compiler message with the shader file's own line numbers (`#line 1` after the engine's header).

### Camera and tweens

The camera (`camera.ts`) is a pure function of the entities, `cameraGoal`, plus a `CameraRig` that eases between goals when the zone changes. The `View` advances the rig once per simulation step, so a screenshot of a given frame always frames the same view. Camera zones never touch the `World`.

Tweens (`tween.ts`) are simulation state on the entity: `World.updateTweens` runs after patrols and before physics. It starts tweens whose `on` event fired since the last step, then eases each one. A moving `x`/`y` on a non-static body becomes the velocity that lands it on this step's value (so physics moves it and riders are carried, like a patrol), followed by one step at rest when it finishes; everything else is written directly. Each pass waits out `delay`, then runs `duration`; the time that overshoots a pass carries into the next.

### Sound

`audio.ts` holds the `SoundPlayer`. Its graph is master gain (mute) → a compressor → the speakers, with two inputs: a per-scene bus and the music. `setScene` replaces the bus on every scene start and restart (the old one fades out, taking any script nodes with it), and keeps music playing when the next scene has the same music (compared as JSON), otherwise crossfades. A sound name resolves to the scene's own `sounds` first, then a preset, then a file. Sound definitions (`sound.ts`) are tone and noise layers with envelopes; noise comes from one shared 2 s buffer started at a random offset. Music tracks are parsed by `parseNotes` (shared with validation, so `ludra check` reports a bad token with its position) and scheduled 0.25 s ahead each frame, each track looping on its own.

The `sound` hook runs in `startGame`'s frame loop after the simulation steps, once the audio context is unlocked, through `World.callSoundHook`: the same read-only guard as draw hooks, with `ctx.audio`, `ctx.out` (the scene bus) and the events since its last call. `checkDrawHooks` runs it too, against the same accept-anything Proxy standing in for the AudioContext. Audio never runs headless, so tests are unaffected.

### Game structure

`validateScene` expands tilemaps first (`tilemap.ts`): each `tilemap` component is removed and the cells it describes are appended after the scene's own entities (so error paths into the file stay right), as merged static rectangles (horizontal runs, then identical runs stacked) or prefab placements. Then it expands prefabs, including the ones tilemaps placed: an entity with `"prefab"` gets the prefab's components with its own merged over them (`mergeComponents`, one level deep, `null` removes), so everything after it, and the `World`, only sees plain entities. The expanded scene keeps its `prefabs` map, so `world.spawn({ prefab })` works at runtime. The CLI adds `prefabs/*.prefab.json` to every scene it reads.

`World.over` (won, lost, or `exit` set) stops the simulation. Deaths cost `lives` when the scene has them; the last one sets `lost` and fires `gameover` without respawning. A checkpoint moves the player's `spawn` once per player. A goal's `next` and `world.goto` set `exit`: headless runs simply end there (each scene is tested on its own), while `startGame` with a `loadScene` option shows the win screen or fades, loads the next scene and builds a new `World` with `carry` (score, deaths, lives).

### `ludra` (CLI)

The CLI is a thin layer over core: project loading (`ludra.json`), output formatting (`--json` everywhere), templates and the dev server. `ludra check` adds file-system checks core can't do, such as `E_ASSET_MISSING`.

`gltf.ts` reads .glb and .gltf files without dependencies:
- `readModel` gives a `ModelSummary`: bounds through the node transforms, triangles, materials, skins, clips with durations, required extensions and external files.
- `readModelGeometry` gives every triangle in scene-root space. It follows `byteStride`, normalized integers, `data:` URIs and external `.bin` files, and refuses Draco and meshopt with the extension's name.

`ludra inspect` (`commands/inspect.ts`) prints that summary with a ready `"mesh"` line, and also reads image sizes from headers and WAV durations. `readScene` uses the same reader for model diagnostics. It caches each model by path, mtime and size, and reports:
- `E_MODEL_INVALID`: the file can't be read.
- `E_MODEL_FILE_MISSING`: a `.bin` or texture isn't next to the `.gltf`.
- `E_MODEL_ANIMATION`: a clip name the model lacks, with a did-you-mean and the real list.
- `W_MODEL_EXTENSION`: a required extension the renderer can't load.

Prefab meshes are checked once, on the prefab.

`server.ts` serves a project to a browser: the engine's browser module (type-stripped on the fly when running from source; no bundler), the validated scene, and only media files from the project. `ludra dev` puts a game page in front of it and reloads when the scene or any asset changes.

### Review

`commands/review.ts` loads every scene, runs every test (`runTest` reports the events each run fired) and reads the scripts' sources. It reports findings by area (proof, feel, looks, identity) as issues or ideas: no passing win test without deaths, a script with gameplay hooks whose entities and emitted events no assertion mentions, important events that fired with no `effects` entry and no `recent("…")` in a draw hook, no `drawUI`, no backdrop, sprites without art, no postfx. It's heuristic on purpose: it can't judge beauty, but it reliably catches the signs of unfinished work. `--strict` exits 1 on issues; CI runs it on the templates.

### Blocks

`blocks.ts` reads the library in `packages/cli/blocks/` (shipped in the npm package). `placeBlock` turns a block's entity templates into entities: transforms are offsets from the `--at` anchor, `{id}` is replaced by a prefix that doesn't clash with the scene (`turret`, `turret-2`…), so linked parts (a key and its door) find each other. `addBlock` copies the block's files without overwriting ones the user changed (unless `--force`), appends the entities and merges only effects the scene lacks. The block test places every block in its `demo.json` level with that same code and runs the demo tests, so the library is verified on every commit.

### Screenshots

`ludra play --screenshot` starts that server on a random port, launches the Chrome, Edge or Chromium already installed in headless mode (`headless.ts` finds it, or uses `LUDRA_BROWSER`), and drives it over the DevTools protocol with Node's built-in WebSocket. The page calls core's `captureFrames`, which steps a `World` and the same view as `startGame` frame by frame with no clock, so a given frame always renders the same. PNGs come back as data URLs and are written to `screenshots/`. No npm dependencies are involved, and the browser and its temporary profile are removed afterwards. In development it type-strips the engine's TypeScript on request, and in a published install it serves the compiled JavaScript.

## Determinism

- Fixed timestep (`FIXED_DT = 1/60`). The browser uses an accumulator to run whole steps.
- No `Math.random` and no `Date.now` in the simulation.
- Input is a set of held actions per step. "Pressed" is derived from the previous step's set, so scripts and keyboards behave identically.

## Physics

Bodies are moved by a `PhysicsEngine` (`physics.ts`): it is told about every created and removed entity, advances all bodies one fixed step, and answers overlap queries. Gameplay in `World` (platformer and top-down controls, patrols, pickups, hazards, goals, checkpoints) only talks to bodies through their velocities, `grounded`/`standingOn` and `overlaps`, so engines can be swapped without changing a game's rules. The entity's transform is the source of truth between steps, so gameplay can teleport an entity (a respawn) and the engine follows. `new World(scene, { physics })` takes any engine.

### Arcade (default, `arcade.ts`)

Axis-aligned boxes. Dynamic bodies integrate gravity, then move and resolve along x, then along y, against static and kinematic solids. Top-down movers skip gravity, and a kinematic top-down body (a paddle) is pushed out of static walls; other kinematic movers pass through. `body.bounce` reflects the velocity on the axis that hit (`-v · bounce`) and emits a `bounce` event; rebounds slower than 40 px/s stop instead, so bouncing things come to rest. This is simple on purpose: predictable, easy to explain to an agent, and tight enough for classic platformers.

### Rapier (`@ludra/physics`)

A scene opts in with `"world": { "physics": "rapier" }`. Engines are found by name in a registry (`engines.ts`, shared through `globalThis` so a second copy of the module still sees it); core only knows arcade, and `loadRapierPhysics()` from `@ludra/physics` loads Rapier's WebAssembly and registers "rapier". The CLI does that in `loadGame` when a scene asks for it, so arcade games never load Rapier.

`@ludra/physics` wraps Rapier's **deterministic** 2D build (`@dimforge/rapier2d-deterministic-compat`, pinned to an exact version): the same scene gives bit-identical frames on every OS, Node version and browser, which a golden-hash test checks on every CI machine. The "compat" build embeds the WebAssembly in one file, so it loads without a bundler. Rapier works in pixels directly (`lengthUnit` = 50 px per meter tunes its tolerances). Each step hands gameplay's changes to Rapier (a moved transform is a teleport, dynamic velocities are written, kinematic bodies move by velocity and patrol limits), steps, and reads positions, accumulated rotation (not wrapped to ±180°) and velocities back. A body is grounded when a non-sensor contact pushes it upward; sensors use Rapier's intersection test. Restitution combines with "max", so `bounce` means the same as in arcade.

Rapier runs with its natural +y up and every value crossing over is mirrored in y (positions, velocities, gravity, angles): its character controller only applies slope limits correctly that way (with a custom "up" of (0, -1) a player walks up any slope).

Players (`platformer` or `topdown` with a moving body) are kinematic bodies moved by Rapier's character controller rather than by forces: they walk up slopes up to `platformer.maxSlope` and slide back from steeper ones, step onto ledges up to `stepHeight`, slide along walls instead of sticking, and push dynamic bodies in proportion to `push`. Gravity, jump speed and the fall-speed cap keep their arcade values, so jumps reach the same height. Three details came from testing: gravity isn't applied while a player stands (pressing into the ground makes round-bottomed players lose speed), players are lifted by the controller's gap when created or respawned (one placed exactly in contact can't keep its gap and sinks in), and players standing on a kinematic mover are carried by the mover's last displacement (the controller doesn't carry a standing character on its own).

Every engine also answers `mass`, `applyImpulse`, `angularVelocity` and `raycast`, which scripts reach as `self.applyImpulse/applyForce/mass/angularVelocity` and `world.raycast`. Arcade gives the simple versions (velocity += impulse / mass, no spin, a slab test against boxes); rapier uses the real ones (impulses at a point spin bodies, rays hit rotated and round shapes). `world.physics.raw` hands scripts Rapier itself (`RAPIER`, the world, each entity's body, collider and joint, and y-flip helpers), so nothing Rapier can do is out of reach; like every mutating call it throws inside draw hooks.

The `joint` component is created once both its ends exist (a target can be spawned later). The other body, or an invisible fixed body for a point in the world, is Rapier's first body, so the joint measures this body relative to it: limits and motor speeds keep Ludra's clockwise sign after the y-flip. Hinges, sliders and welds join both bodies at the same point (`anchor` on this body); ropes and springs run to `toAnchor`.

In the browser the dev server serves `@ludra/physics` and Rapier's single-file module, and its pages carry an import map for `@ludra/core` and Rapier, so the same unbundled modules load as in Node. `startGame` and `captureFrames` take a `loadPhysics` hook and call it only for scenes that name an engine other than arcade, so arcade games never download Rapier. Sprites draw rotated about their centers; a sprite without an image follows its body's shape (circle, capsule). The debug view (`play --screenshot --debug`, or the backquote key in `ludra dev`) draws every collider in its true shape and rotation, sensors dashed, velocities, joints, grounded players and entity ids over the frame, so an agent can check the art against the physics.

## 3D

A scene with `"world": { "dimensions": 3 }` uses the same `World`, components, events and tests as 2D, in metres with +y up. `resolveTransform` turns a `{ x, y, z }` rotation into `rotationX`, `rotationY` and `rotation` (around z), applied y, x, z; snapshots carry `z`, `vz` and non-zero rotations only in 3D, so 2D frames hash exactly as before. Validation keeps the two apart (2D shapes and controllers in 3D, 3D fields in 2D).

### Rapier 3D (`packages/physics/src/rapier3d.ts`)

`physicsEngineName` sends every 3D scene to "rapier3d", which `loadRapier3DPhysics()` registers after a dynamic import, so 2D never loads its WebAssembly. Rapier's frame is Ludra's (no mirroring). Rotations cross as quaternions, built and read with core's `dmath` (sin, cos, atan2 and asin from IEEE-exact operations: V8's `Math.atan2` differs in the last bit on macOS ARM). Only dynamic bodies are read back from Rapier; kinematic bodies and characters stay exactly where gameplay put them (Rapier stores 32-bit floats). An entity's velocity is written to Rapier only when gameplay changed it, so velocities set through `world.physics.raw` survive.

Players with `character` move through Rapier's character controller. Gravity applies only while not touching the ground; a standing player keeps grounded for 3 steps after losing contact; what it stands on comes from a short ray down from its feet (snapping reports no contact); and it is kept a little above the controller's gap (`GROUND_GAP`), since a hair inside it blocks every step on kinematic platforms. A moving platform's displacement is added to its rider directly, not through the controller.

### Rendering (`packages/three`)

`startGame` and `captureFrames` ask `options.loadRenderer3D` for a `Renderer3D` when a scene is 3D. `ThreeRenderer` keeps a Three.js object per entity with a `mesh` or `light`, syncs transforms each frame, and moves a camera rig (follow, orbit, first person, fixed) once per simulation step. The sun's shadow area follows the rig's focus. Its WebGL canvas is copied into the game's 2D canvas (`preserveDrawingBuffer`), where the View draws the HUD and `drawUI` hooks and the postfx shader runs, so screenshots need nothing new. Render hooks run right before each frame through `World.callRenderHook`, with the same read-only guard as draw hooks. `ctx.addon` imports from `three/addons/` (mapped by the dev server's import map), and `settle()` lets screenshots wait for those imports.

### Models

`mesh.model` names a glTF file. `ThreeRenderer` loads every model the scene and its prefabs name before the first frame (so screenshots are complete), with `GLTFLoader` plus the Draco and meshopt decoders from three's addons. A model a spawned entity names later draws as an empty stand-in until it loads. A file that fails to load falls back to the mesh's shape, with one console warning.

Each entity gets its own copy, made with `SkeletonUtils.clone` so skinned meshes keep their bones:
1. The copy is turned by `turn`.
2. Its box is measured and fitted. `"height"` scales it evenly to the mesh's (or body's) height; `"box"` stretches it to width, height and depth; `"none"` keeps its metres.
3. Unless the fit is `"none"`, it is centred on x and z, and its lowest point is put at the bottom of the body.
4. Then `scale` and `offset` apply.

The fit lives on a pivot group inside the entity's object, so render hooks can still move `ctx.model.root`.

Animation is deterministic. In `step()`, once per simulation step, the renderer asks `chooseClip` which clip each entity should play. The order is:
1. A script's `state.animation`.
2. `mesh.animation`.
3. `mesh.animations` for its movement state: jump while rising in the air (once, holding the last pose), fall otherwise in the air, walk below 60% of `character.speed`, run above it, idle under 0.3 m/s.

When the clip changes, the renderer records it with its start time, keeping the newest two. Each frame, the pose is a pure function of simulation time and that history: the current clip from its start, crossfading out of the previous one over `fade`, scaled by `animationSpeed`. The mixer is then evaluated at that moment, so a screenshot of a frame always shows the same pose as live play. A clip a model lacks warns once per entity and clip. Render hooks get `ctx.model` (`root`, `clips`, `mixer`) after the pose is set.

Colliders can come from models too. A `convex` or `mesh` body without its own `points` (and, for `mesh`, `triangles`) takes its geometry from `body.model`, or from `mesh.model` when that is `""`. The CLI's `fillModelColliders` (`colliders.ts`) builds it while reading the scene:
- It reads `readModelGeometry` and fits it exactly as the renderer fits the drawn model.
- It writes plain `points` and `triangles` into the scene JSON.

Physics only ever sees numbers, so headless runs and the browser use identical colliders. `mesh` shapes are trimeshes, static or kinematic only (`E_MESH_DYNAMIC`). Procedural terrain is the same `points` and `triangles` written directly. Entities created by `world.spawn` with inline components never pass through the CLI, so they need a prefab for a model collider.

## Development

```bash
npm install
npm test           # node --test, runs TypeScript directly
npm run build      # tsc -b, type-checks and emits dist/
npm run ludra -- <command>
```

The `ludra-dev` export condition points package imports at `src/*.ts`, so Node (22.18 and newer) runs the TypeScript sources without a build step.
