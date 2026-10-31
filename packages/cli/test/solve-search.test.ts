import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ArcadePhysics, solve, World, type SolveOptions } from "@ludra/core";
import { loadGame, loadProject } from "../src/project.ts";

/**
 * The search behind `ludra solve`, on levels whose answers were measured by hand frame by frame
 * (see fixtures/solve/README.md): it must find the same windows, routes and impossibilities.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/solve/${name}`, import.meta.url));

async function solveFixture(name: string, options: SolveOptions = {}, physics?: () => ArcadePhysics) {
  const { game, diagnostics } = await loadGame(loadProject(fixture(name)));
  assert.ok(game, JSON.stringify(diagnostics));
  return solve(() => new World(game.scene, { scripts: game.scripts, physics: physics?.() }), options);
}

describe("solve", () => {
  test("finds the fastest walk, frame for frame", async () => {
    const result = await solveFixture("easy-walk");
    assert.equal(result.solved, true);
    assert.equal(result.inputs, "right:147f");
    assert.equal(result.frame, 147);
    assert.deepEqual(result.windows, []);
  });

  test("measures a jump's timing window as wide as it really is", async () => {
    const roomy = await solveFixture("one-jump");
    assert.equal(roomy.solved, true);
    assert.equal(roomy.windows!.length, 1);
    // Measured by hand: presses from frame 70 to 89 clear the gap.
    assert.equal(roomy.windows![0]!.width, 20);

    const tight = await solveFixture("narrow-window");
    assert.equal(tight.solved, true);
    // Frames 84 to 89, and nothing else.
    assert.deepEqual({ ...tight.windows![0]!, action: undefined }, { frame: 84, action: undefined, early: 0, late: 5, width: 6 });
  });

  test("says when a level can't be won, and how close the player got", async () => {
    const result = await solveFixture("impossible");
    assert.equal(result.solved, false);
    assert.equal(result.exhausted, true);
    assert.ok(result.closest && result.closest.distance > 0);
    assert.equal(result.inputs, undefined);
  });

  test("finds routes that first lead away from the goal", async () => {
    const result = await solveFixture("needs-key");
    assert.equal(result.solved, true);
    assert.match(result.inputs!, /left/, "it goes back for the key");
  });

  test("never wins by dying, unless allowed", async () => {
    const result = await solveFixture("softlock");
    assert.equal(result.solved, true);
  });

  test("solves 3D levels on Rapier 3D", async () => {
    const result = await solveFixture("3d-hop");
    assert.equal(result.solved, true);
    assert.equal(result.windows!.filter((w) => w.action === "jump").length >= 3, true);
  });

  test("falls back to replaying from frame 0 on an engine that can't save, with the same answer", async () => {
    const result = await solveFixture("easy-walk", {}, () => Object.assign(new ArcadePhysics(), { save: undefined, restore: undefined }));
    assert.equal(result.method, "replay");
    assert.equal(result.inputs, "right:147f");
  });

  test("the same seed gives the same search", async () => {
    const a = await solveFixture("one-jump", { seed: 7, windows: false });
    const b = await solveFixture("one-jump", { seed: 7, windows: false });
    assert.deepEqual(a, b);
  });
});
