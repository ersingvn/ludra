import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECK_EVERY, fingerprint, InputScript, Recorder, runTest, World, type Action, type EntityDef, type SceneDef, type Take } from "../src/index.ts";

const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };
const hero: EntityDef = { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } };
const spike: EntityDef = { id: "spike", components: { transform: { x: 300, y: 490 }, body: { type: "static", width: 40, height: 20, sensor: true }, hazard: {} } };
const goalAt = (x: number): EntityDef => ({ id: "goal", components: { transform: { x, y: 470 }, body: { type: "static", width: 30, height: 60, sensor: true }, goal: {} } });
const SCENE: SceneDef = { entities: [ground, hero, spike, goalAt(800)] };

function recorder() {
  const saved = new Map<number, Take>();
  const r = new Recorder({
    session: "s1",
    game: "test",
    entry: "scenes/main.scene.json",
    version: (scene) => `v:${scene}`,
    now: () => "2026-11-01T00:00:00.000Z",
    save: (_recording, index, take) => {
      saved.set(index, structuredClone(take));
    },
  });
  return { r, saved };
}

/** Plays frame inputs the way startGame does. */
function play(r: Recorder, world: World, inputs: Action[][]) {
  for (const held of inputs) {
    const input = new Set(held);
    world.step(input);
    r.step(world, input);
  }
}

const hold = (frames: number, ...actions: Action[]) => Array.from({ length: frames }, () => actions);

describe("Recorder", () => {
  it("keeps exactly the inputs the world stepped on, as a script in whole frames", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, [...hold(3), ...hold(2, "right"), ...hold(4, "jump", "right"), ...hold(1)]);
    r.stop();
    const take = saved.get(0)!;
    assert.equal(take.inputs, "wait:3f, right:2f, right+jump:4f, wait:1f");
    assert.equal(take.frames, 10);
    assert.equal(take.end, "stopped");
    assert.equal(take.scene, "scenes/main.scene.json");
    assert.equal(take.version, "v:scenes/main.scene.json");
  });

  it("a take played again from its script ends on the same fingerprint", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, [...hold(40, "right"), ...hold(12, "right", "jump"), ...hold(90, "right")]);
    r.stop();
    const take = saved.get(0)!;

    const again = new World(SCENE);
    const script = InputScript.parse(take.inputs);
    for (let frame = 0; frame < take.frames; frame++) again.step(script.at(frame));
    assert.equal(fingerprint(again), take.checks.at(-1));
  });

  it("keeps a check every few seconds, and the last frame", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, [...hold(1, "right"), ...hold(CHECK_EVERY * 2 + 6)]);
    r.stop();
    assert.equal(saved.get(0)!.checks.length, 3);
  });

  it("R starts a new take, and the old one closes on its own world", () => {
    const { r, saved } = recorder();
    const first = new World(SCENE);
    r.begin(first, undefined);
    play(r, first, hold(30, "right"));
    const x = first.get("player")!.transform.x;
    const second = new World(SCENE);
    r.begin(second, undefined);
    assert.equal(saved.get(0)!.end, "restarted");
    assert.equal(saved.get(0)!.last!.x, x, "the last place is the old world's, not the new one's start");
    play(r, second, hold(5, "left"));
    r.stop();
    assert.equal(saved.get(1)!.inputs, "left:5f");
    assert.equal(saved.size, 2);
  });

  it("a take nothing happened in is not kept, and neither is a session nobody played", () => {
    const { r, saved } = recorder();
    r.begin(new World(SCENE), undefined);
    const idle = new World(SCENE);
    r.begin(idle, undefined);
    play(r, idle, hold(20));
    r.stop();
    assert.equal(saved.size, 0, "only waiting: no file");
  });

  it("stops at the frame the level is won, and remembers how", () => {
    const { r, saved } = recorder();
    const scene: SceneDef = { entities: [ground, hero, goalAt(160)] };
    const world = new World(scene);
    r.begin(world, undefined);
    play(r, world, hold(600, "right"));
    const take = saved.get(0)!;
    assert.equal(take.end, "won");
    assert.ok(take.frames < 600, `ended at ${take.frames}`);
    assert.equal(world.won, true);
  });

  it("writes down deaths with cause and place", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, hold(120, "right"));
    r.stop();
    const take = saved.get(0)!;
    assert.ok(take.deaths.length >= 1);
    assert.equal(take.deaths[0]!.cause, "spike");
    assert.equal(take.deathCount, take.deaths.length);
    assert.ok(take.deaths[0]!.x > 100);
  });

  it("a mark holds the frame and place, and one after the end joins the last frame", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, hold(20, "right"));
    r.mark(world, "hard");
    play(r, world, hold(10, "left"));
    r.mark(world, "note", "the spike is hard to see");
    r.stop();
    r.mark(world, "great");
    const { marks, frames } = saved.get(0)!;
    assert.deepEqual(marks.map((m) => [m.kind, m.frame]), [["hard", 20], ["note", 30], ["great", frames]]);
    assert.equal(marks[1]!.text, "the spike is hard to see");
    assert.equal(typeof marks[0]!.x, "number");
  });

  it("a crash keeps the frame and the error, with no fingerprint of a half-done step", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, undefined);
    play(r, world, hold(10, "right"));
    r.crash(world, new Set(), "boom");
    const take = saved.get(0)!;
    assert.equal(take.end, "crashed");
    assert.equal(take.error, "boom");
    assert.equal(take.frames, 11);
    assert.equal(take.checks.length, 0);
  });

  it("flush sends a take still being played, including the run in progress", () => {
    const { r, saved } = recorder();
    const world = new World(SCENE);
    r.begin(world, "scenes/two.scene.json", { score: 3, deaths: 1, lives: undefined });
    play(r, world, hold(15, "right"));
    r.flush();
    const take = saved.get(0)!;
    assert.equal(take.inputs, "right:15f");
    assert.equal(take.end, undefined);
    assert.equal(take.scene, "scenes/two.scene.json");
    assert.deepEqual(take.carry, { score: 3, deaths: 1 });
    play(r, world, hold(5, "right"));
    r.stop();
    assert.equal(saved.get(0)!.inputs, "right:20f");
  });
});

describe("InputScript.at", () => {
  it("finds the segment of any frame, and nothing outside the script", () => {
    const script = InputScript.parse("right:3f, wait:2f, jump:1f");
    assert.deepEqual([0, 2, 3, 4, 5, 6, 99].map((f) => [...script.at(f)]), [["right"], ["right"], [], [], ["jump"], [], []]);
    assert.deepEqual([...InputScript.parse("").at(0)], []);
  });
});

describe("runTest with carry", () => {
  it("starts from what the scene before left", () => {
    const result = runTest(SCENE, { name: "carried", inputs: "wait:2f", carry: { score: 7, deaths: 2 }, assert: ["score == 7", "deaths == 2"] });
    assert.ok(result.pass, JSON.stringify(result.results));
  });
});
