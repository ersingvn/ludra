import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript, simulate, World, type EntityDef, type SceneDef, type Script, type ScriptWorld } from "../src/index.ts";

function wall(id: string, x: number, y: number, width: number, height: number): EntityDef {
  return { id, components: { transform: { x, y }, body: { type: "static", width, height } } };
}

/** A world with these entities, and its script API, as a script would see it. */
function api(entities: EntityDef[], size = { width: 960, height: 540 }): { world: World; nav: ScriptWorld } {
  let nav: ScriptWorld | undefined;
  const probe: Script = { update: ({ world }) => void (nav = world) };
  const scene: SceneDef = { world: { gravity: 0, ...size }, entities: [...entities, { id: "probe", components: { transform: { x: 0, y: 0 }, script: { src: "probe.ts" } } }] };
  const world = new World(scene, { scripts: { "probe.ts": probe } });
  world.step(new Set());
  return { world, nav: nav! };
}

/** True when a walker of `size` going along the path never overlaps a wall. */
function staysClear(from: { x: number; y: number }, path: { x: number; y: number }[], walls: EntityDef[], size: number): boolean {
  let a = from;
  for (const b of path) {
    for (let s = 0; s <= 50; s++) {
      const x = a.x + ((b.x - a.x) * s) / 50;
      const y = a.y + ((b.y - a.y) * s) / 50;
      for (const w of walls) {
        const t = w.components.transform as { x: number; y: number };
        const body = w.components.body as { width: number; height: number };
        if (Math.abs(x - t.x) < body.width / 2 + size / 2 - 0.01 && Math.abs(y - t.y) < body.height / 2 + size / 2 - 0.01) return false;
      }
    }
    a = b;
  }
  return true;
}

describe("world.findPath", () => {
  test("goes straight across open ground", () => {
    const { nav } = api([]);
    assert.deepEqual(nav.findPath({ x: 100, y: 100 }, { x: 700, y: 400 }), [{ x: 700, y: 400 }]);
  });

  test("goes around a wall, keeping the walker's body clear of it", () => {
    const walls = [wall("w", 480, 230, 40, 400)];
    const { nav } = api(walls);
    const path = nav.findPath({ x: 200, y: 200 }, { x: 760, y: 200 }, { size: 24 })!;
    assert.ok(path, "found a way");
    assert.deepEqual(path.at(-1), { x: 760, y: 200 });
    assert.ok(path.length >= 2 && path.length <= 4, `a few corners, not a staircase: ${JSON.stringify(path)}`);
    assert.ok(staysClear({ x: 200, y: 200 }, path, walls, 24));
    // Around the bottom end (y 430), the shorter side.
    assert.ok(path.some((p) => p.y > 430));
  });

  test("a gap narrower than the walker is no way through", () => {
    // A wall across the world with a 50 px gap in the middle (y 250 to 300).
    const walls = [wall("top", 480, 125, 40, 250), wall("bottom", 480, 420, 40, 240)];
    const { nav } = api(walls);
    const small = nav.findPath({ x: 200, y: 270 }, { x: 760, y: 270 }, { size: 16 });
    assert.ok(small && staysClear({ x: 200, y: 270 }, small, walls, 16), "a 16 px walker fits");
    assert.equal(nav.findPath({ x: 200, y: 270 }, { x: 760, y: 270 }, { size: 60 }), undefined, "a 60 px one doesn't");
  });

  test("no way into a closed room, and a target inside a wall ends beside it", () => {
    const room = [wall("n", 700, 300, 120, 10), wall("s", 700, 420, 120, 10), wall("w", 645, 360, 10, 130), wall("e", 755, 360, 10, 130)];
    const { nav } = api(room);
    assert.equal(nav.findPath({ x: 100, y: 100 }, { x: 700, y: 360 }), undefined);
    const { nav: nav2 } = api([wall("block", 500, 300, 100, 100)]);
    const end = nav2.findPath({ x: 100, y: 300 }, { x: 500, y: 300 }, { size: 20 })!.at(-1)!;
    assert.ok(end.x < 500 - 50 - 10 + 0.01 || end.x > 500 + 50 + 10 - 0.01 || end.y < 300 - 60 || end.y > 300 + 60, `outside the block: ${JSON.stringify(end)}`);
  });

  test("a wall that goes away opens the way, and the same world always gives the same path", () => {
    const { world, nav } = api([wall("door", 480, 270, 40, 540)]);
    assert.equal(nav.findPath({ x: 200, y: 270 }, { x: 760, y: 270 }), undefined);
    nav.destroy("door");
    assert.deepEqual(nav.findPath({ x: 200, y: 270 }, { x: 760, y: 270 }), [{ x: 760, y: 270 }]);
    void world;
    const maze = [wall("a", 300, 200, 20, 400), wall("b", 500, 340, 20, 400), wall("c", 700, 200, 20, 400)];
    const one = api(maze).nav.findPath({ x: 100, y: 100 }, { x: 860, y: 450 });
    const two = api(maze).nav.findPath({ x: 100, y: 100 }, { x: 860, y: 450 });
    assert.ok(one && one.length >= 3, "winds through the maze");
    assert.deepEqual(one, two);
    assert.ok(staysClear({ x: 100, y: 100 }, one, maze, 24));
  });

  test("a script walks an enemy along it to the player", () => {
    const hunter: Script = {
      update({ self, world }) {
        const target = world.player()!;
        const path = world.findPath(self, target, { size: 20 });
        const next = path?.[0];
        if (!next) return;
        const dx = next.x - self.x;
        const dy = next.y - self.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        self.vx = (dx / d) * 150;
        self.vy = (dy / d) * 150;
      },
    };
    const scene: SceneDef = {
      world: { gravity: 0 },
      entities: [
        wall("w", 480, 200, 40, 400),
        { id: "hero", components: { transform: { x: 760, y: 100 }, body: { type: "dynamic", width: 20, height: 20 }, topdown: { speed: 0 } } },
        { id: "hunter", components: { transform: { x: 200, y: 100 }, body: { type: "dynamic", width: 20, height: 20 }, script: { src: "hunter.ts" } } },
      ],
    };
    const world = new World(scene, { scripts: { "hunter.ts": hunter } });
    simulate(world, InputScript.parse(""), 60 * 8);
    const h = world.get("hunter")!.transform;
    assert.ok(Math.abs(h.x - 760) < 30 && Math.abs(h.y - 100) < 30, `reached the player: ${h.x}, ${h.y}`);
  });

  test("says what's wrong with a bad call", () => {
    const { nav } = api([]);
    assert.throws(() => nav.findPath({ x: 1 } as never, { x: 2, y: 2 }), /from must be a point/);
    assert.throws(() => nav.findPath({ x: 1, y: 1 }, { x: 2, y: 2 }, { size: 0 }), /size/);
  });
});
