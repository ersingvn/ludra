import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef, type SceneDef } from "../src/index.ts";

function wall(id: string, x: number, y: number, width: number, height: number): EntityDef {
  return { id, components: { transform: { x, y }, body: { type: "static", width, height } } };
}

function hero(extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}): EntityDef {
  return {
    id: "hero",
    components: {
      transform: { x: 300, y: 300 },
      body: { type: "dynamic", width: 24, height: 24, ...body },
      topdown: { speed: 200, ...extra },
    },
  };
}

function run(scene: SceneDef, inputs: string, seconds: number): World {
  const world = new World(scene);
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

describe("topdown", () => {
  test("moves in 8 directions at the same speed and ignores gravity", () => {
    const world = run({ entities: [hero()] }, "right+down:0.5s", 0.5);
    const h = world.get("hero")!;
    assert.ok(Math.abs(Math.hypot(h.body!.vx, h.body!.vy) - 200) < 1e-6, "diagonal speed equals straight speed");
    assert.ok(Math.abs(h.transform.x - h.transform.y) < 1e-6, "moved equally right and down");
    assert.ok(h.transform.y < 300 + 200 * 0.5 + 1, "no gravity on top of the input");
    const idle = run({ entities: [hero()] }, "", 1);
    assert.equal(idle.get("hero")!.transform.y, 300, "stays put without input");
  });

  test("directions limits movement: x for paddles, 4 for grid-like movement", () => {
    const paddle = run({ entities: [hero({ directions: "x" })] }, "right+up:0.5s", 0.5).get("hero")!;
    assert.equal(paddle.transform.y, 300);
    assert.ok(paddle.transform.x > 390);
    const fourWay = run({ entities: [hero({ directions: "4" })] }, "right+up:0.5s", 0.5).get("hero")!;
    assert.equal(fourWay.transform.y, 300, "horizontal wins when both are held");
  });

  test("dynamic topdown bodies are stopped by walls", () => {
    const world = run({ entities: [hero(), wall("wall", 400, 300, 20, 200)] }, "right:1s", 1);
    assert.equal(world.get("hero")!.transform.x, 400 - 10 - 12);
  });

  test("clampToWorld keeps kinematic movers inside the world", () => {
    const ship = hero({ directions: "x" }, { type: "kinematic" });
    const world = run({ world: { width: 960 }, entities: [ship] }, "right:5s", 5);
    assert.equal(world.get("hero")!.transform.x, 960 - 12);
  });

  test("topdown players collect, die on hazards, respawn and reach goals", () => {
    const sensor = (id: string, x: number, extra: Record<string, unknown>): EntityDef => ({
      id,
      components: { transform: { x, y: 300 }, body: { width: 20, height: 20, sensor: true }, ...extra },
    });
    const scene: SceneDef = {
      entities: [hero(), sensor("gem", 350, { collectible: { score: 5 } }), sensor("flag", 450, { goal: {} })],
    };
    const won = run(scene, "right:1s", 1);
    assert.equal(won.score, 5);
    assert.equal(won.won, true);

    const spiky: SceneDef = { entities: [hero(), sensor("slime", 350, { hazard: { stompable: true } })] };
    // Contact after ~0.14s; let go soon after, so the respawned player doesn't walk into it again.
    const died = run(spiky, "right:0.2s", 0.5);
    assert.equal(died.deaths, 1, "stompable enemies still kill topdown players (no stomping from above)");
    assert.equal(died.get("hero")!.transform.x < 350, true, "respawned at the start");
  });
});

describe("bounce", () => {
  const box = [wall("left", 0, 270, 20, 540), wall("right", 960, 270, 20, 540), wall("top", 480, 0, 960, 20), wall("bottom", 480, 540, 960, 20)];

  test("bounce 1 reflects velocity off walls at full speed and emits bounce events", () => {
    const ball: EntityDef = {
      id: "ball",
      components: { transform: { x: 480, y: 270 }, body: { type: "dynamic", width: 12, height: 12, bounce: 1, gravityScale: 0, vx: 300, vy: -200 } },
    };
    const world = run({ entities: [...box, ball] }, "", 4);
    const b = world.get("ball")!.body!;
    assert.equal(Math.abs(b.vx), 300, "keeps its horizontal speed");
    assert.equal(Math.abs(b.vy), 200, "keeps its vertical speed");
    // From the center at (300, -200) px/s it reaches the top, right and bottom walls within 4s.
    assert.deepEqual(
      world.events.filter((e) => e.type === "bounce").map((e) => (e.type === "bounce" ? e.other : "")),
      ["top", "right", "bottom"],
    );
    const { x, y } = world.get("ball")!.transform;
    assert.ok(x > 10 && x < 950 && y > 10 && y < 530, "never escapes the box");
  });

  test("partial bounce loses height each time and comes to rest", () => {
    const ball: EntityDef = {
      id: "ball",
      components: { transform: { x: 480, y: 100 }, body: { type: "dynamic", width: 12, height: 12, bounce: 0.6 } },
    };
    const world = run({ entities: [...box, ball] }, "", 6);
    const bounces = world.events.filter((e) => e.type === "bounce");
    assert.ok(bounces.length >= 2, "bounced a few times");
    assert.equal(world.get("ball")!.body!.grounded, true, "then rests on the floor");
  });

  test("bodies without bounce still stop dead", () => {
    const block: EntityDef = { id: "block", components: { transform: { x: 480, y: 100 }, body: { type: "dynamic", width: 12, height: 12 } } };
    const world = run({ entities: [...box, block] }, "", 2);
    assert.equal(world.events.filter((e) => e.type === "bounce").length, 0);
    assert.equal(world.get("block")!.body!.grounded, true);
  });
});

describe("validation for genres", () => {
  test("a static topdown body and two controllers are errors", () => {
    const codes = (entity: EntityDef) => validateScene({ entities: [entity] }).diagnostics.map((d) => d.code);
    assert.ok(codes(hero({}, { type: "static" })).includes("E_TOPDOWN_NEEDS_MOVING_BODY"));
    const both = hero();
    both.components.platformer = {};
    assert.ok(codes(both).includes("E_TWO_CONTROLLERS"));
  });

  test("top-down and zero-gravity scenes don't warn about having nothing to stand on", () => {
    const warnings = (scene: SceneDef) => validateScene(scene).diagnostics.map((d) => d.code);
    assert.ok(!warnings({ entities: [hero()] }).includes("W_NOTHING_TO_STAND_ON"));
    const ball: EntityDef = { id: "ball", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 10, height: 10 } } };
    assert.ok(!warnings({ world: { gravity: 0 }, entities: [ball] }).includes("W_NOTHING_TO_STAND_ON"));
    assert.ok(warnings({ entities: [ball] }).includes("W_NOTHING_TO_STAND_ON"), "a falling body still warns");
  });
});

describe("kinematic topdown", () => {
  test("a player-steered kinematic paddle stops at walls", () => {
    const paddle: EntityDef = {
      id: "paddle",
      components: { transform: { x: 300, y: 500 }, body: { type: "kinematic", width: 120, height: 16 }, topdown: { speed: 400, directions: "x" } },
    };
    const world = run({ world: { gravity: 0 }, entities: [paddle, wall("wall", 700, 300, 20, 600)] }, "right:2s", 2);
    assert.equal(world.get("paddle")!.transform.x, 700 - 10 - 60);
  });
});
