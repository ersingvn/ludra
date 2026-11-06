import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef, type SceneDef } from "../src/index.ts";

function wall(id: string, x: number, y: number, width: number, height: number): EntityDef {
  return { id, components: { transform: { x, y }, body: { type: "static", width, height } } };
}

function hero(x: number, y: number, speed = 0): EntityDef {
  return { id: "hero", components: { transform: { x, y }, body: { type: "dynamic", width: 20, height: 20 }, topdown: { speed } } };
}

function hunter(x: number, y: number, chase: Record<string, unknown> = {}, body: Record<string, unknown> = {}): EntityDef {
  return { id: "hunter", components: { transform: { x, y }, body: { type: "dynamic", width: 20, height: 20, ...body }, chase: { speed: 120, sight: 240, ...chase } } };
}

function run(entities: EntityDef[], inputs = "", seconds = 1, world: Record<string, unknown> = { gravity: 0 }): World {
  const w = new World({ world, entities } as SceneDef);
  simulate(w, InputScript.parse(inputs), Math.round(seconds * 60));
  return w;
}

const count = (w: World, type: string) => w.events.filter((e) => e.type === type).length;
const distance = (w: World, a: string, b: string) => {
  const p = w.get(a)!.transform;
  const q = w.get(b)!.transform;
  return Math.sqrt((p.x - q.x) ** 2 + (p.y - q.y) ** 2);
};

describe("chase", () => {
  test("waits until the target is in sight, then spots it and closes in", () => {
    const far = run([hero(800, 270), hunter(200, 270)], "", 1);
    assert.equal(count(far, "spot"), 0, "600 px away is out of sight");
    assert.deepEqual([far.get("hunter")!.transform.x, far.get("hunter")!.transform.y], [200, 270], "and it waits");

    const near = run([hero(400, 270), hunter(200, 270)], "", 1.5);
    assert.equal(count(near, "spot"), 1);
    assert.ok(distance(near, "hunter", "hero") < 25, `closed in: ${distance(near, "hunter", "hero")}`);
  });

  test("can't see through walls, unless it's told it can", () => {
    const entities = [hero(400, 270), hunter(200, 270), wall("w", 300, 270, 20, 200)];
    assert.equal(count(run(entities, "", 1), "spot"), 0);
    const smell = [hero(400, 270), hunter(200, 270, { seeThroughWalls: true }), wall("w", 300, 270, 20, 200)];
    const w = run(smell, "", 4);
    assert.equal(count(w, "spot"), 1);
    assert.ok(distance(w, "hunter", "hero") < 25, `went around the wall: ${distance(w, "hunter", "hero")}`);
  });

  test("follows a target that hides behind a wall, around it", () => {
    // Seen below the wall's end, then the hero runs up behind the wall.
    const entities = [hero(420, 400, 300), hunter(200, 400), wall("w", 300, 225, 20, 250)];
    const w = run(entities, "up:0.6s", 5);
    assert.ok(w.get("hero")!.transform.y < 250, "the hero hid behind the wall");
    assert.ok(count(w, "spot") >= 1);
    assert.ok(distance(w, "hunter", "hero") < 25, `found it: ${distance(w, "hunter", "hero")}`);
  });

  test("loses a target that runs away, searches, gives up and walks home", () => {
    // The hero runs right at 400 px/s; the hunter only does 100.
    const w = run([hero(330, 270, 400), hunter(200, 270, { speed: 100, sight: 200, memory: 1 })], "right:2s", 7);
    assert.equal(count(w, "spot"), 1);
    assert.equal(count(w, "giveup"), 1);
    const h = w.get("hunter")!;
    assert.ok(Math.abs(h.transform.x - 200) < 5 && Math.abs(h.transform.y - 270) < 5, `back home: ${h.transform.x}, ${h.transform.y}`);
    assert.equal(h.chase!.mode, "idle");
  });

  test("in a side view it walks along the ground and stops at a ledge", () => {
    const ground = [wall("left", 200, 520, 400, 40), wall("right", 760, 520, 400, 40)];
    const sideHero: EntityDef = { id: "hero", components: { transform: { x: 640, y: 490 }, body: { type: "dynamic", width: 20, height: 20 }, platformer: {} } };
    const w = run([...ground, sideHero, hunter(250, 490, { sight: 500 })], "", 4, {});
    assert.equal(count(w, "spot"), 1);
    const h = w.get("hunter")!;
    assert.ok(h.transform.x > 360 && h.transform.x <= 400, `waits at the ledge: ${h.transform.x}`);
    assert.ok(h.transform.y < 500, "didn't fall");
  });

  test("patrols until it spots something", () => {
    const patroller: EntityDef = {
      id: "hunter",
      components: { transform: { x: 200, y: 270 }, body: { type: "kinematic", width: 20, height: 20 }, patrol: { axis: "y", distance: 100, speed: 60 }, chase: { sight: 150 } },
    };
    const calm = run([hero(800, 270), patroller], "", 1);
    assert.ok(calm.get("hunter")!.transform.y > 300, "patrols");
    const w = run([hero(330, 270), patroller], "", 2);
    assert.equal(count(w, "spot"), 1);
    assert.ok(distance(w, "hunter", "hero") < 25);
  });

  test("hunts by id, and the same run always plays out the same, through save and restore", () => {
    const entities = [hero(500, 100, 300), { ...hunter(200, 400, { target: "hero", sight: 600 }), id: "hunter" }, wall("w", 350, 250, 20, 300)];
    const a = run(entities, "down:0.5s, left:1s, up:0.5s", 4);
    const b = run(entities, "down:0.5s, left:1s, up:0.5s", 4);
    assert.deepEqual(a.get("hunter")!.transform, b.get("hunter")!.transform);

    const w = new World({ world: { gravity: 0 }, entities } as SceneDef);
    simulate(w, InputScript.parse("down:0.5s"), 60);
    const save = w.save();
    simulate(w, InputScript.parse("left:1s"), 90);
    const first = { ...w.get("hunter")!.transform };
    w.restore(save);
    simulate(w, InputScript.parse("left:1s"), 90);
    assert.deepEqual(w.get("hunter")!.transform, first);
  });

  test("check says when a hunter can't move, and a 3D hunter is fine", () => {
    const stuck = validateScene({ world: { gravity: 0 }, entities: [hunter(0, 0, {}, { type: "static" })] });
    assert.ok(stuck.diagnostics.some((d) => d.code === "E_CHASE_NEEDS_MOVING_BODY"));
    const threeD = validateScene({ world: { dimensions: 3, physics: "rapier" }, entities: [{ id: "h", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 1, height: 1 }, chase: {} } }] } as SceneDef);
    assert.ok(!threeD.diagnostics.some((d) => d.path.endsWith("chase")), JSON.stringify(threeD.diagnostics));
  });
});
