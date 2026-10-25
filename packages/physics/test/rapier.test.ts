import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef, type SceneDef, type Script } from "@ludra/core";
import { loadRapierPhysics } from "../src/index.ts";

const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };
const walls: EntityDef[] = [-10, 970].map((x, i) => ({
  id: `wall-${i}`,
  components: { transform: { x, y: 270 }, body: { type: "static", width: 20, height: 540 } },
}));

function rapier(...entities: EntityDef[]): SceneDef {
  return { world: { physics: "rapier" }, entities: [ground, ...walls, ...entities] };
}

function run(scene: SceneDef, seconds: number, inputs = "", scripts?: Map<string, Script>): World {
  const world = new World(scene, { scripts });
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

describe("loading", () => {
  test("an unknown engine name lists the engines there are", () => {
    assert.throws(() => new World({ world: { physics: "box2d" as "rapier" }, entities: [] }), /Unknown physics engine "box2d"\. Use one of: arcade, rapier/);
  });
});

describe("rapier physics", () => {
  before(() => loadRapierPhysics());

  test("a crate falls, lands on the ground and rests there", () => {
    const crate: EntityDef = { id: "crate", components: { transform: { x: 300, y: 100 }, body: { type: "dynamic", width: 40, height: 40 } } };
    const world = run(rapier(crate), 2);
    const c = world.get("crate")!;
    assert.equal(world.physics.name, "rapier");
    assert.ok(Math.abs(c.transform.y - 480) < 1, `rests on the ground top (y ≈ 480), got ${c.transform.y}`);
    assert.equal(c.body!.grounded, true);
    assert.equal(c.body!.standingOn?.id, "ground");
    assert.equal(world.events.filter((e) => e.type === "land" && e.entity === "crate").length, 1);
  });

  test("a crate hanging off a ledge tips over: bodies rotate", () => {
    const ledge: EntityDef = { id: "ledge", components: { transform: { x: 200, y: 300 }, body: { type: "static", width: 200, height: 20 } } };
    // Its center is past the ledge's edge (x = 300), so it topples off.
    const crate: EntityDef = { id: "crate", components: { transform: { x: 310, y: 260 }, body: { type: "dynamic", width: 40, height: 60 } } };
    const world = run(rapier(ledge, crate), 1);
    assert.ok(Math.abs(world.get("crate")!.transform.rotation) > 20, `tipped over, rotation ${world.get("crate")!.transform.rotation}°`);
    assert.ok(Math.abs(world.snapshot().entities.crate!.rotation!) > 20, "rotation is in snapshots");
  });

  test("fixedRotation keeps a body upright", () => {
    const ledge: EntityDef = { id: "ledge", components: { transform: { x: 200, y: 300 }, body: { type: "static", width: 200, height: 20 } } };
    const crate: EntityDef = {
      id: "crate",
      components: { transform: { x: 310, y: 260 }, body: { type: "dynamic", width: 40, height: 60, fixedRotation: true } },
    };
    assert.equal(run(rapier(ledge, crate), 1).get("crate")!.transform.rotation, 0);
  });

  test("a ball rolls down a slope", () => {
    const slope: EntityDef = { id: "slope", components: { transform: { x: 300, y: 300, rotation: 20 }, body: { type: "static", width: 400, height: 20 } } };
    const ball: EntityDef = { id: "ball", components: { transform: { x: 160, y: 200 }, body: { type: "dynamic", width: 30, height: 30, shape: "circle" } } };
    const world = run(rapier(slope, ball), 1.5);
    const b = world.get("ball")!;
    assert.ok(b.transform.x > 260, `rolled down and to the right, x = ${b.transform.x}`);
    assert.ok(b.transform.rotation > 90, `and spun while rolling, rotation = ${b.transform.rotation}°`);
  });

  test("bounce 1 keeps a ball bouncing, and each hit is a bounce event", () => {
    const ball: EntityDef = { id: "ball", components: { transform: { x: 480, y: 200 }, body: { type: "dynamic", width: 20, height: 20, shape: "circle", bounce: 1 } } };
    const world = run(rapier(ball), 4);
    const bounces = world.events.filter((e) => e.type === "bounce" && e.entity === "ball").length;
    assert.ok(bounces >= 3, `bounced ${bounces} times`);
    let highest = Infinity;
    const later = new World(rapier(ball));
    simulate(later, InputScript.parse(""), 240, (w) => {
      if (w.frame > 120) highest = Math.min(highest, w.get("ball")!.transform.y);
    });
    assert.ok(highest < 260, `still bounces back near its starting height (y 200), peaked at ${highest}`);
  });

  test("a platformer runs, jumps, collects, dies on a hazard and respawns", () => {
    const hero: EntityDef = {
      id: "hero",
      components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36, shape: "capsule" }, platformer: {} },
    };
    const coin: EntityDef = { id: "coin", components: { transform: { x: 200, y: 482 }, body: { type: "static", width: 20, height: 20, sensor: true }, collectible: {} } };
    const spikes: EntityDef = { id: "spikes", components: { transform: { x: 400, y: 495 }, body: { type: "static", width: 40, height: 10, sensor: true }, hazard: {} } };
    const world = run(rapier(hero, coin, spikes), 2.5, "wait:0.3s, jump:0.3s, wait:0.6s, right:1.3s");
    const kinds = world.events.map((e) => e.type);
    assert.ok(kinds.includes("jump"), "jumped: grounded is detected under rapier");
    assert.equal(world.score, 1, "collected the coin through a sensor overlap");
    assert.ok(kinds.includes("die"), "touched the spikes");
    assert.ok(world.get("hero")!.transform.x < 400, "respawned back at the start");
    assert.equal(world.get("hero")!.transform.rotation, 0, "players stay upright");
  });

  test("a patrolling platform moves within its range and carries a crate", () => {
    const lift: EntityDef = {
      id: "lift",
      components: { transform: { x: 300, y: 300 }, body: { type: "kinematic", width: 120, height: 20 }, patrol: { axis: "x", distance: 200, speed: 100 } },
    };
    const crate: EntityDef = { id: "crate", components: { transform: { x: 300, y: 270 }, body: { type: "dynamic", width: 40, height: 40, friction: 1 } } };
    let max = 0;
    const world = new World(rapier(lift, crate));
    simulate(world, InputScript.parse(""), 180, (w) => (max = Math.max(max, w.get("lift")!.transform.x)));
    assert.ok(max <= 500 + 1e-6 && max > 495, `stays within its patrol, max x ${max}`);
    assert.ok(world.get("crate")!.transform.x > 360, `friction carried the crate along, x = ${world.get("crate")!.transform.x}`);
  });

  test("scripts can spawn and destroy rapier bodies", () => {
    const scripts = new Map<string, Script>([
      [
        "rain.ts",
        {
          update: ({ world }) => {
            if (world.frame % 10 === 0 && world.frame <= 50) world.spawn({ components: { transform: { x: 480, y: 50 }, body: { type: "dynamic", width: 16, height: 16, shape: "circle" } } });
            if (world.frame === 80) for (const e of world.all("body")) if (e.id.startsWith("rain-")) world.destroy(e);
          },
        },
      ],
    ]);
    const rain: EntityDef = { id: "rain", components: { transform: { x: 0, y: 0 }, script: { src: "rain.ts" } } };
    const world = run(rapier(rain), 1.5, "", scripts);
    assert.equal(world.entities.filter((e) => e.id.startsWith("rain-")).length, 0, "destroyed bodies are gone");
    const mid = new World(rapier(rain), { scripts });
    simulate(mid, InputScript.parse(""), 79);
    const drops = mid.entities.filter((e) => e.id.startsWith("rain-"));
    assert.equal(drops.length, 5, "five balls were spawned");
    assert.ok(drops.every((e) => e.transform.y > 100), "and they fell under rapier gravity");
  });
});

describe("determinism", () => {
  before(() => loadRapierPhysics());

  /** A busy scene: a pyramid of crates hit by a heavy ball, plus a slope and rolling balls. */
  function pile(): SceneDef {
    const crates: EntityDef[] = [];
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= 4 - row; i++) {
        crates.push({ id: `crate-${row}-${i}`, components: { transform: { x: 560 + i * 42 + row * 21, y: 479 - row * 41 }, body: { type: "dynamic", width: 40, height: 40 } } });
      }
    }
    return rapier(
      ...crates,
      { id: "slope", components: { transform: { x: 200, y: 330, rotation: 25 }, body: { type: "static", width: 300, height: 20 } } },
      { id: "ball-a", components: { transform: { x: 90, y: 200 }, body: { type: "dynamic", width: 30, height: 30, shape: "circle", bounce: 0.4 } } },
      { id: "ball-b", components: { transform: { x: 130, y: 150 }, body: { type: "dynamic", width: 24, height: 24, shape: "circle", bounce: 0.8 } } },
      { id: "wrecking", components: { transform: { x: 300, y: 420 }, body: { type: "dynamic", width: 60, height: 60, shape: "circle", density: 8, vx: 900, bullet: true } } },
    );
  }

  function trace(): string {
    const hash = createHash("sha256");
    const world = new World(pile());
    simulate(world, InputScript.parse(""), 600, (w) => hash.update(JSON.stringify(w.snapshot())));
    return hash.digest("hex").slice(0, 16);
  }

  test("the same scene gives bit-identical frames every run", () => {
    assert.equal(trace(), trace());
  });

  test("golden hash: every machine and Node version simulates exactly the same frames", () => {
    // Recorded once. If this changes on one CI machine only, Rapier isn't deterministic
    // there; if it changes everywhere, the engine or Rapier's version changed behavior.
    assert.equal(trace(), GOLDEN);
  });
});

const GOLDEN = "b166ff49b14c1322";

describe("validation", () => {
  test("rapier-only fields under arcade physics are flagged", () => {
    const { diagnostics } = validateScene({
      entities: [{ id: "ball", components: { transform: { x: 0, y: 0, rotation: 30 }, body: { type: "dynamic", width: 20, height: 20, shape: "circle" } } }],
    });
    const warning = diagnostics.find((d) => d.code === "W_RAPIER_ONLY");
    assert.match(warning!.message, /transform\.rotation, body\.shape/);
    assert.match(warning!.fix!, /"physics": "rapier"/);
    assert.equal(validateScene(rapier({ id: "b", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 9, height: 9, shape: "circle" } } })).diagnostics.filter((d) => d.code === "W_RAPIER_ONLY").length, 0);
  });

  test("world.physics must name a known engine", () => {
    assert.ok(validateScene({ world: { physics: "box2d" }, entities: [] }).diagnostics.some((d) => d.path === "world.physics"));
  });
});
