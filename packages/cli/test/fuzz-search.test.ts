import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fuzz, InputScript, validateScene, World, type FuzzOptions, type Script } from "@ludra/core";
import { loadGame, loadProject } from "../src/project.ts";

/** The random play behind `ludra fuzz`, on levels whose traps are known (fixtures/solve/README.md). */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/solve/${name}`, import.meta.url));

async function fuzzFixture(name: string, options: FuzzOptions = {}) {
  const { game, diagnostics } = await loadGame(loadProject(fixture(name)));
  assert.ok(game, JSON.stringify(diagnostics));
  return fuzz(() => new World(game.scene, { scripts: game.scripts }), { sessions: 60, seconds: 20, ...options });
}

describe("fuzz", () => {
  test("finds the pit a player can fall into but never leave, once, with inputs that lead there", async () => {
    const result = await fuzzFixture("softlock");
    assert.equal(result.winnable, true);
    assert.equal(result.softlocks.length, 1);
    const trap = result.softlocks[0]!;
    // The pit spans x 300 to 420; its floor puts the player at y 702.
    assert.ok(trap.x > 300 && trap.x < 420 && Math.abs(trap.y - 702) < 2, JSON.stringify(trap));

    // The inputs really put the player there, and it really can't get out.
    const { game } = await loadGame(loadProject(fixture("softlock")));
    const world = new World(game!.scene, { scripts: game!.scripts });
    const script = InputScript.parse(trap.inputs);
    while (world.frame < script.totalFrames) world.step(script.at(world.frame));
    assert.equal(world.get("player")!.transform.x, trap.x);
  });

  test("reports no softlocks where there are none, and where players fall", async () => {
    const result = await fuzzFixture("one-jump");
    assert.equal(result.softlocks.length, 0);
    assert.equal(result.deaths[0]?.cause, "fall");
    assert.ok(result.deaths[0]!.places.length > 0);
  });

  test("says when the level can't be won at all, instead of calling every place a trap", async () => {
    const result = await fuzzFixture("impossible");
    assert.equal(result.winnable, false);
    assert.equal(result.softlocks.length, 0);
  });

  test("catches a script that crashes, with the inputs that make it crash", () => {
    const fragile: Script = {
      update({ world }) {
        const player = world.get("player");
        if (player && player.x > 400) throw new Error("the bridge broke");
      },
    };
    const { scene } = validateScene({
      entities: [
        { id: "ground", components: { transform: { x: 480, y: 520 }, body: { width: 960, height: 40 } } },
        { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } },
        { id: "bridge", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/bridge.ts" } } },
      ],
    });
    const scripts = new Map([["scripts/bridge.ts", fragile]]);
    const result = fuzz(() => new World(scene!, { scripts }), { sessions: 40, seconds: 10 });
    assert.equal(result.crashes.length, 1);
    assert.match(result.crashes[0]!.message, /the bridge broke/);
    assert.ok(result.crashes[0]!.x > 400);

    const replay = new World(scene!, { scripts });
    const script = InputScript.parse(result.crashes[0]!.inputs);
    assert.throws(() => {
      while (replay.frame < script.totalFrames) replay.step(script.at(replay.frame));
    }, /the bridge broke/);
  });

  test("the same seed plays the same sessions", async () => {
    const a = await fuzzFixture("needs-key", { sessions: 20, seed: 3 });
    const b = await fuzzFixture("needs-key", { sessions: 20, seed: 3 });
    assert.deepEqual(a, b);
  });
});
