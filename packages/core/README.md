# @ludra/core

The runtime of [Ludra](https://github.com/ersingvn/ludra), the game engine built for AI agents. Most people want the [`@ludra/cli`](https://www.npmjs.com/package/@ludra/cli) command instead; use this package to embed the engine.

- **Scene format and validation:** `validateScene(json)` returns diagnostics with a JSON path and a concrete fix.
- **Deterministic simulation:** `new World(scene)` advances only through `world.step(heldActions)` at a fixed 60 Hz.
- **Headless testing:** `InputScript.parse("right:1s, jump:0.4s")`, `simulate(...)`, `runTest(scene, { inputs, assert: ["won == true"] })` and `renderAscii(world)`.
- **Browser runtime** (`@ludra/core/browser`): `startGame(canvas, scene, { assetBase })` adds sprites, animations, particles, sound and keyboard input. It never changes what the simulation does.

```ts
import { InputScript, simulate, World } from "@ludra/core";

const world = World.fromJSON(sceneJson); // throws with diagnostics if invalid
simulate(world, InputScript.parse("right:0.5s, right+jump:0.45s"), 120);
console.log(world.snapshot());
```

Zero dependencies. Requires Node.js 22.18 or newer, or any modern browser. MIT licensed.
