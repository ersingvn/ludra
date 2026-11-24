import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  carryFrom,
  decodeProgress,
  encodeProgress,
  InputScript,
  localProgressStore,
  memoryProgressStore,
  progressCarry,
  progressFromCarry,
  progressKey,
  runTest,
  simulate,
  validateScene,
  World,
  type EntityDef,
  type SceneDef,
  type Script,
} from "../src/index.ts";

const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };
const hero: EntityDef = { id: "hero", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } };
const flag: EntityDef = { id: "flag", components: { transform: { x: 600, y: 470 }, body: { type: "static", width: 20, height: 60, sensor: true }, checkpoint: {} } };

/** A script that saves on its first frame, and clears when the player presses action. */
const saver: Script = {
  start(ctx) {
    ctx.self.state.saved = ctx.world.progress.save();
  },
  update(ctx) {
    if (ctx.input.pressed("action")) ctx.world.progress.clear();
  },
};
const statue: EntityDef = { id: "statue", components: { transform: { x: 50, y: 50 }, script: { src: "saver.ts" } } };

describe("progress JSON", () => {
  test("encodes what a run has and decodes it back", () => {
    const progress = encodeProgress({ score: 12, deaths: 3, lives: 2, items: { key: 1 }, flags: { helped: true, quest: "hammer" } }, "scenes/level-2.scene.json", "flag");
    assert.deepEqual(progress, { v: 1, scene: "scenes/level-2.scene.json", score: 12, deaths: 3, lives: 2, items: { key: 1 }, flags: { helped: true, quest: "hammer" }, checkpoint: "flag" });
    assert.deepEqual(decodeProgress(JSON.stringify(progress)), { ok: true, progress });
    assert.deepEqual(progressCarry(progress), { score: 12, deaths: 3, lives: 2, items: { key: 1 }, flags: { helped: true, quest: "hammer" } });
  });

  test("leaves out lives and checkpoint when there are none, and reads a world without items or flags", () => {
    const world = new World({ entities: [ground, hero] });
    const progress = encodeProgress(world, "scenes/a.scene.json");
    assert.deepEqual(progress, { v: 1, scene: "scenes/a.scene.json", score: 0, deaths: 0, items: {}, flags: {} });
    assert.equal("lives" in progress, false);
    assert.deepEqual(progressFromCarry(undefined, "s"), { v: 1, scene: "s", score: 0, deaths: 0, items: {}, flags: {} });
    assert.deepEqual(carryFrom({ score: 5, deaths: 1, lives: undefined, items: { gem: 2 } }), { score: 5, deaths: 1, lives: undefined, items: { gem: 2 } });
  });

  test("turns away damaged saves with a reason", () => {
    const good = { v: 1, scene: "s", score: 0, deaths: 0, items: {}, flags: {} };
    const bad: [unknown, RegExp][] = [
      ["{not json", /JSON/],
      [[], /object/],
      [{ ...good, v: 2 }, /version 2/],
      [{ ...good, scene: "" }, /scene/],
      [{ ...good, score: "9" }, /score/],
      [{ ...good, lives: null }, /lives/],
      [{ ...good, items: { key: "one" } }, /items/],
      [{ ...good, flags: { a: [1] } }, /flags/],
      [{ ...good, checkpoint: 3 }, /checkpoint/],
    ];
    for (const [input, reason] of bad) {
      const decoded = decodeProgress(input);
      assert.equal(decoded.ok, false, JSON.stringify(input));
      if (!decoded.ok) assert.match(decoded.error, reason);
    }
    // Missing items and flags are fine: an older save had none.
    assert.equal(decodeProgress({ v: 1, scene: "s", score: 0, deaths: 0 }).ok, true);
  });
});

describe("progress stores", () => {
  test("memory keeps one save", () => {
    const store = memoryProgressStore();
    assert.equal(store.load(), undefined);
    store.save(progressFromCarry({ score: 3 }, "s"));
    assert.equal(store.load()?.score, 3);
    store.clear();
    assert.equal(store.load(), undefined);
  });

  test("localStorage keeps it under the game's name, drops what it can't read, and survives a storage that refuses", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
    const store = localProgressStore("Kurt Korusu", storage);
    store.save(progressFromCarry({ score: 7 }, "scenes/b.scene.json", "flag"));
    assert.equal(JSON.parse(data.get(progressKey("Kurt Korusu"))!).checkpoint, "flag");
    assert.equal(store.load()?.score, 7);
    const warn = console.warn;
    console.warn = () => {};
    try {
      data.set(progressKey("Kurt Korusu"), "{broken");
      assert.equal(store.load(), undefined);
      const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } } as unknown as Storage;
      const quiet = localProgressStore("x", refusing);
      assert.equal(quiet.load(), undefined);
      quiet.save(progressFromCarry(undefined, "s"));
      quiet.clear();
    } finally {
      console.warn = warn;
    }
  });
});

describe("world.progress", () => {
  test("save fires saved, clear fires cleared, and exists follows them", () => {
    const world = new World({ entities: [ground, hero, statue] }, { scripts: { "saver.ts": saver } });
    simulate(world, InputScript.parse("wait:0.5s, action:2f"), 60);
    assert.equal(world.get("statue")!.state.saved, true);
    assert.deepEqual(world.events.filter((e) => e.type === "saved" || e.type === "cleared").map((e) => e.type), ["saved", "cleared"]);
    assert.equal(world.progress.exists, false);
  });

  test("tests can assert on it", () => {
    const scene: SceneDef = { entities: [ground, hero, statue] };
    const result = runTest(scene, { name: "saves", inputs: "wait:0.2s", assert: ["events.saved >= 1", "events.cleared == 0"] }, { scripts: { "saver.ts": saver } });
    assert.equal(result.pass, true, JSON.stringify(result.results));
  });

  test('a scene with "save": false never saves and has no saved game', () => {
    const world = new World({ world: { save: false }, entities: [ground, hero, statue] }, { scripts: { "saver.ts": saver }, progress: { exists: true, scene: "s" } });
    assert.equal(world.progress.exists, false);
    simulate(world, InputScript.parse("wait:0.2s"), 12);
    assert.equal(world.get("statue")!.state.saved, false);
    assert.equal(world.events.some((e) => e.type === "saved"), false);
    for (const save of [0, "no"]) assert.ok(validateScene({ world: { save }, entities: [] }).diagnostics.some((d) => d.path === "world.save"), String(save));
    assert.equal(validateScene({ world: { save: false }, entities: [] }).ok, true);
  });

  test("continue goes to the saved game's scene, as goto does, and says it is a continue", () => {
    const title: Script = {
      update(ctx) {
        if (ctx.input.pressed("action")) ctx.self.state.went = ctx.world.progress.continue();
      },
    };
    const scene: SceneDef = { entities: [{ id: "menu", components: { transform: { x: 0, y: 0 }, script: { src: "title.ts" } } }] };
    const none = new World(scene, { scripts: { "title.ts": title } });
    simulate(none, InputScript.parse("action:2f"), 3);
    assert.equal(none.get("menu")!.state.went, false);
    assert.equal(none.exit, undefined);
    const world = new World(scene, { scripts: { "title.ts": title }, progress: { exists: true, scene: "scenes/level-2.scene.json" } });
    simulate(world, InputScript.parse("action:2f"), 3);
    assert.equal(world.exit, "scenes/level-2.scene.json");
    assert.equal(world.progress.resume, true);
    assert.equal(world.events.filter((e) => e.type === "goto").length, 1);
  });

  test("a world can start at a checkpoint, which counts as reached", () => {
    const world = new World({ entities: [ground, hero, flag] }, { checkpoint: "flag" });
    const h = world.get("hero")!;
    assert.deepEqual({ x: h.transform.x, y: h.transform.y }, { x: 600, y: 500 - 18 });
    assert.equal(world.checkpointReached, "flag");
    simulate(world, InputScript.parse("wait:0.5s"), 30);
    assert.equal(world.events.some((e) => e.type === "checkpoint"), false, "no event: it wasn't touched, only started at");
    // A checkpoint the scene no longer has: the scene's own start.
    const old = new World({ entities: [ground, hero, flag] }, { checkpoint: "gone" });
    assert.equal(old.get("hero")!.transform.x, 100);
    assert.equal(old.checkpointReached, undefined);
  });

  test("the last checkpoint reached and the saved game come back with World.restore", () => {
    const world = new World({ entities: [ground, hero, flag, statue] }, { scripts: { "saver.ts": saver } });
    simulate(world, InputScript.parse("wait:0.1s"), 6);
    const before = world.save();
    simulate(world, InputScript.parse("right:3s, action:2f"), 200);
    assert.equal(world.checkpointReached, "flag");
    assert.equal(world.progress.exists, false);
    world.restore(before);
    assert.equal(world.checkpointReached, undefined);
    assert.equal(world.progress.exists, true);
  });
});
