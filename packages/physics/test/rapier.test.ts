import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef, type PhysicsHost, type SceneDef, type Script } from "@ludra/core";
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

describe("character controller", () => {
  before(() => loadRapierPhysics());

  const hero = (x: number, y: number, platformer: Record<string, unknown> = {}): EntityDef => ({
    id: "hero",
    components: { transform: { x, y }, body: { type: "dynamic", width: 28, height: 36 }, platformer },
  });
  const slope = (degrees: number): EntityDef => ({
    id: "slope",
    // A ramp rising to the right, its low end resting on the ground near x = 300.
    components: { transform: { x: 450, y: 500 - Math.sin((degrees * Math.PI) / 180) * 150, rotation: -degrees }, body: { type: "static", width: 320, height: 12 } },
  });
  const path = (scene: SceneDef, inputs: string, seconds: number) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const world = new World(scene);
    simulate(world, InputScript.parse(inputs), Math.round(seconds * 60), (w) => {
      xs.push(w.get("hero")!.transform.x);
      ys.push(w.get("hero")!.transform.y);
    });
    return { world, xs, ys };
  };

  test("walks up a gentle slope", () => {
    const { world, ys } = path(rapier(hero(200, 482), slope(25)), "right:1.4s, wait:0.3s", 1.7);
    assert.ok(Math.min(...ys) < 430, `climbed, highest y ${Math.min(...ys).toFixed(1)}`);
    assert.equal(world.get("hero")!.body!.grounded, true);
  });

  test("can't walk up a slope steeper than maxSlope", () => {
    const { ys } = path(rapier(hero(200, 482, { maxSlope: 30 }), slope(55)), "right:2s", 2);
    assert.ok(Math.min(...ys) > 440, `stayed near the bottom, highest y ${Math.min(...ys).toFixed(1)}`);
  });

  test("standing still on a slope doesn't slide down it", () => {
    const { xs, ys } = path(rapier(hero(200, 482), slope(25)), "right:0.9s, wait:2s", 2.9);
    const settled = xs.length - 61;
    assert.ok(Math.abs(xs.at(-1)! - xs[settled]!) < 0.5 && Math.abs(ys.at(-1)! - ys[settled]!) < 0.5, `stays put: moved ${(xs.at(-1)! - xs[settled]!).toFixed(2)}, ${(ys.at(-1)! - ys[settled]!).toFixed(2)} px in the last second`);
  });

  test("steps onto low ledges without jumping, but not onto high ones", () => {
    const step = (height: number): EntityDef => ({ id: "step", components: { transform: { x: 400, y: 500 - height / 2 }, body: { type: "static", width: 200, height } } });
    assert.ok(path(rapier(hero(200, 482), step(8)), "right:1.5s", 1.5).xs.at(-1)! > 400, "walked onto an 8 px step");
    assert.ok(path(rapier(hero(200, 482), step(30)), "right:1.5s", 1.5).xs.at(-1)! < 300, "a 30 px ledge blocks it");
    assert.ok(path(rapier(hero(200, 482, { stepHeight: 0 }), step(8)), "right:1.5s", 1.5).xs.at(-1)! < 300, "stepHeight 0 turns stepping off");
  });

  test("pushes crates, unless push is 0", () => {
    const crate: EntityDef = { id: "crate", components: { transform: { x: 300, y: 480 }, body: { type: "dynamic", width: 40, height: 40 } } };
    const pushed = path(rapier(hero(200, 482), crate), "right:2s", 2).world.get("crate")!.transform.x;
    assert.ok(pushed > 340, `the crate was pushed to x ${pushed.toFixed(1)}`);
    const stuck = path(rapier(hero(200, 482, { push: 0 }), crate), "right:2s", 2).world.get("crate")!.transform.x;
    assert.ok(Math.abs(stuck - 300) < 1, `push 0 leaves it at x ${stuck.toFixed(1)}`);
  });

  test("doesn't stick to a wall it jumps into", () => {
    const wall: EntityDef = { id: "tall-wall", components: { transform: { x: 300, y: 300 }, body: { type: "static", width: 40, height: 400 } } };
    const { world, ys } = path(rapier(hero(240, 482), wall), "right+jump:0.4s, right:1s", 1.4);
    assert.ok(Math.min(...ys) < 400, "jumped");
    assert.equal(world.get("hero")!.body!.grounded, true, "slid back down to the ground while still pressing into the wall");
  });

  test("rides a moving platform", () => {
    const lift: EntityDef = {
      id: "lift",
      components: { transform: { x: 300, y: 400 }, body: { type: "kinematic", width: 120, height: 20 }, patrol: { axis: "x", distance: 300, speed: 120 } },
    };
    // Once standing on the lift, the hero keeps the same offset from it wherever it goes.
    const offsets: number[] = [];
    const world = new World(rapier(hero(300, 360), lift));
    simulate(world, InputScript.parse(""), 120, (w) => {
      if (w.frame >= 30) offsets.push(w.get("hero")!.transform.x - w.get("lift")!.transform.x);
    });
    assert.equal(world.get("hero")!.body!.standingOn?.id, "lift");
    assert.ok(world.get("lift")!.transform.x > 500, "the lift traveled");
    assert.ok(Math.max(...offsets) - Math.min(...offsets) < 0.01, `rode along: offset from the lift varied by ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(3)} px`);
  });

  test("bumping a ceiling stops the jump", () => {
    const ceiling: EntityDef = { id: "ceiling", components: { transform: { x: 200, y: 420 }, body: { type: "static", width: 200, height: 20 } } };
    const { ys } = path(rapier(hero(200, 482), ceiling), "jump:0.5s", 1);
    assert.ok(Math.min(...ys) >= 430 + 18 - 1, `stopped under the ceiling, highest y ${Math.min(...ys).toFixed(1)}`);
  });

  test("jumps as high as under arcade physics", () => {
    const top = (scene: SceneDef) => Math.min(...path(scene, "wait:0.2s, jump:0.6s", 1.2).ys);
    const arcade = top({ entities: [ground, hero(200, 482)] });
    const rapierTop = top(rapier(hero(200, 482)));
    assert.ok(Math.abs(arcade - rapierTop) < 2, `arcade apex ${arcade.toFixed(1)}, rapier apex ${rapierTop.toFixed(1)}`);
  });

  test("top-down players stop at walls", () => {
    const walker: EntityDef = { id: "hero", components: { transform: { x: 200, y: 300 }, body: { type: "dynamic", width: 24, height: 24 }, topdown: {} } };
    const wall: EntityDef = { id: "block", components: { transform: { x: 300, y: 300 }, body: { type: "static", width: 40, height: 200 } } };
    const scene: SceneDef = { world: { physics: "rapier", gravity: 0 }, entities: [walker, wall] };
    const x = path(scene, "right:2s", 2).xs.at(-1)!;
    assert.ok(x < 300 - 20 - 12 + 1 && x > 260, `stopped at the wall, x ${x.toFixed(1)}`);
  });
});

describe("forces, raycasts and raw access", () => {
  before(() => loadRapierPhysics());
  const crate = (id: string, x: number, extra: Record<string, unknown> = {}): EntityDef => ({
    id,
    components: { transform: { x, y: 480 }, body: { type: "dynamic", width: 40, height: 40, ...extra } },
  });

  test("an impulse moves a crate; a heavier one moves less; off-center it also spins", () => {
    const world = new World(rapier(crate("light", 200), crate("heavy", 500, { density: 4 }), crate("spun", 800, { friction: 0 })));
    world.step(new Set());
    for (const id of ["light", "heavy"]) world.physics.applyImpulse(world.get(id)!, 1600 * 300, 0);
    const spun = world.get("spun")!;
    world.physics.applyImpulse(spun, 0, -1600 * 400, { x: spun.transform.x + 15, y: spun.transform.y });
    assert.ok(Math.abs(world.get("light")!.body!.vx - 300) < 1, `light: vx ${world.get("light")!.body!.vx}`);
    assert.ok(Math.abs(world.get("heavy")!.body!.vx - 75) < 1, `heavy: vx ${world.get("heavy")!.body!.vx}`);
    assert.ok(world.physics.angularVelocity(spun) !== 0, "an off-center hit spins it");
    simulate(world, InputScript.parse(""), 30);
    assert.ok(world.get("light")!.transform.x - 200 > 2 * (world.get("heavy")!.transform.x - 500));
  });

  test("angularVelocity spins a body", () => {
    const wheel: EntityDef = { id: "wheel", components: { transform: { x: 480, y: 200 }, body: { type: "dynamic", width: 40, height: 40, shape: "circle", gravityScale: 0 } } };
    const world = new World(rapier(wheel));
    world.step(new Set());
    world.physics.setAngularVelocity(world.get("wheel")!, 360);
    simulate(world, InputScript.parse(""), 60);
    assert.ok(Math.abs(world.get("wheel")!.transform.rotation - 360) < 5, `one turn clockwise in a second, rotation ${world.get("wheel")!.transform.rotation}`);
  });

  test("rays hit the true shapes: a tilted plank's slanted surface and a circle", () => {
    const plank: EntityDef = { id: "plank", components: { transform: { x: 300, y: 300, rotation: -45 }, body: { type: "static", width: 200, height: 10 } } };
    const ball: EntityDef = { id: "ball", components: { transform: { x: 700, y: 300 }, body: { type: "static", width: 60, height: 60, shape: "circle" } } };
    const world = new World(rapier(plank, ball));
    world.step(new Set());
    const host = (world as unknown as { physicsHost: PhysicsHost }).physicsHost;
    const down = world.physics.raycast(host, { x: 300, y: 50 }, { x: 300, y: 500 });
    assert.equal(down?.entity.id, "plank");
    assert.ok(Math.abs(Math.abs(down!.normal.x) - Math.abs(down!.normal.y)) < 0.01 && down!.normal.y < 0, `a 45° surface facing up, normal ${JSON.stringify(down!.normal)}`);
    const across = world.physics.raycast(host, { x: 500, y: 300 }, { x: 900, y: 300 });
    assert.equal(across?.entity.id, "ball");
    assert.ok(Math.abs(across!.x - 670) < 0.5 && Math.abs(across!.normal.x + 1) < 0.01, `hit the circle's left side at x ${across!.x}`);
    assert.equal(world.physics.raycast(host, { x: 500, y: 300 }, { x: 900, y: 300 }, { ignore: [world.get("ball")!] }), undefined);
  });

  test("scripts get the whole Rapier API through world.physics.raw", () => {
    const scripts = new Map<string, Script>([
      [
        "float.ts",
        {
          start({ self, world }) {
            const raw = world.physics.raw as { body(e: unknown): { setGravityScale(s: number, wake: boolean): void }; RAPIER: unknown; world: unknown };
            raw.body(self).setGravityScale(0, true);
            self.state.engine = world.physics.name;
            self.state.hasRapier = !!raw.RAPIER && !!raw.world;
          },
        },
      ],
    ]);
    const balloon: EntityDef = { id: "balloon", components: { transform: { x: 480, y: 200 }, body: { type: "dynamic", width: 30, height: 30, shape: "circle" }, script: { src: "float.ts" } } };
    const world = new World(rapier(balloon), { scripts });
    simulate(world, InputScript.parse(""), 60);
    assert.ok(Math.abs(world.get("balloon")!.transform.y - 200) < 0.01, `gravity was turned off through raw Rapier, y ${world.get("balloon")!.transform.y}`);
    assert.deepEqual(world.get("balloon")!.state, { engine: "rapier", hasRapier: true });
  });
});

describe("joints", () => {
  before(() => loadRapierPhysics());
  const bob = (joint: Record<string, unknown>, extra: Record<string, unknown> = {}): EntityDef => ({
    id: "bob",
    components: { transform: { x: 600, y: 200 }, body: { type: "dynamic", width: 30, height: 30, shape: "circle", ...extra }, joint },
  });
  const trace = (scene: SceneDef, seconds: number, id = "bob") => {
    const xs: number[] = [];
    const ys: number[] = [];
    const world = new World(scene);
    simulate(world, InputScript.parse(""), Math.round(seconds * 60), (w) => {
      xs.push(w.get(id)!.transform.x);
      ys.push(w.get(id)!.transform.y);
    });
    return { world, xs, ys };
  };

  test("a pendulum swings on a hinge to a point in the world, keeping its length", () => {
    // Hinged 200 px to its left: it swings down and past the pivot.
    const { xs, ys } = trace(rapier(bob({ type: "revolute", anchor: { x: -200, y: 0 } })), 3);
    const lengths = xs.map((x, i) => Math.hypot(x - 400, ys[i]! - 200));
    assert.ok(Math.max(...lengths) - Math.min(...lengths) < 1, `length stays 200: ${Math.min(...lengths).toFixed(2)}..${Math.max(...lengths).toFixed(2)}`);
    assert.ok(Math.min(...xs) < 250, `swung past the pivot to x ${Math.min(...xs).toFixed(0)}`);
  });

  test("a rope only stops a body from going further than its length", () => {
    const { ys } = trace(rapier(bob({ type: "rope", toAnchor: { x: 0, y: -100 }, length: 150 })), 2);
    assert.ok(Math.max(...ys) <= 100 + 150 + 0.5 && Math.max(...ys) > 100 + 150 - 2, `hangs at the rope's end: lowest y ${Math.max(...ys).toFixed(1)}`);
  });

  test("a spring bounces a body around its rest length and settles there", () => {
    const { ys } = trace(rapier(bob({ type: "spring", toAnchor: { x: 0, y: -100 }, length: 100, stiffness: 400, damping: 4 })), 6);
    assert.ok(Math.max(...ys) > 230, `stretched under gravity first, lowest y ${Math.max(...ys).toFixed(1)}`);
    const last = ys.slice(-30);
    assert.ok(Math.max(...last) - Math.min(...last) < 2, "then settled");
  });

  test("a motorized hinge turns a wheel at its speed, and limits stop a door", () => {
    const wheel = rapier({
      id: "bob",
      components: {
        transform: { x: 480, y: 200 },
        body: { type: "dynamic", width: 60, height: 60, shape: "circle" },
        joint: { type: "revolute", motorSpeed: 180, motorForce: 1e9 },
      },
    });
    const turned = trace(wheel, 2).world.get("bob")!.transform.rotation;
    assert.ok(Math.abs(turned - 360) < 15, `half a turn per second for 2 s, rotation ${turned.toFixed(1)}`);
    const door = rapier({
      id: "bob",
      components: {
        transform: { x: 480, y: 200 },
        body: { type: "dynamic", width: 120, height: 10 },
        joint: { type: "revolute", anchor: { x: -60, y: 0 }, min: 0, max: 30 },
      },
    });
    const angle = trace(door, 2).world.get("bob")!.transform.rotation;
    assert.ok(angle > 25 && angle < 31, `swung down until its 30° limit, rotation ${angle.toFixed(1)}`);
  });

  test("a slider moves only along its axis, within its limits", () => {
    const { xs, ys } = trace(rapier(bob({ type: "prismatic", axis: 90, min: -10, max: 100 }, { shape: "box" })), 2);
    assert.ok(xs.every((x) => Math.abs(x - 600) < 0.01), "never left its vertical track");
    // Limits are slightly soft: a brief overshoot, then it rests on the limit.
    assert.ok(Math.abs(ys.at(-1)! - 300) < 0.5 && Math.max(...ys) < 303, `rests at its 100 px limit: y ${ys.at(-1)!.toFixed(2)}, furthest ${Math.max(...ys).toFixed(2)}`);
  });

  test("a weld holds two bodies together, including to a body added later", () => {
    const scripts = new Map<string, Script>([
      ["spawn.ts", { start: ({ world }) => void world.spawn({ id: "cart", components: { transform: { x: 600, y: 240 }, body: { type: "dynamic", width: 80, height: 20 } } }) }],
    ]);
    const scene = rapier(bob({ type: "fixed", to: "cart", toAnchor: { x: 0, y: -40 } }), {
      id: "spawner",
      components: { transform: { x: 0, y: 0 }, script: { src: "spawn.ts" } },
    });
    // The scene names "cart" before a script spawns it: validation would object, so build the world directly.
    const world = new World(scene, { scripts });
    simulate(world, InputScript.parse(""), 120);
    const b = world.get("bob")!.transform;
    const cart = world.get("cart")!.transform;
    assert.ok(cart.y > 450, "the cart fell to the ground, carrying the bob");
    assert.ok(Math.abs(b.y - (cart.y - 40)) < 1 && Math.abs(b.x - cart.x) < 1, `still welded 40 px above: bob ${b.x.toFixed(1)},${b.y.toFixed(1)} cart ${cart.x.toFixed(1)},${cart.y.toFixed(1)}`);
  });
});

describe("several joints and free shapes", () => {
  before(() => loadRapierPhysics());

  test("a bridge hangs from both cliffs: its last plank has two joints", () => {
    const planks: EntityDef[] = [];
    const left = 300;
    const width = 50;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const toPrevious = { type: "revolute", to: `plank-${i - 1}`, anchor: { x: -width / 2, y: 0 } };
      const toLeftCliff = { type: "revolute", anchor: { x: -width / 2, y: 0 } };
      const toRightCliff = { type: "revolute", anchor: { x: width / 2, y: 0 } };
      const joint = i === 0 ? toLeftCliff : i === count - 1 ? [toPrevious, toRightCliff] : toPrevious;
      planks.push({ id: `plank-${i}`, components: { transform: { x: left + width / 2 + i * width, y: 300 }, body: { type: "dynamic", width: width - 2, height: 8 }, joint } });
    }
    const world = new World(rapier(...planks));
    simulate(world, InputScript.parse(""), 180);
    const first = world.get("plank-0")!.transform;
    const last = world.get(`plank-${count - 1}`)!.transform;
    const end = (t: { x: number; y: number; rotation: number }, side: number) => ({
      x: t.x + side * (width / 2) * Math.cos((t.rotation * Math.PI) / 180),
      y: t.y + side * (width / 2) * Math.sin((t.rotation * Math.PI) / 180),
    });
    const a = end(first, -1);
    const b = end(last, 1);
    assert.ok(Math.hypot(a.x - left, a.y - 300) < 1.5, `left end stays on the left cliff: ${a.x.toFixed(1)},${a.y.toFixed(1)}`);
    assert.ok(Math.hypot(b.x - (left + count * width), b.y - 300) < 1.5, `right end stays on the right cliff: ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
    assert.ok(world.get("plank-4")!.transform.y > 300, "and the middle sags");
  });

  test("a polygon wedge is a ramp a ball rolls down", () => {
    const wedge: EntityDef = {
      id: "wedge",
      // A right triangle: tall on the left, sloping down to the right.
      components: { transform: { x: 400, y: 440 }, body: { type: "static", width: 200, height: 120, shape: "polygon", points: [[-100, 60], [100, 60], [-100, -60]] } },
    };
    const ball: EntityDef = { id: "ball", components: { transform: { x: 320, y: 340 }, body: { type: "dynamic", width: 24, height: 24, shape: "circle" } } };
    const world = new World(rapier(wedge, ball));
    simulate(world, InputScript.parse(""), 120);
    assert.ok(world.get("ball")!.transform.x > 500, `rolled off the wedge to x ${world.get("ball")!.transform.x.toFixed(0)}`);
  });

  test("a dynamic polygon lands on the ground with its lowest corner on it", () => {
    const rock: EntityDef = {
      id: "rock",
      components: { transform: { x: 480, y: 200 }, body: { type: "dynamic", width: 60, height: 40, shape: "polygon", points: [[-30, 20], [30, 20], [10, -20], [-20, -15]] } },
    };
    const world = new World(rapier(rock));
    simulate(world, InputScript.parse(""), 120);
    const r = world.get("rock")!;
    assert.equal(r.body!.grounded, true);
    assert.ok(Math.abs(r.transform.y + 20 - 500) < 1, `rests flat on its 60 px base: y ${r.transform.y.toFixed(1)}`);
  });

  test("a polyline is ground with hills: balls roll off it, rays land on it", () => {
    const hills: EntityDef = {
      id: "hills",
      components: {
        transform: { x: 480, y: 400 },
        body: { type: "static", width: 600, height: 120, shape: "polyline", points: [[-300, 60], [-100, -40], [0, -60], [100, -40], [300, 60]] },
      },
    };
    const ball: EntityDef = { id: "ball", components: { transform: { x: 500, y: 300 }, body: { type: "dynamic", width: 20, height: 20, shape: "circle" } } };
    const world = new World(rapier(hills, ball));
    simulate(world, InputScript.parse(""), 120);
    assert.ok(world.get("ball")!.transform.x > 600, `rolled down the right side of the hill to x ${world.get("ball")!.transform.x.toFixed(0)}`);
    const host = (world as unknown as { physicsHost: PhysicsHost }).physicsHost;
    const hit = world.physics.raycast(host, { x: 480, y: 100 }, { x: 480, y: 600 });
    assert.equal(hit?.entity.id, "hills");
    assert.ok(Math.abs(hit!.y - 340) < 0.5, `the hilltop is at y 340, the ray hit ${hit!.y.toFixed(2)}`);
  });

  test("free shapes and joint lists are validated", () => {
    const codes = (entity: EntityDef) => validateScene(rapier(entity)).diagnostics.map((d) => d.code);
    const body = (extra: Record<string, unknown>) => ({ type: "static", width: 10, height: 10, ...extra });
    assert.ok(codes({ id: "a", components: { transform: { x: 0, y: 0 }, body: body({ shape: "polygon", points: [[0, 0], [1, 1]] }) } }).includes("E_SHAPE_POINTS"));
    assert.ok(codes({ id: "a", components: { transform: { x: 0, y: 0 }, body: body({ type: "dynamic", shape: "polyline", points: [[0, 0], [9, 0]] }) } }).includes("E_POLYLINE_DYNAMIC"));
    assert.ok(codes({ id: "a", components: { transform: { x: 0, y: 0 }, body: body({ shape: "polygon", points: [[0, 0], [1], [2, 2]] }) } }).includes("E_INVALID_FIELD"));
    const listed = validateScene(rapier({ id: "a", components: { transform: { x: 0, y: 0 }, body: body({}), joint: [{ type: "revolute" }, { type: "hinge" }, { to: "nobody" }] } })).diagnostics;
    assert.ok(listed.some((d) => d.path.endsWith("joint[1].type")), "each joint in a list is checked");
    assert.ok(listed.some((d) => d.code === "E_JOINT_TARGET" && d.path.endsWith("joint[2].to")));
  });
});

describe("determinism", () => {
  before(() => loadRapierPhysics());

  /** A busy scene: a pyramid of crates hit by a heavy ball, a slope, rolling balls and a player. */
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
      // A character controller in the mix: it drops onto the slope and gets caught up in the pile.
      { id: "hero", components: { transform: { x: 240, y: 100 }, body: { type: "dynamic", width: 28, height: 36, shape: "capsule" }, platformer: {} } },
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

const GOLDEN = "9f16be6a4594029d";

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
