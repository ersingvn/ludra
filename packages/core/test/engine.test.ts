import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InputScript,
  InputScriptError,
  parseAssertion,
  runTest,
  simulate,
  validateScene,
  World,
  type SceneDef,
} from "../src/index.ts";

const ground = {
  id: "ground",
  components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } },
};

function scene(...entities: SceneDef["entities"]): SceneDef {
  return { entities: [ground, ...entities] };
}

const player = {
  id: "player",
  components: {
    transform: { x: 100, y: 300 },
    body: { type: "dynamic", width: 20, height: 20 },
    platformer: {},
  },
};

describe("validateScene", () => {
  test("accepts a valid scene", () => {
    const result = validateScene(scene(player));
    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  });

  test("suggests the closest component name for typos", () => {
    const result = validateScene(scene({ id: "p", components: { transfrom: { x: 0, y: 0 } } }));
    const diagnostic = result.diagnostics.find((d) => d.code === "E_UNKNOWN_COMPONENT");
    assert.equal(result.ok, false);
    assert.equal(diagnostic?.path, "entities[1].components.transfrom");
    assert.match(diagnostic?.fix ?? "", /Did you mean "transform"/);
  });

  test("reports missing required fields and components", () => {
    const result = validateScene(scene({ id: "p", components: { body: { type: "static", width: 10 } } }));
    const codes = result.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("E_MISSING_FIELD"));
    assert.ok(codes.includes("E_MISSING_REQUIRED_COMPONENT"));
  });

  test("requires collectibles to be sensors", () => {
    const coin = {
      id: "coin",
      components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10 }, collectible: {} },
    };
    const result = validateScene(scene(player, coin));
    assert.equal(result.diagnostics[0]?.code, "E_COLLECTIBLE_NEEDS_SENSOR");
  });

  test("rejects duplicate ids", () => {
    const result = validateScene(scene(player, player));
    assert.ok(result.diagnostics.some((d) => d.code === "E_DUPLICATE_ID"));
  });

  test("warns when dynamic bodies have nothing to stand on", () => {
    const result = validateScene({ entities: [player] });
    assert.equal(result.ok, true);
    assert.ok(result.diagnostics.some((d) => d.code === "W_NOTHING_TO_STAND_ON"));
  });
});

describe("InputScript", () => {
  test("parses segments with durations and combos", () => {
    const script = InputScript.parse("right:0.5s, wait:100ms, left+jump:3f, jump");
    assert.equal(script.totalFrames, 30 + 6 + 3 + 6);
    assert.deepEqual([...script.at(0)], ["right"]);
    assert.deepEqual([...script.at(30)], []);
    assert.deepEqual([...script.at(36)].sort(), ["jump", "left"]);
    assert.deepEqual([...script.at(1000)], []);
  });

  test("rejects unknown actions with the list of valid ones", () => {
    assert.throws(() => InputScript.parse("fly:1s"), (err: Error) => err instanceof InputScriptError && /Valid actions/.test(err.message));
  });
});

describe("World", () => {
  test("dynamic bodies fall and land on static ones", () => {
    const world = new World(scene(player));
    simulate(world, InputScript.parse(""), 120);
    const p = world.get("player")!;
    assert.equal(p.transform.y, 490);
    assert.equal(p.body!.grounded, true);
    assert.deepEqual(
      world.events.map((e) => e.type),
      ["land"],
    );
  });

  test("platformers run and jump", () => {
    const world = new World(scene(player));
    simulate(world, InputScript.parse("wait:1s, right+jump:0.3s"), 70);
    const p = world.get("player")!;
    assert.ok(p.transform.x > 100);
    assert.ok(p.transform.y < 490);
    assert.ok(world.events.some((e) => e.type === "jump"));
  });

  test("is deterministic", () => {
    const run = () => {
      const world = new World(scene(player));
      simulate(world, InputScript.parse("right:0.4s, jump:0.3s, left:0.5s"), 180);
      return world.snapshot();
    };
    assert.deepEqual(run(), run());
  });

  test("collectibles are removed and scored", () => {
    const coin = {
      id: "coin",
      components: { transform: { x: 160, y: 490 }, body: { width: 10, height: 10, sensor: true }, collectible: { score: 5 } },
    };
    const world = new World(scene({ ...player, components: { ...player.components, transform: { x: 100, y: 490 } } }, coin));
    simulate(world, InputScript.parse("right:0.5s"), 30);
    assert.equal(world.get("coin"), undefined);
    assert.equal(world.score, 5);
  });

  test("fromJSON throws with diagnostics on invalid scenes", () => {
    assert.throws(() => World.fromJSON({ entities: [{ id: "x", components: { nope: {} } }] }), /Unknown component/);
  });
});

describe("assertions", () => {
  test("parses subjects, operators and times", () => {
    const a = parseAssertion("player.x >= 12.5 at 1.5s");
    assert.deepEqual(a.subject, { kind: "entity", id: "player", field: "x" });
    assert.equal(a.operator, ">=");
    assert.equal(a.expected, 12.5);
    assert.equal(a.at, 90);
    assert.equal(parseAssertion("coin-1.exists == false").at, "end");
    assert.throws(() => parseAssertion("player.color == 1"), /not something Ludra can check/);
  });

  test("runTest reports pass and fail with actual values", () => {
    const result = runTest(scene(player), {
      name: "falls",
      duration: "2s",
      assert: ["player.grounded == true", "player.y < 100"],
    });
    assert.equal(result.pass, false);
    assert.equal(result.results[0]?.pass, true);
    assert.equal(result.results[1]?.pass, false);
    assert.match(result.results[1]!.message, /player\.y = 490/);
  });
});
