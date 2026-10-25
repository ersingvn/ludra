import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InputScript,
  runTest,
  ScriptError,
  simulate,
  validateScene,
  World,
  type EntityDef,
  type SceneDef,
  type Script,
} from "../src/index.ts";

const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };
const hero: EntityDef = {
  id: "hero",
  components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} },
};
const spike: EntityDef = {
  id: "spike",
  components: { transform: { x: 300, y: 490 }, body: { type: "static", width: 40, height: 20, sensor: true }, hazard: {} },
};

function run(scene: SceneDef, inputs: string, seconds: number, scripts?: Map<string, Script>): World {
  const world = new World(scene, { scripts });
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

describe("lives and game over", () => {
  test("each death costs a life, and the last one ends the game where the player fell", () => {
    const world = run({ world: { lives: 3 }, entities: [ground, hero, spike] }, "right:6s", 6);
    assert.equal(world.deaths, 3);
    assert.equal(world.lives, 0);
    assert.equal(world.lost, true);
    assert.deepEqual(
      world.events.filter((e) => e.type === "die" || e.type === "gameover").map((e) => e.type),
      ["die", "die", "die", "gameover"],
    );
    // Nothing moves after game over: no respawn, no more input.
    const x = world.get("hero")!.transform.x;
    world.step(new Set(["right"]));
    assert.equal(world.get("hero")!.transform.x, x);
    assert.ok(x > 250, "stays where it fell instead of respawning");
  });

  test("without lives, retries are unlimited", () => {
    const world = run({ entities: [ground, hero, spike] }, "right:6s", 6);
    assert.ok(world.deaths >= 4);
    assert.equal(world.lives, undefined);
    assert.equal(world.lost, false);
  });

  test("carry starts a scene with the previous scene's score, deaths and lives", () => {
    const world = new World({ world: { lives: 3 }, entities: [ground, hero] }, { carry: { score: 7, deaths: 2, lives: 1 } });
    assert.deepEqual([world.score, world.deaths, world.lives], [7, 2, 1]);
  });

  test("scripts can grant lives and end the game", () => {
    const scripts = new Map<string, Script>([
      ["scripts/rules.ts", { start: ({ world }) => void (world.lives = (world.lives ?? 0) + 2), update: ({ world }) => void (world.time >= 1 && world.lose()) }],
    ]);
    const rules: EntityDef = { id: "rules", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/rules.ts" } } };
    const world = run({ world: { lives: 1 }, entities: [ground, hero, rules] }, "", 2, scripts);
    assert.equal(world.lives, 3);
    assert.equal(world.lost, true);
    assert.equal(world.events.find((e) => e.type === "gameover")?.time, 1);
  });

  test("lives and lost can be asserted", () => {
    const scene: SceneDef = { world: { lives: 2 }, entities: [ground, hero, spike] };
    const result = runTest(scene, { name: "two falls", inputs: "right:4s", assert: ["lives == 0", "lost == true", "events.gameover == 1"] });
    assert.ok(result.pass, JSON.stringify(result.results));
    const unlimited = runTest({ entities: [ground, hero] }, { name: "x", duration: "0.1s", assert: ["lives == 3"] });
    assert.match(unlimited.results[0]!.message, /unlimited retries/);
  });

  test("world.lives must be a whole number of at least 1", () => {
    for (const lives of [0, 1.5, "3"]) {
      assert.ok(validateScene({ world: { lives }, entities: [] }).diagnostics.some((d) => d.path === "world.lives"), String(lives));
    }
  });
});

describe("checkpoints", () => {
  const flag: EntityDef = {
    id: "flag",
    components: { transform: { x: 200, y: 470 }, body: { type: "static", width: 20, height: 60, sensor: true }, checkpoint: {} },
  };

  test("a touched checkpoint becomes where the player respawns, standing on its bottom edge", () => {
    const world = new World({ entities: [ground, hero, flag, spike] });
    let respawnedAt: { x: number; y: number } | undefined;
    for (let i = 0; i < 120 && !respawnedAt; i++) {
      world.step(new Set(["right"]));
      if (world.deaths === 1) respawnedAt = { x: world.get("hero")!.transform.x, y: world.get("hero")!.transform.y };
    }
    assert.deepEqual(respawnedAt, { x: 200, y: 500 - 18 });
    assert.equal(world.events.filter((e) => e.type === "checkpoint").length, 1, "fires once, even when touched again");
  });

  test("needs a sensor body", () => {
    const solid = { ...flag, components: { ...flag.components, body: { type: "static", width: 20, height: 60 } } };
    assert.ok(validateScene({ entities: [solid] }).diagnostics.some((d) => d.code === "E_CHECKPOINT_NEEDS_SENSOR"));
  });
});

describe("moving between scenes", () => {
  test("a won goal with next names the scene to play after it", () => {
    const goal: EntityDef = {
      id: "door",
      components: { transform: { x: 160, y: 480 }, body: { type: "static", width: 30, height: 40, sensor: true }, goal: { next: "scenes/level-2.scene.json" } },
    };
    const world = run({ entities: [ground, hero, goal] }, "right:1s", 1);
    assert.equal(world.won, true);
    assert.equal(world.exit, "scenes/level-2.scene.json");
  });

  test("world.goto moves on from a scene with no goal, like a title screen", () => {
    const scripts = new Map<string, Script>([
      ["scripts/title.ts", { update: ({ world, input }) => void (input.pressed("jump") && world.goto("scenes/level-1.scene.json")) }],
    ]);
    const title: EntityDef = { id: "title", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/title.ts" } } };
    const world = run({ entities: [title] }, "wait:0.5s, jump", 1, scripts);
    assert.equal(world.exit, "scenes/level-1.scene.json");
    assert.equal(world.won, false);
    const goto = world.events.find((e) => e.type === "goto");
    assert.equal(goto?.type === "goto" && goto.scene, "scenes/level-1.scene.json");
    assert.equal(world.over, true);
  });

  test("a draw hook can't change scenes or lives", () => {
    const world = new World({ world: { lives: 2 }, entities: [ground, hero] });
    const extras = {
      g: {} as CanvasRenderingContext2D,
      time: 0,
      local: {},
      view: { width: 960, height: 540, cameraX: 0, cameraY: 0, zoom: 1 },
      recent: () => [],
      image: () => undefined,
      burst: () => {},
      shake: () => {},
      random: () => 0.5,
    };
    const scripts = new Map<string, Script>([
      ["a.ts", { draw: ({ world: w }) => w.goto("x.scene.json") }],
      ["b.ts", { draw: ({ world: w }) => void (w.lives = 9) }],
    ]);
    for (const src of ["a.ts", "b.ts"]) {
      const scene: SceneDef = { world: { lives: 2 }, entities: [{ id: "s", components: { transform: { x: 0, y: 0 }, script: { src } } }] };
      const w = new World(scene, { scripts });
      assert.throws(() => w.callDrawHook(w.get("s")!, "draw", extras), ScriptError);
    }
    assert.equal(world.lives, 2);
  });
});

describe("prefabs", () => {
  const prefabs = {
    slime: {
      components: {
        body: { type: "kinematic", width: 30, height: 24, sensor: true },
        sprite: { color: "#c77dff" },
        patrol: { axis: "x", distance: 100, speed: 60 },
        hazard: { stompable: true, score: 2 },
      },
    },
  };

  test("entities start from a prefab and override what differs", () => {
    const { scene, diagnostics } = validateScene({
      prefabs,
      entities: [
        { id: "slime-1", prefab: "slime", components: { transform: { x: 100, y: 488 } } },
        { id: "slime-2", prefab: "slime", components: { transform: { x: 400, y: 488 }, patrol: { speed: 120 }, sprite: null } },
      ],
    });
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
    const [one, two] = scene!.entities;
    assert.equal(one!.prefab, undefined, "the prefab key is resolved away");
    assert.deepEqual(one!.components.patrol, { axis: "x", distance: 100, speed: 60 });
    assert.deepEqual(two!.components.patrol, { axis: "x", distance: 100, speed: 120 }, "overrides merge field by field");
    assert.equal(two!.components.sprite, undefined, "null removes a component");
    assert.equal(two!.components.hazard!.score, 2);
    // Overrides never leak into the prefab or other entities.
    assert.equal(prefabs.slime.components.patrol.speed, 60);
  });

  test("unknown prefabs are reported with a suggestion", () => {
    const { diagnostics } = validateScene({ prefabs, entities: [{ id: "a", prefab: "slim", components: { transform: { x: 0, y: 0 } } }] });
    const problem = diagnostics.find((d) => d.code === "E_UNKNOWN_PREFAB");
    assert.equal(problem?.path, "entities[0].prefab");
    assert.match(problem!.fix!, /Did you mean "slime"/);
  });

  test("prefab components are checked", () => {
    const { diagnostics } = validateScene({ prefabs: { bad: { components: { sprit: {} } } }, entities: [] });
    assert.ok(diagnostics.some((d) => d.code === "E_UNKNOWN_COMPONENT" && d.path === "prefabs.bad.components.sprit"));
  });

  test("scripts spawn prefabs, and get a clear error for unknown ones", () => {
    const scripts = new Map<string, Script>([
      ["scripts/spawner.ts", { start: ({ world }) => void world.spawn({ prefab: "slime", components: { transform: { x: 300, y: 488 } } }) }],
      ["scripts/typo.ts", { start: ({ world }) => void world.spawn({ prefab: "slimee" }) }],
    ]);
    const spawner = (src: string): SceneDef => ({ prefabs, entities: [ground, { id: "spawner", components: { transform: { x: 0, y: 0 }, script: { src } } }] });
    const world = run(spawner("scripts/spawner.ts"), "", 0.1, scripts);
    const spawned = world.entities.find((e) => e.id.startsWith("spawner-"));
    assert.equal(spawned?.hazard?.score, 2);
    assert.equal(spawned?.patrol?.originX, 300, "spawned where the script said (it has patrolled a few px since)");
    assert.throws(() => run(spawner("scripts/typo.ts"), "", 0.1, scripts), /prefab "slimee" does not exist\. Prefabs: slime/);
  });
});
