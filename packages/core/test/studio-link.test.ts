import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectStudio, entityAt, entityJson, entitySummary, inputKey, REPLAY_LIMIT, replayScene, type GameControl, type GameView } from "../src/studio-link.ts";
import type { StudioGhost, StudioLook, StudioPreview } from "../src/studio-draw.ts";
import { validateScene } from "../src/validate.ts";
import type { Action, SceneDef } from "../src/types.ts";
import { World } from "../src/world.ts";

const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#335" } } };
const player = { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } };
const coin = { id: "coin", components: { transform: { x: 700, y: 470 }, body: { type: "static", width: 16, height: 16, sensor: true }, collectible: { value: 5 } } };

function scene(entities: unknown[]): SceneDef {
  const { scene, diagnostics } = validateScene({ entities });
  assert.ok(scene, JSON.stringify(diagnostics));
  return scene;
}

/** What a person played: right for 2 s with a jump in the middle, then nothing for 1 s. */
function played(): string[] {
  const keys: string[] = [];
  for (let f = 0; f < 180; f++) {
    const input = new Set<Action>(f < 120 ? ["right"] : []);
    if (f >= 40 && f < 46) input.add("jump");
    keys.push(inputKey(input));
  }
  return keys;
}

function live(def: SceneDef, keys: readonly string[]): World {
  const world = new World(def);
  for (const k of keys) world.step(new Set(k === "" ? [] : (k.split("+") as Action[])));
  return world;
}

describe("hot reload by replay", () => {
  it("keeps the moment: an edit that doesn't touch the run gives the same frame and the same state", () => {
    const before = scene([ground, player, coin]);
    const keys = played();
    const running = live(before, keys);
    const edited = scene([{ ...ground, components: { ...ground.components, sprite: { color: "#7a4" } } }, player, coin, { id: "cloud", components: { transform: { x: 300, y: 100 }, sprite: { color: "#fff", width: 60, height: 20 } } }]);
    const replayed = replayScene(edited, keys);
    assert.equal(replayed.result, "kept");
    assert.equal(replayed.world.frame, running.frame);
    const p = (w: World) => w.entities.find((e) => e.id === "player")!;
    assert.deepEqual([p(replayed.world).transform.x, p(replayed.world).transform.y], [p(running).transform.x, p(running).transform.y]);
    assert.equal(replayed.world.score, running.score);
    assert.ok(replayed.world.entities.some((e) => e.id === "cloud"), "the new entity is there");
  });

  it("an edit that changes the run still keeps the frame, with the run the new version gives", () => {
    const keys = played();
    const faster = scene([ground, { ...player, components: { ...player.components, platformer: { speed: 300 } } }, coin]);
    const replayed = replayScene(faster, keys);
    assert.equal(replayed.result, "kept");
    assert.equal(replayed.world.frame, keys.length);
    assert.ok(replayed.world.entities.find((e) => e.id === "player")!.transform.x > live(scene([ground, player, coin]), keys).entities.find((e) => e.id === "player")!.transform.x);
  });

  it("restarts when the edit ends the scene sooner, and says why", () => {
    const keys = played();
    const goal = { id: "flag", components: { transform: { x: 200, y: 470 }, body: { type: "static", width: 30, height: 60, sensor: true }, goal: {} } };
    const replayed = replayScene(scene([ground, player, goal]), keys);
    assert.equal(replayed.result, "restarted");
    assert.match((replayed as { reason: string }).reason, /is won at frame \d+, before frame 180/);
    assert.equal(replayed.world.frame, 0, "a fresh start");
  });

  it("restarts when a script throws on the way, and when it's more than 2 minutes in", () => {
    const thrower = scene([ground, player]);
    const scripts = new Map([["boom.ts", { update: ({ world }: { world: { frame: number } }) => { if (world.frame === 30) throw new Error("kaboom"); } }]]);
    const withScript = { ...thrower, entities: [...thrower.entities, { id: "boom", components: { transform: { x: 0, y: 0 }, script: { src: "boom.ts" } } }] } as SceneDef;
    const threw = replayScene(scene(withScript.entities as unknown[]), played(), { scripts: scripts as never });
    assert.equal(threw.result, "restarted");
    assert.match((threw as { reason: string }).reason, /replaying threw: .*kaboom/);

    const long = Array.from({ length: REPLAY_LIMIT + 1 }, () => "");
    const far = replayScene(scene([ground, player]), long);
    assert.equal(far.result, "restarted");
    assert.equal((far as { reason: string }).reason, "too far in to replay");
    assert.equal(replayScene(scene([ground, player]), long.slice(1)).result, "kept", "exactly the limit still replays");
  });

  it("writes inputs in one order, whatever order they were pressed in", () => {
    assert.equal(inputKey(new Set<Action>(["jump", "left"])), "left+jump");
    assert.equal(inputKey(new Set()), "");
  });
});

describe("entities for Studio", () => {
  it("summarizes and serializes entities with live values, however they refer to each other", () => {
    const world = live(scene([ground, player, coin]), Array.from({ length: 30 }, () => ""));
    const p = world.entities.find((e) => e.id === "player")!;
    const summary = entitySummary(p, 2);
    assert.equal(summary.id, "player");
    assert.ok(summary.components.includes("platformer") && summary.components.includes("body") && summary.components.includes("transform"));
    assert.ok(!summary.components.includes("state"));
    assert.equal(summary.z, undefined);
    const json = entityJson(p);
    assert.doesNotThrow(() => JSON.stringify(json));
    assert.equal((json.components.transform as { x: number }).x, p.transform.x);
  });

  it("picks the smallest entity under a point", () => {
    const world = new World(scene([ground, player, { id: "pebble", components: { transform: { x: 100, y: 515 }, sprite: { color: "#999", width: 6, height: 6 } } }]));
    assert.equal(entityAt(world, 100, 515)?.id, "pebble");
    assert.equal(entityAt(world, 600, 520)?.id, "ground");
    assert.equal(entityAt(world, 100, 482)?.id, "player");
    assert.equal(entityAt(world, 500, 100), undefined);
  });
});

describe("the editing link (v0.99)", () => {
  /** A game page with no browser: the link's window is an EventTarget, and the control a stand-in that writes down what Studio asked. */
  function connected(dimensions: 2 | 3 = 2) {
    const page = new EventTarget();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { add: g.addEventListener, remove: g.removeEventListener };
    g.addEventListener = page.addEventListener.bind(page);
    g.removeEventListener = page.removeEventListener.bind(page);
    const world = new World(scene([ground, player, coin]));
    const asked: { preview: (StudioPreview | null)[]; ghost: (StudioGhost | null)[]; grid: number[]; look: (StudioLook | null)[] } = { preview: [], ghost: [], grid: [], look: [] };
    let view: GameView | undefined = dimensions === 2 ? { cameraX: 0, cameraY: 0, zoom: 1, width: 960, height: 540, rect: { left: 10, top: 20, width: 480, height: 270 } } : undefined;
    const control = {
      world,
      scene: scene([]),
      scenePath: "scenes/main.scene.json",
      paused: true,
      fps: 60,
      canvas: { width: 960, height: 540 },
      get view() {
        return view;
      },
      pause() {},
      resume() {},
      step() {},
      restart() {},
      goto: async () => {},
      mute() {},
      focus() {},
      highlight() {},
      pointToWorld: () => undefined,
      hot: async () => ({ result: "kept" as const, frame: 0 }),
      on() {},
      preview: (p: StudioPreview | null) => void asked.preview.push(p),
      ghost: (x: StudioGhost | null) => void asked.ghost.push(x),
      grid: (n: number) => void asked.grid.push(n),
      look: (l: StudioLook | null) => void asked.look.push(l),
    } as unknown as GameControl;
    const sent: { type: string; [k: string]: unknown }[] = [];
    const link = connectStudio(control, { postMessage: (m: unknown) => void sent.push(m as { type: string }) } as Pick<Window, "postMessage">);
    const say = (m: Record<string, unknown>) => page.dispatchEvent(new MessageEvent("message", { data: { ludra: 1, ...m } }));
    const done = () => {
      link.close();
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
    };
    return { sent, say, asked, done, setView: (v: GameView | undefined) => (view = v) };
  }

  it("tells Studio the camera and where the canvas is, with the first status and when they change", async () => {
    const c = connected();
    try {
      const views = () => c.sent.filter((m) => m.type === "view");
      assert.equal(views().length, 1);
      assert.deepEqual(views()[0], { ludra: 1, type: "view", cameraX: 0, cameraY: 0, zoom: 1, width: 960, height: 540, rect: { left: 10, top: 20, width: 480, height: 270 } });
      c.setView({ cameraX: 120.456, cameraY: 0, zoom: 2, width: 960, height: 540, rect: { left: 10, top: 20, width: 480, height: 270 } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(views().length, 2);
      assert.equal(views()[1]!.cameraX, 120.46);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(views().length, 2, "nothing new, nothing sent");
    } finally {
      c.done();
    }
  });

  it("sends no view in 3D", () => {
    const c = connected(3);
    try {
      assert.equal(c.sent.some((m) => m.type === "view"), false);
    } finally {
      c.done();
    }
  });

  it("answers pickAt with what is at a world point, and passes preview, ghost, grid and look on", () => {
    const c = connected();
    try {
      c.say({ type: "pickAt", x: 700, y: 470, tag: 3 });
      c.say({ type: "pickAt", x: 500, y: 100 });
      assert.deepEqual(c.sent.filter((m) => m.type === "picked").map((m) => [m.id, m.tag]), [["coin", 3], [null, undefined]]);
      c.say({ type: "preview", id: "coin", x: 650, y: 400 });
      c.say({ type: "preview", id: null });
      c.say({ type: "preview", id: "coin", x: "far" });
      assert.deepEqual(c.asked.preview, [{ id: "coin", x: 650, y: 400 }, null]);
      c.say({ type: "ghost", prefab: "slime", x: 10, y: 20 });
      c.say({ type: "ghost", components: { sprite: { color: "#f00" } }, x: 1, y: 2 });
      c.say({ type: "ghost", prefab: null });
      assert.deepEqual(c.asked.ghost, [{ prefab: "slime", x: 10, y: 20 }, { components: { sprite: { color: "#f00" } }, x: 1, y: 2 }, null]);
      c.say({ type: "grid", size: 32 });
      c.say({ type: "grid", size: -4 });
      assert.deepEqual(c.asked.grid, [32, 0]);
      c.say({ type: "look", x: 700, y: 470, zoom: 3 });
      c.say({ type: "look", x: null });
      assert.deepEqual(c.asked.look, [{ x: 700, y: 470, zoom: 3 }, null]);
    } finally {
      c.done();
    }
  });
});

describe("placement ghosts", () => {
  it("are their prefab's components with their own on top", async () => {
    const { ghostComponents } = await import("../src/studio-draw.ts");
    const def = { entities: [], prefabs: { slime: { components: { body: { type: "kinematic", width: 30, height: 20 }, sprite: { color: "#6c6" } } } } } as unknown as SceneDef;
    assert.deepEqual(ghostComponents(def, { prefab: "slime", components: { sprite: { width: 40 } }, x: 0, y: 0 }), {
      body: { type: "kinematic", width: 30, height: 20 },
      sprite: { color: "#6c6", width: 40 },
    });
    assert.deepEqual(ghostComponents(def, { prefab: "missing", x: 0, y: 0 }), {});
  });
});
