import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript, parseAssertion, runTest, ScriptError, simulate, World, type EntityDef, type Script, type SceneDef } from "../src/index.ts";

const ground: EntityDef = {
  id: "ground",
  components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } },
};
const player: EntityDef = {
  id: "player",
  components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 20, height: 36 }, platformer: {} },
};

function scripted(id: string, src: string, extra: EntityDef["components"] = {}, params?: Record<string, unknown>): EntityDef {
  return { id, components: { transform: { x: 400, y: 487 }, script: { src, ...(params ? { params } : {}) }, ...extra } };
}

function run(scene: SceneDef, scripts: Record<string, Script>, inputs = "", seconds = 1): World {
  const world = new World(scene, { scripts });
  simulate(world, InputScript.parse(inputs), Math.round(seconds * 60));
  return world;
}

const chase: Script = {
  update({ self, world, params }) {
    const target = world.player();
    if (target) self.vx = Math.sign(target.x - self.x) * (params.speed as number);
  },
};

describe("script hooks", () => {
  test("update runs every frame and can steer a body", () => {
    const enemy = scripted("enemy", "chase.ts", { body: { type: "kinematic", width: 20, height: 20, sensor: true } }, { speed: 60 });
    const world = run({ entities: [ground, player, enemy] }, { "chase.ts": chase });
    assert.ok(Math.abs(world.get("enemy")!.transform.x - (400 - 60)) < 2, "moved toward the player at 60px/s for 1s");
  });

  test("start runs once and state persists into snapshots", () => {
    const counter: Script = {
      start: ({ self }) => {
        self.state.starts = ((self.state.starts as number) ?? 0) + 1;
        self.state.ticks = 0;
      },
      update: ({ self }) => {
        self.state.ticks = (self.state.ticks as number) + 1;
      },
    };
    const world = run({ entities: [scripted("counter", "counter.ts")] }, { "counter.ts": counter }, "", 0.5);
    assert.deepEqual(world.snapshot().entities.counter!.state, { starts: 1, ticks: 30 });
  });

  test("touch fires once when touching starts, including solids", () => {
    const door: Script = {
      touch: ({ self, world }, other) => {
        if (other.id === "player") {
          self.state.bumps = ((self.state.bumps as number) ?? 0) + 1;
          world.destroy(self);
        }
      },
    };
    const doorEntity = scripted("door", "door.ts", { body: { type: "static", width: 20, height: 80 } });
    doorEntity.components.transform = { x: 200, y: 460 };
    const world = run({ entities: [ground, player, doorEntity] }, { "door.ts": door }, "right:1s");
    assert.equal(world.get("door"), undefined, "the door opened when the player walked into it");
    assert.ok(world.get("player")!.transform.x > 250, "and the player walked through");
  });

  test("input is available to scripts, and spawned entities run their own scripts", () => {
    const gun: Script = {
      update({ self, world, input }) {
        if (input.pressed("action")) {
          world.spawn({
            components: {
              transform: { x: self.x, y: self.y },
              body: { type: "kinematic", width: 6, height: 6, sensor: true, vx: 300 },
              script: { src: "bullet.ts" },
            },
          });
          world.emit("shoot");
        }
      },
    };
    const bullet: Script = {
      update({ self, world }) {
        if (self.x > 600) world.destroy(self);
      },
    };
    const world = run({ entities: [ground, scripted("gun", "gun.ts")] }, { "gun.ts": gun, "bullet.ts": bullet }, "action, wait:0.1s, action, wait:2s", 3);
    assert.equal(world.events.filter((e) => e.type === "custom" && e.name === "shoot").length, 2);
    assert.equal(
      world.entities.filter((e) => e.id.startsWith("gun-")).length,
      0,
      "bullets were spawned with generated ids and destroyed themselves past x=600",
    );
  });

  test("win() completes the level and freezes the world", () => {
    const timer: Script = {
      update({ world }) {
        if (world.time >= 0.5) world.win();
      },
    };
    const world = run({ entities: [scripted("timer", "timer.ts")] }, { "timer.ts": timer }, "", 2);
    assert.equal(world.won, true);
    assert.equal(world.events.find((e) => e.type === "win")?.time, 0.5);
  });

  test("random() is deterministic per seed", () => {
    const roll: Script = {
      start: ({ self, world }) => {
        self.state.rolls = [world.random(), world.random()];
      },
    };
    const rolls = (seed: number) =>
      run({ world: { seed }, entities: [scripted("dice", "dice.ts")] }, { "dice.ts": roll }, "", 0.1).snapshot().entities.dice!.state!.rolls;
    assert.deepEqual(rolls(7), rolls(7));
    assert.notDeepEqual(rolls(7), rolls(8));
  });
});

describe("script errors", () => {
  test("a throwing hook reports the file, entity, hook and frame", () => {
    const broken: Script = {
      update: ({ world }) => {
        if (world.frame === 3) throw new Error("boom");
      },
    };
    assert.throws(
      () => run({ entities: [scripted("bad", "broken.ts")] }, { "broken.ts": broken }),
      (err: Error) => err instanceof ScriptError && /broken\.ts \(update on entity "bad", frame 3\): boom/.test(err.message),
    );
  });

  test("misusing the API explains the fix", () => {
    const badSpawn: Script = { start: ({ world }) => void world.spawn({ components: { body: { width: 10 } } }) };
    assert.throws(
      () => run({ entities: [scripted("spawner", "spawn.ts")] }, { "spawn.ts": badSpawn }),
      (err: Error) => /invalid entity/.test(err.message) && /height is required/.test(err.message) && /requires a "transform"/.test(err.message),
    );
    const badEmit: Script = { start: ({ world }) => world.emit("jump") };
    assert.throws(() => run({ entities: [scripted("e", "emit.ts")] }, { "emit.ts": badEmit }), /built-in event/);
  });

  test("an entity whose script is not loaded fails at construction", () => {
    assert.throws(() => new World({ entities: [scripted("x", "missing.ts")] }), /missing\.ts .*not loaded/);
  });
});

describe("assertions on scripts", () => {
  test("state, strings and custom events can be asserted", () => {
    const boss: Script = {
      update({ self, world }) {
        self.state.phase = world.time < 1 ? "calm" : "angry";
        if (world.frame % 30 === 0) world.emit("roar");
      },
    };
    const result = runTest(
      { entities: [scripted("boss", "boss.ts")] },
      { name: "boss", duration: "2s", assert: ['boss.state.phase == "calm" at 0.5s', 'boss.state.phase == "angry"', "events.roar == 4", "boss.state.hp == 3"] },
      { scripts: { "boss.ts": boss } },
    );
    assert.deepEqual(
      result.results.map((r) => r.pass),
      [true, true, true, false],
    );
    assert.match(result.results[3]!.message, /not set/);
    assert.deepEqual(parseAssertion("door.state.open == true").subject, { kind: "state", id: "door", key: "open" });
  });

  test("a script error fails the test with its message instead of crashing", () => {
    const broken: Script = {
      update: () => {
        throw new Error("nope");
      },
    };
    const result = runTest({ entities: [scripted("bad", "b.ts")] }, { name: "t", assert: ["score == 0"] }, { scripts: { "b.ts": broken } });
    assert.equal(result.pass, false);
    assert.match(result.error ?? "", /b\.ts \(update on entity "bad", frame 1\): nope/);
  });
});
