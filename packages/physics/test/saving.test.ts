import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { InputScript, validateScene, World, type EntityDef, type Script } from "@ludra/core";
import { loadRapier3DPhysics, loadRapierPhysics } from "../src/index.ts";

/**
 * World.save and World.restore must give back the exact future: a run restored to a moment and
 * played on is bit-identical to one that never stopped, however far another future went first.
 */

function build(raw: unknown, scripts?: Map<string, Script>): () => World {
  const { scene, diagnostics } = validateScene(raw);
  assert.ok(scene, JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2));
  return () => new World(scene, { scripts });
}

/** Steps `world` up to frame `until` with `script`, hashing every frame and the events after. */
function play(world: World, script: InputScript, until: number, hash?: ReturnType<typeof createHash>): void {
  while (world.frame < until) {
    world.step(script.at(world.frame));
    hash?.update(JSON.stringify(world.snapshot()));
  }
}

function checkRestore(make: () => World, inputs: string, saveAt: number, total: number): void {
  const script = InputScript.parse(inputs);
  const detour = InputScript.parse("left+jump:0.5s, right:0.5s, up+jump:0.5s, down:0.5s");

  const reference = make();
  play(reference, script, saveAt);
  const expected = createHash("sha256");
  play(reference, script, total, expected);
  const expectedHash = expected.update(JSON.stringify(reference.events)).digest("hex");

  const world = make();
  play(world, script, saveAt);
  const atSave = JSON.stringify(world.snapshot());
  const save = world.save();
  // Two different futures first, then back each time.
  for (const other of [detour, script]) {
    play(world, other, saveAt + 150);
    world.restore(save);
    assert.equal(JSON.stringify(world.snapshot()), atSave, "restoring gives back the saved moment");
  }
  const actual = createHash("sha256");
  play(world, script, total, actual);
  assert.equal(actual.update(JSON.stringify(world.events)).digest("hex"), expectedHash, "the future after a restore is the one that never stopped");
}

/** A script that spawns a coin every half second at a seeded random height, and counts them. */
const spawner: Script = {
  update({ self, world }) {
    const n = (self.state.spawned as number | undefined) ?? 0;
    if (world.frame % 30 === 0) {
      world.spawn({ components: { transform: { x: 200 + n * 40, y: 300 + world.random() * 100 }, body: { type: "static", width: 16, height: 16, sensor: true }, collectible: { score: 1 } } });
      self.state.spawned = n + 1;
    }
  },
};

describe("saving and restoring worlds", () => {
  before(async () => {
    await loadRapierPhysics();
    await loadRapier3DPhysics();
  });

  test("arcade: players, patrols, tweens, pickups, spawns and script state come back exactly", () => {
    const walls = [{ id: "ground", components: { transform: { x: 480, y: 520 }, body: { width: 960, height: 40 } } }];
    const entities: EntityDef[] = [
      ...walls,
      { id: "hero", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } },
      { id: "slime", components: { transform: { x: 500, y: 486 }, body: { type: "kinematic", width: 30, height: 28, sensor: true }, patrol: { distance: 120, speed: 60 }, hazard: { stompable: true } } },
      { id: "lift", components: { transform: { x: 700, y: 400 }, body: { type: "kinematic", width: 80, height: 16 }, tween: { property: "y", to: 300, duration: 1.5, loop: "pingpong" } } },
      { id: "spawner", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/spawner.ts" } } },
    ];
    const make = build({ entities }, new Map([["scripts/spawner.ts", spawner]]));
    checkRestore(make, "right:1s, right+jump:0.4s, right:2s, left:1s, jump:0.3s", 100, 400);
  });

  test("rapier 2D: a pile of crates, rolling balls, a joint and a character controller", () => {
    const entities: EntityDef[] = [
      { id: "ground", components: { transform: { x: 480, y: 520 }, body: { width: 960, height: 40 } } },
      { id: "hero", components: { transform: { x: 240, y: 400 }, body: { type: "dynamic", width: 28, height: 36, shape: "capsule" }, platformer: {} } },
      { id: "ball", components: { transform: { x: 130, y: 150 }, body: { type: "dynamic", width: 24, height: 24, shape: "circle", bounce: 0.8 } } },
      { id: "pendulum", components: { transform: { x: 400, y: 200 }, body: { type: "dynamic", width: 20, height: 20, shape: "circle" }, joint: { type: "revolute", anchor: { x: 0, y: -80 } } } },
    ];
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i <= 3 - row; i++) entities.push({ id: `crate-${row}-${i}`, components: { transform: { x: 560 + i * 42 + row * 21, y: 479 - row * 41 }, body: { type: "dynamic", width: 40, height: 40 } } });
    }
    entities.push({ id: "wrecking", components: { transform: { x: 330, y: 470 }, body: { type: "dynamic", width: 40, height: 40, shape: "circle", density: 6, vx: 700, bullet: true } } });
    checkRestore(build({ world: { physics: "rapier" }, entities }), "right:1.5s, right+jump:0.4s, right:1s, left:1s", 45, 360);
  });

  test("rapier 3D: stacking, rolling, a character, joints and a moving platform", () => {
    const box = (id: string, x: number, y: number, z: number, extra: Record<string, unknown> = {}): EntityDef => ({ id, components: { transform: { x, y, z }, body: { type: "dynamic", width: 1, height: 1, ...extra } } });
    const entities: EntityDef[] = [
      { id: "floor", components: { transform: { x: 0, y: -0.5, z: 0 }, body: { width: 60, height: 1, depth: 60 } } },
      { id: "hero", components: { transform: { x: 0, y: 0.9, z: 6 }, body: { type: "dynamic", width: 0.6, height: 1.8, shape: "capsule" }, character: {} } },
      box("ball", -6, 3, 0, { shape: "sphere", vx: 4, vz: -1, bounce: 0.5 }),
      { id: "bob", components: { transform: { x: 4, y: 5, z: 0 }, body: { type: "dynamic", width: 0.6, height: 0.6, shape: "sphere" }, joint: { type: "spherical", anchor: { x: -2, y: 0, z: 1 } } } },
      { id: "lift", components: { transform: { x: 5, y: 1, z: 4 }, body: { type: "kinematic", width: 2, height: 0.2, depth: 2 }, patrol: { axis: "z", distance: 3, speed: 1.5 } } },
    ];
    for (let i = 0; i < 6; i++) entities.push(box(`crate-${i}`, (i % 3) - 1, 0.5 + Math.floor(i / 3) * 1.01, -2, { friction: 0.6 }));
    checkRestore(build({ world: { dimensions: 3 }, entities }), "up:1s, up+jump:0.4s, up:1.2s, left+up:1s, wait:0.4s", 80, 360);
  });

  test("a save can be restored into the moment it was taken any number of times, and saving needs an engine that can", () => {
    const make = build({ entities: [{ id: "hero", components: { transform: { x: 100, y: 100 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } }] });
    const world = make();
    const save = world.save();
    assert.equal(save.frame, 0);
    for (let i = 0; i < 3; i++) {
      play(world, InputScript.parse("right:1s"), 60);
      world.restore(save);
      assert.equal(world.frame, 0);
      assert.equal(world.get("hero")!.transform.x, 100);
    }
    const stubborn = new World({ entities: [] }, { physics: { ...world.physics, name: "custom", save: undefined, restore: undefined } as never });
    assert.equal(stubborn.canSave, false);
    assert.throws(() => stubborn.save(), /"custom" physics engine can't save/);
  });
});
