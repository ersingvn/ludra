import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef, type SceneDef, type Script } from "@ludra/core";
import { loadRapier3DPhysics } from "../src/index.ts";
import { degreesFromQuaternion, quaternionFromDegrees } from "../src/rapier3d.ts";

const floor: EntityDef = { id: "floor", components: { transform: { x: 0, y: -0.5, z: 0 }, body: { width: 60, height: 1, depth: 60 } } };

function scene(entities: EntityDef[], world: Record<string, unknown> = {}): SceneDef {
  const { scene, diagnostics } = validateScene({ world: { dimensions: 3, ...world }, entities: [floor, ...entities] });
  assert.ok(scene, JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2));
  return scene;
}

function run(s: SceneDef, seconds: number, inputs = "", scripts?: Map<string, Script>): World {
  const world = new World(s, { scripts });
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

/** Every frame of a run, for paths and peaks. */
function trace(s: SceneDef, seconds: number, inputs = ""): World[] & { at: (id: string) => { x: number; y: number; z: number }[] } {
  const frames: ReturnType<World["snapshot"]>[] = [];
  const world = new World(s);
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60), (w) => frames.push(w.snapshot()));
  return Object.assign([world], { at: (id: string) => frames.map((f) => ({ x: f.entities[id]!.x, y: f.entities[id]!.y, z: f.entities[id]!.z! })) });
}

const box = (id: string, x: number, y: number, z: number, extra: Record<string, unknown> = {}): EntityDef => ({
  id,
  components: { transform: { x, y, z }, body: { type: "dynamic", width: 1, height: 1, ...extra } },
});
const hero = (x: number, y: number, z: number, character: Record<string, unknown> = {}): EntityDef => ({
  id: "hero",
  components: { transform: { x, y, z }, body: { type: "dynamic", width: 0.6, height: 1.8, shape: "capsule" }, character },
});

describe("rotations", () => {
  test("degrees and quaternions round-trip, applied y then x then z", () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [20, 30, 0],
      [-45, 170, 10],
      [0, -90, 0],
      [60, 0, -30],
    ]) {
      const r = degreesFromQuaternion(quaternionFromDegrees(x!, y!, z!));
      assert.ok(Math.abs(r.x - x!) < 1e-9 && Math.abs(r.y - y!) < 1e-9 && Math.abs(r.z - z!) < 1e-9, `${[x, y, z]} → ${JSON.stringify(r)}`);
    }
  });
});

describe("rapier 3D bodies", () => {
  before(() => loadRapier3DPhysics());

  test("a crate falls, lands once and rests on the floor", () => {
    const world = run(scene([box("crate", 0, 5, 0)]), 2);
    const c = world.get("crate")!;
    assert.equal(world.physics.name, "rapier3d");
    assert.ok(Math.abs(c.transform.y - 0.5) < 0.01, `rests at y ≈ 0.5, got ${c.transform.y}`);
    assert.equal(c.body!.grounded, true);
    assert.equal(c.body!.standingOn?.id, "floor");
    assert.equal(world.events.filter((e) => e.type === "land" && e.entity === "crate").length, 1);
    const land = world.events.find((e) => e.type === "land")!;
    // At the moment of impact the crate is a little into the floor: its feet are near y 0.
    assert.ok(typeof land.z === "number" && Math.abs(land.y) < 0.15, `the land event is at its feet, with z: ${JSON.stringify(land)}`);
  });

  test("every 3D shape comes to rest at its own height", () => {
    const world = run(
      scene([
        box("sphere", -6, 3, 0, { shape: "sphere", width: 2, height: 2 }),
        box("cylinder", -2, 3, 0, { shape: "cylinder", width: 1, height: 3 }),
        box("capsule", 2, 3, 0, { shape: "capsule", width: 1, height: 3, fixedRotation: true }),
        box("hull", 6, 3, 0, { shape: "convex", points: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [0, 1.5, 0]] }),
        box("slab", 10, 3, 0, { width: 2, height: 0.5, depth: 4 }),
      ]),
      3,
    );
    const y = (id: string) => world.get(id)!.transform.y;
    assert.ok(Math.abs(y("sphere") - 1) < 0.02, `sphere center at its radius: ${y("sphere")}`);
    assert.ok(Math.abs(y("cylinder") - 1.5) < 0.02, `cylinder stands upright: ${y("cylinder")}`);
    assert.ok(Math.abs(y("capsule") - 1.5) < 0.02, `capsule stands on its end: ${y("capsule")}`);
    assert.ok(Math.abs(y("hull")) < 0.02, `pyramid sits on its base: ${y("hull")}`);
    assert.ok(Math.abs(y("slab") - 0.25) < 0.02, `depth makes a slab, not a cube: ${y("slab")}`);
  });

  test("a ball rolls down a tilted ramp and turns as it rolls", () => {
    const ramp: EntityDef = { id: "ramp", components: { transform: { x: 0, y: 2, z: 0, rotation: { z: -20 } }, body: { width: 12, height: 0.4, depth: 4 } } };
    const world = run(scene([ramp, box("ball", -4, 5, 0, { shape: "sphere", width: 1, height: 1 })]), 2.5);
    const ball = world.get("ball")!;
    assert.ok(ball.transform.x > 1, `rolled down the slope toward +x: ${ball.transform.x}`);
    assert.ok(Math.abs(ball.transform.z) < 0.05, "and stayed in its lane");
    assert.ok(ball.transform.rotation !== 0, "it turned while rolling");
    assert.deepEqual([world.get("ramp")!.transform.rotation, world.get("ramp")!.transform.rotationX], [-20, 0], "a static body keeps its rotation exactly");
  });

  test("a kinematic platform patrols along z", () => {
    const lift: EntityDef = { id: "lift", components: { transform: { x: 0, y: 1, z: 0 }, body: { type: "kinematic", width: 2, height: 0.2, depth: 2 }, patrol: { axis: "z", distance: 4, speed: 2 } } };
    const zs = trace(scene([lift]), 4).at("lift").map((p) => p.z);
    assert.ok(Math.abs(Math.max(...zs) - 4) < 1e-6 && Math.min(...zs) >= 0, `between 0 and 4: ${Math.min(...zs)}..${Math.max(...zs)}`);
    assert.ok(zs.at(-1)! < 4, "and came back");
  });

  test("a ray straight down finds the floor", () => {
    const world = new World(scene([box("crate", 3, 0.5, 0)]));
    world.step(new Set());
    const hit = world.physics.raycast(
      { entities: world.entities, width: 0, height: 0, gravity: 9.81, emit() {} },
      { x: 0, y: 5, z: 0 } as { x: number; y: number },
      { x: 0, y: -5, z: 0 } as { x: number; y: number },
    ) as unknown as { entity: { id: string }; y: number; normal: { y: number } };
    assert.equal(hit.entity.id, "floor");
    assert.ok(Math.abs(hit.y) < 1e-4 && hit.normal.y > 0.99, JSON.stringify(hit));
  });
});

describe("rapier 3D game rules", () => {
  before(() => loadRapier3DPhysics());

  const sensor = (id: string, x: number, y: number, z: number, components: Record<string, unknown>): EntityDef => ({
    id,
    components: { transform: { x, y, z }, body: { width: 1, height: 1, sensor: true }, ...components },
  });

  test("a character collects, reaches a checkpoint, dies on spikes and respawns standing on the checkpoint", () => {
    const s = scene([
      hero(0, 0.9, 0),
      sensor("coin", 0, 0.9, -2, { collectible: {} }),
      sensor("flag", 0, 1, -4, { checkpoint: {}, body: { width: 1, height: 2, sensor: true } }),
      sensor("spikes", 0, 0.5, -7, { hazard: {} }),
    ]);
    const world = new World(s);
    let respawn: { y: number; z: number } | undefined;
    simulate(world, InputScript.parse("up:1.6s"), 120, (w) => {
      // The first frame after dying: where the respawn put it.
      if (!respawn && w.deaths === 1) respawn = { y: w.get("hero")!.transform.y, z: w.get("hero")!.transform.z };
    });
    assert.equal(world.score, 1);
    assert.equal(world.events.filter((e) => e.type === "checkpoint").length, 1);
    assert.equal(world.deaths, 1);
    assert.ok(Math.abs(respawn!.z - -4) < 0.01 && Math.abs(respawn!.y - 0.91) < 0.02, `respawned standing at the checkpoint: ${JSON.stringify(respawn)}`);
  });

  test("falling below the fall limit kills; reaching the goal wins", () => {
    const fall = run(scene([hero(40, 5, 0)], { fallLimit: -10 }), 2);
    assert.equal(fall.events.filter((e) => e.type === "die").length >= 1, true, "fell off the floor's edge into the void");
    const win = run(scene([hero(0, 0.9, 0), sensor("goal", 2, 0.9, 0, { goal: {} })]), 1, "right:1s");
    assert.equal(win.won, true);
  });

  test("landing on a stompable enemy from above destroys it and bounces the player up", () => {
    const slime = sensor("slime", 0, 0.5, 0, { hazard: { stompable: true, score: 5 } });
    const world = run(scene([hero(0, 4, 0), slime]), 1);
    assert.equal(world.get("slime"), undefined);
    assert.equal(world.score, 5);
    assert.equal(world.deaths, 0);
  });
});

describe("rapier 3D character controller", () => {
  before(() => loadRapier3DPhysics());

  test("walks at its speed on the ground plane, faces where it walks, and up is away (-z)", () => {
    const path = trace(scene([hero(0, 0.9, 0)]), 2, "wait:0.5s, up:1s, right:0.5s").at("hero");
    assert.ok(Math.abs(path[90]!.z - -5) < 0.05, `5 m/s for 1 s toward -z: ${path[90]!.z}`);
    const world = run(scene([hero(0, 0.9, 0)]), 1, "right:0.5s");
    assert.ok(Math.abs(world.get("hero")!.transform.rotationY - -90) < 1e-9, `faces +x after walking right: ${world.get("hero")!.transform.rotationY}`);
    const diagonal = run(scene([hero(0, 0.9, 0)]), 1.5, "wait:0.5s, up+right:1s").get("hero")!.transform;
    assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 5) < 0.05, "diagonals walk at the same speed");
  });

  test("jumps jumpSpeed² / 2g high, and a short tap jumps lower", () => {
    const peak = (inputs: string) => Math.max(...trace(scene([hero(0, 0.9, 0)]), 2, inputs).at("hero").map((p) => p.y)) - 0.91;
    const full = peak("wait:0.3s, jump:0.8s");
    assert.ok(Math.abs(full - (7 * 7) / (2 * 9.81)) < 0.1, `full jump ≈ 2.5 m: ${full}`);
    assert.ok(peak("wait:0.3s, jump:0.1s") < full - 0.5, "variable jump");
  });

  test("walks up a gentle slope but not a steep one", () => {
    const ramp = (degrees: number): EntityDef => ({
      id: "ramp",
      components: { transform: { x: 0, y: 0, z: -6, rotation: { x: degrees } }, body: { width: 4, height: 0.4, depth: 10 } },
    });
    const top = (degrees: number) => Math.max(...trace(scene([hero(0, 0.9, 0), ramp(degrees)]), 3, "wait:0.3s, up:2.5s").at("hero").map((p) => p.y));
    assert.ok(top(25) > 2.5, `climbed the 25° ramp: ${top(25)}`);
    assert.ok(top(65) < 1.5, `stopped by the 65° ramp: ${top(65)}`);
  });

  test("steps onto a low ledge but not a high one", () => {
    const ledge = (height: number): EntityDef => ({ id: "ledge", components: { transform: { x: 0, y: height / 2, z: -3 }, body: { width: 4, height, depth: 2 } } });
    const z = (height: number) => run(scene([hero(0, 0.9, 0), ledge(height)]), 2, "wait:0.3s, up:1.2s").get("hero")!.transform.z;
    assert.ok(z(0.25) < -3, `stepped up 0.25 m: z ${z(0.25)}`);
    assert.ok(z(0.8) > -2, `stopped by 0.8 m: z ${z(0.8)}`);
  });

  test("pushes a crate, and rides a moving platform", () => {
    const pushed = run(scene([hero(0, 0.9, 0), box("crate", 0, 0.5, -2)]), 2.5, "wait:0.3s, up:2s").get("crate")!.transform.z;
    assert.ok(pushed < -4, `crate pushed along -z: ${pushed}`);
    const lift: EntityDef = { id: "lift", components: { transform: { x: 0, y: 1, z: 0 }, body: { type: "kinematic", width: 3, height: 0.2, depth: 3 }, patrol: { axis: "x", distance: 6, speed: 2 } } };
    const frames = trace(scene([hero(0, 2.1, 0), lift]), 3);
    const offsets = frames.at("hero").slice(60).map((p, i) => p.x - frames.at("lift")[60 + i]!.x);
    assert.ok(Math.max(...offsets) - Math.min(...offsets) < 0.01, `kept its place on the platform (varied ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(3)} m)`);
  });

  test("bumping a ceiling stops the jump", () => {
    const ceiling: EntityDef = { id: "ceiling", components: { transform: { x: 0, y: 3, z: 0 }, body: { width: 4, height: 0.2, depth: 4 } } };
    const top = Math.max(...trace(scene([hero(0, 0.9, 0), ceiling]), 1.5, "wait:0.3s, jump:0.8s").at("hero").map((p) => p.y));
    assert.ok(top < 2.9 - 0.9 + 0.05, `stopped under the ceiling: ${top}`);
  });
});

describe("rapier 3D joints", () => {
  before(() => loadRapier3DPhysics());

  test("a pendulum hinged to a point swings in the screen plane at a fixed length", () => {
    const bob: EntityDef = {
      id: "bob",
      components: { transform: { x: 3, y: 5, z: 0 }, body: { type: "dynamic", width: 0.5, height: 0.5, shape: "sphere" }, joint: { type: "revolute", anchor: { x: -3, y: 0, z: 0 } } },
    };
    const path = trace(scene([bob]), 2).at("bob");
    for (const p of path) assert.ok(Math.abs(Math.hypot(p.x, p.y - 5) - 3) < 0.02 && Math.abs(p.z) < 1e-6, `on its circle: ${JSON.stringify(p)}`);
    assert.ok(Math.min(...path.map((p) => p.y)) < 2.1, "swung down");
  });

  test("a door hinged on a vertical axis turns around y, with limits", () => {
    const door: EntityDef = {
      id: "door",
      components: {
        transform: { x: 1, y: 1.5, z: 0 },
        body: { type: "dynamic", width: 2, height: 3, depth: 0.2 },
        joint: { type: "revolute", anchor: { x: -1, y: 0, z: 0 }, axis: { y: 1 }, min: -70, max: 70, motorSpeed: 90, motorForce: 500 },
      },
    };
    const world = run(scene([door], { gravity: 9.81 }), 3);
    const t = world.get("door")!.transform;
    assert.ok(Math.abs(Math.abs(t.rotationY) - 70) < 2, `opened to its 70° limit around y: ${t.rotationY}`);
    assert.ok(Math.abs(t.rotationX) < 1 && Math.abs(t.rotation) < 1, "only around y");
  });

  test("a ball joint keeps its distance and lets the bob swing any way", () => {
    const bob: EntityDef = {
      id: "bob",
      components: { transform: { x: 2, y: 5, z: 1 }, body: { type: "dynamic", width: 0.5, height: 0.5, shape: "sphere" }, joint: { type: "spherical", anchor: { x: -2, y: 0, z: -1 } } },
    };
    const path = trace(scene([bob]), 2).at("bob");
    for (const p of path) assert.ok(Math.abs(Math.hypot(p.x, p.y - 5, p.z) - Math.hypot(2, 1)) < 0.03, "at its length");
    assert.ok(path.some((p) => Math.abs(p.z) > 0.5) && path.some((p) => Math.abs(p.x) > 0.5), "it swings in x and z");
  });

  test("a slider moves only along its axis; a weld moves as one; a rope only limits", () => {
    const rail: EntityDef = {
      id: "cart",
      components: { transform: { x: 0, y: 3, z: 0 }, body: { type: "dynamic", width: 1, height: 1, vx: 2, vy: 2, vz: 2 }, joint: { type: "prismatic", axis: { x: 1 } } },
    };
    const cart = run(scene([rail]), 1).get("cart")!.transform;
    assert.ok(cart.x > 1 && Math.abs(cart.y - 3) < 1e-3 && Math.abs(cart.z) < 1e-3, `slid along x only: ${JSON.stringify(cart)}`);
    const a = box("a", 0, 3, 0);
    const b: EntityDef = { id: "b", components: { transform: { x: 1, y: 3, z: 0 }, body: { type: "dynamic", width: 1, height: 1 }, joint: { type: "fixed", to: "a" } } };
    const weld = run(scene([a, b]), 2);
    const [pa, pb] = [weld.get("a")!.transform, weld.get("b")!.transform];
    assert.ok(Math.abs(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) - 1) < 0.02, "welded: still 1 m apart after landing");
    const swing: EntityDef = { id: "load", components: { transform: { x: 0, y: 6, z: 0 }, body: { type: "dynamic", width: 0.5, height: 0.5 }, joint: { type: "rope", toAnchor: { x: 0, y: 2, z: 0 }, length: 3 } } };
    const loadY = run(scene([swing]), 2).get("load")!.transform.y;
    assert.ok(Math.abs(loadY - 5) < 0.05, `fell until the rope (3 m from y 8) went taut: ${loadY}`);
  });
});

describe("rapier 3D determinism", () => {
  before(() => loadRapier3DPhysics());

  /** Everything at once: stacking, rolling, a character walking and jumping, joints and a patrol. */
  function golden(): string {
    const entities: EntityDef[] = [hero(0, 0.9, 6)];
    for (let i = 0; i < 6; i++) entities.push(box(`crate-${i}`, (i % 3) - 1, 0.5 + Math.floor(i / 3) * 1.01, -2, { friction: 0.6 }));
    entities.push(box("ball", -6, 3, 0, { shape: "sphere", vx: 4, vz: -1, bounce: 0.5 }));
    entities.push({ id: "ramp", components: { transform: { x: -8, y: 1, z: 0, rotation: { z: -15 } }, body: { width: 6, height: 0.3, depth: 3 } } });
    entities.push({
      id: "bob",
      components: { transform: { x: 4, y: 5, z: 0 }, body: { type: "dynamic", width: 0.6, height: 0.6, shape: "sphere" }, joint: { type: "spherical", anchor: { x: -2, y: 0, z: 1 } } },
    });
    entities.push({ id: "lift", components: { transform: { x: 5, y: 1, z: 4 }, body: { type: "kinematic", width: 2, height: 0.2, depth: 2 }, patrol: { axis: "z", distance: 3, speed: 1.5 } } });
    const world = new World(scene(entities));
    const hash = createHash("sha256");
    simulate(world, InputScript.parse("up:1s, up+jump:0.4s, up:1.2s, left+up:1s, wait:0.4s"), 360, (w) => hash.update(JSON.stringify(w.snapshot())));
    return hash.update(JSON.stringify(world.events)).digest("hex").slice(0, 16);
  }

  test("the same scene gives the same frames every run", () => {
    assert.equal(golden(), golden());
  });

  // Checked on every CI machine (Linux, Windows, macOS × Node 22 and 24): Rapier's deterministic
  // build and Ludra's own math must give these exact frames everywhere.
  const GOLDEN = "3135f9a54cece1b4";
  test("golden hash: every machine and Node version simulates exactly the same frames", () => {
    assert.equal(golden(), GOLDEN);
  });
});
