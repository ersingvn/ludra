import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript, parseAssertion, runTest, simulate, validateScene, World, type EntityDef, type SceneDef } from "../src/index.ts";

const ground: EntityDef = {
  id: "ground",
  components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } },
};

function player(x = 100, y = 482): EntityDef {
  return {
    id: "player",
    components: { transform: { x, y }, body: { type: "dynamic", width: 20, height: 36 }, platformer: {} },
  };
}

function sensor(id: string, x: number, y: number, extra: Record<string, Record<string, unknown>>, type = "static"): EntityDef {
  return { id, components: { transform: { x, y }, body: { type, width: 20, height: 20, sensor: true }, ...extra } };
}

function run(scene: SceneDef, inputs: string, seconds: number): World {
  const world = new World(scene);
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

describe("patrol", () => {
  test("moves back and forth between its start and start + distance", () => {
    const mover: EntityDef = {
      id: "mover",
      components: {
        transform: { x: 100, y: 100 },
        body: { type: "kinematic", width: 40, height: 10 },
        patrol: { distance: 60, speed: 60 },
      },
    };
    const world = new World({ entities: [mover] });
    const xs: number[] = [];
    simulate(world, InputScript.parse(""), 240, (w) => xs.push(w.get("mover")!.transform.x));
    assert.equal(Math.min(...xs), 100);
    assert.equal(Math.max(...xs), 160);
    assert.ok(xs.at(-1)! < 160, "turned around after reaching the end");
  });

  test("carries a player standing on a moving platform", () => {
    const lift: EntityDef = {
      id: "lift",
      components: {
        transform: { x: 300, y: 300 },
        body: { type: "kinematic", width: 100, height: 20 },
        patrol: { distance: 200, speed: 100 },
      },
    };
    const world = run({ entities: [ground, lift, player(300, 272)] }, "", 1);
    const p = world.get("player")!;
    assert.equal(p.body!.grounded, true);
    // The player lands on the first frame, so it trails the lift by that one frame of movement.
    assert.ok(Math.abs(p.transform.x - world.get("lift")!.transform.x) < 2, "player moved with the lift");
    assert.ok(p.transform.x > 380);
  });
});

describe("hazards", () => {
  test("touching a hazard kills the player and respawns it at the start", () => {
    const spikes = sensor("spikes", 200, 490, { hazard: {} });
    const world = run({ entities: [ground, player(), spikes] }, "right:0.5s", 0.5);
    assert.equal(world.deaths, 1);
    assert.deepEqual(
      world.events.filter((e) => e.type === "die").map((e) => e.type === "die" && e.cause),
      ["spikes"],
    );
    assert.ok(world.get("player")!.transform.x < 200);
  });

  test("falling out of the world kills the player", () => {
    const farGround: EntityDef = { ...ground, components: { ...ground.components, transform: { x: 2000, y: 520 } } };
    const world = run({ entities: [farGround, player()] }, "", 2);
    const death = world.events.find((e) => e.type === "die");
    assert.ok(world.deaths >= 1);
    assert.equal(death?.type === "die" && death.cause, "fall");
  });

  test("landing on a stompable enemy destroys it and bounces the player", () => {
    const enemy: EntityDef = {
      id: "enemy",
      components: {
        transform: { x: 100, y: 487 },
        body: { type: "kinematic", width: 30, height: 26, sensor: true },
        hazard: { stompable: true, score: 2 },
      },
    };
    const world = run({ entities: [ground, player(100, 300), enemy] }, "", 1);
    assert.equal(world.get("enemy"), undefined);
    assert.equal(world.deaths, 0);
    assert.equal(world.score, 2);
    assert.ok(world.events.some((e) => e.type === "stomp"));
  });

  test("walking into a stompable enemy from the side still kills", () => {
    const enemy = sensor("enemy", 200, 490, { hazard: { stompable: true } });
    const world = run({ entities: [ground, player(), enemy] }, "right:0.5s", 0.5);
    assert.equal(world.deaths, 1);
    assert.ok(world.get("enemy"));
  });
});

describe("goal", () => {
  const coin = sensor("coin", 150, 490, { collectible: {} });

  test("reaching the goal wins and freezes the simulation", () => {
    const flag = sensor("flag", 200, 480, { goal: {} });
    const world = run({ entities: [ground, player(), flag] }, "right:2s", 2);
    assert.equal(world.won, true);
    const x = world.get("player")!.transform.x;
    assert.ok(x < 230, "player stopped moving at the goal");
    assert.equal(world.events.filter((e) => e.type === "win").length, 1);
  });

  test("a goal with requireScore ignores the player until the score is reached", () => {
    const flag = sensor("flag", 120, 480, { goal: { requireScore: 1 } });
    const early = run({ entities: [ground, player(), flag, { ...coin, components: { ...coin.components, transform: { x: 400, y: 490 } } }] }, "right:0.4s", 0.4);
    assert.equal(early.won, false);
    const later = run({ entities: [ground, player(), flag, { ...coin, components: { ...coin.components, transform: { x: 400, y: 490 } } }] }, "right:1.5s, left:2s", 3.5);
    assert.equal(later.won, true);
  });

  test("won and deaths can be asserted", () => {
    const flag = sensor("flag", 200, 480, { goal: {} });
    const result = runTest({ entities: [ground, player(), flag] }, { name: "win", inputs: "right:1s", assert: ["won == true", "deaths == 0", "events.win == 1"] });
    assert.equal(result.pass, true, JSON.stringify(result.results));
    assert.deepEqual(parseAssertion("won == true").subject, { kind: "world", field: "won" });
  });
});

describe("validation of v0.2 components", () => {
  test("hazards and goals must be sensors", () => {
    const solid = (id: string, extra: Record<string, Record<string, unknown>>): EntityDef => ({
      id,
      components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10 }, ...extra },
    });
    const codes = validateScene({ entities: [ground, player(), solid("h", { hazard: {} }), solid("g", { goal: {} })] }).diagnostics.map((d) => d.code);
    assert.ok(codes.includes("E_HAZARD_NEEDS_SENSOR"));
    assert.ok(codes.includes("E_GOAL_NEEDS_SENSOR"));
  });

  test("patrol needs a kinematic body", () => {
    const mover: EntityDef = { id: "m", components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10 }, patrol: { distance: 10 } } };
    const result = validateScene({ entities: [ground, player(), mover] });
    assert.equal(result.diagnostics[0]?.code, "E_PATROL_NEEDS_KINEMATIC_BODY");
  });

  test("a goal that needs more points than the scene offers is reported", () => {
    const flag = sensor("flag", 200, 480, { goal: { requireScore: 3 } });
    const coin = sensor("coin", 150, 490, { collectible: { score: 2 } });
    const result = validateScene({ entities: [ground, player(), flag, coin] });
    const unreachable = result.diagnostics.find((d) => d.code === "E_GOAL_UNREACHABLE");
    assert.equal(result.ok, false);
    assert.match(unreachable?.fix ?? "", /at most 2/);
  });
});
