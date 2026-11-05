import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fuzz, World } from "@ludra/core";
import { loadGame, loadProject } from "../src/project.ts";

/** review's "Fair" area: timing windows of the win test's route, and random play for crashes and softlocks. */

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/solve/${name}`, import.meta.url));

function review(dir: string, ...flags: string[]): { code: string; level: string; message: string }[] {
  const run = spawnSync(process.execPath, ["--conditions=ludra-dev", CLI, "review", dir, "--json", ...flags], { encoding: "utf8" });
  return JSON.parse(run.stdout).findings;
}

describe("review: fair", () => {
  test("a jump that only works within 0.1 s is pointed out, with the test and the moment", () => {
    const tight = review(fixture("narrow-window"), "--fast").find((f) => f.code === "R_TIGHT_TIMING");
    assert.ok(tight, "R_TIGHT_TIMING");
    assert.equal(tight.level, "idea");
    assert.match(tight.message, /jump at 1\.45s \(6 frames\)/);
  });

  test("a roomy jump isn't", () => {
    const codes = review(fixture("one-jump"), "--fast").map((f) => f.code);
    assert.ok(!codes.includes("R_TIGHT_TIMING") && !codes.includes("R_FRAME_PERFECT"), codes.join(", "));
  });

  test("random play finds the pit that traps the player, unless --fast", () => {
    const trap = review(fixture("softlock")).find((f) => f.code === "R_SOFTLOCK");
    assert.ok(trap, "R_SOFTLOCK");
    assert.equal(trap.level, "issue");
    assert.ok(!review(fixture("softlock"), "--fast").some((f) => f.code === "R_SOFTLOCK"));
  });

  test("random play is a fixed amount of work: a slow machine finds what a fast one does", async () => {
    const { game } = await loadGame(loadProject(fixture("softlock")));
    assert.ok(game);
    const make = () => new World(game.scene, { scripts: game.scripts });
    const fast = fuzz(make, { sessions: 200, seconds: 30, work: 200_000 });
    // A deadline that is checked often but never reached, and wastes time each check, like a busy machine.
    const slow = fuzz(make, { sessions: 200, seconds: 30, work: 200_000, deadline: () => { for (let i = 0; i < 2_000; i++) Math.sqrt(i); return false; } });
    // It stops once the budget is spent, give or take the last held key or search step.
    assert.ok(fast.outOfWork && fast.work >= 200_000 && fast.work < 201_000, `work ${fast.work}`);
    assert.deepEqual(slow, fast);
    assert.equal(fast.softlocks.length, 1);
  });
});
