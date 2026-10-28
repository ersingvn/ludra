import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/solve/", import.meta.url));

function solve(fixture: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "solve", join(FIXTURES, fixture), "--time", "20s", ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

describe("ludra solve", () => {
  test("finds the fastest walk, with a play line and a test to paste", () => {
    const { code, out } = solve("easy-walk");
    assert.equal(code, 0, out);
    assert.match(out, /SOLVED: a win at 2\.45s \(frame 147\)/);
    assert.match(out, /--inputs "right:147f"/);
    assert.match(out, /\{"name":"[^"]+","inputs":"right:147f","assert":\["won == true"\]\}/);
    assert.match(out, /explored [\d,]+ frames, [\d,]+ cells, method save/);
  });

  test("calls a six-frame jump tight", () => {
    const { code, out } = solve("narrow-window");
    assert.equal(code, 0, out);
    assert.match(out, /jump\s+at 1\.40s \(frame 84\)\s+window 6 frames \(0\.10s\).*tight/);
  });

  test("exits 1 when every reachable place was tried, and shows the closest approach", () => {
    const { code, out } = solve("impossible");
    assert.equal(code, 1, out);
    assert.match(out, /UNSOLVED/);
    assert.match(out, /Every reachable place was tried/);
    assert.match(out, /Closest approach .* --screenshot end/s);
  });

  test("goes back for the key before the door", () => {
    const { code, out } = solve("needs-key", "--json");
    assert.equal(code, 0, out);
    const result = JSON.parse(out);
    assert.equal(result.solved, true);
    assert.match(result.inputs, /^left:/, "the route starts by going left, to the key");
  });

  test("--json has the whole result", () => {
    const { code, out } = solve("one-jump", "--json");
    assert.equal(code, 0, out);
    const result = JSON.parse(out);
    for (const key of ["solved", "inputs", "frame", "exhausted", "explored", "cells", "method", "windows", "seconds", "outOfTime"]) assert.ok(key in result, `${key} in ${out}`);
    assert.equal(result.frame, 177);
    assert.deepEqual(result.windows.map((w: { width: number }) => w.width), [20], "the measured 20-frame window");
  });

  test("--goal takes a test assertion", () => {
    const { code, out } = solve("easy-walk", "--goal", "player.x > 400", "--json");
    assert.equal(code, 0, out);
    const { frame } = JSON.parse(out);
    assert.ok(frame > 60 && frame < 147, `x passes 400 before the goal is touched (frame ${frame})`);
    const bad = solve("easy-walk", "--goal", "player.x > 400 at 1s");
    assert.equal(bad.code, 1);
    assert.match(bad.out, /leave out "at/);
  });

  test("running out of time says so and suggests more", () => {
    const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "solve", join(FIXTURES, "impossible"), "--time", "1ms"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ran out of time .* Try --time 1s/);
    const minutes = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "solve", join(FIXTURES, "easy-walk"), "--time", "0.5m", "--json"], { encoding: "utf8" });
    assert.equal(minutes.status, 0, minutes.stderr);
  });
});
