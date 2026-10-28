import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/solve/", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ludra-fuzz-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

function ludra(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}
const fuzz = (fixture: string, ...args: string[]) => ludra("fuzz", join(FIXTURES, fixture), "--sessions", "60", "--seconds", "20", "--time", "30s", ...args);

describe("ludra fuzz", () => {
  test("finds the pit with no way out, with a line that leads there", () => {
    const { code, out } = fuzz("softlock");
    assert.equal(code, 1, out);
    assert.match(out, /SOFTLOCK at \((3\d\d|4[01]\d), 702\)/);
    assert.match(out, /ludra play \S+ --inputs "[^"]+" --screenshot end/);
    assert.match(out, /fix: give the player a way out/);
  });

  test("passes a fair level and maps where players fall", () => {
    const { code, out } = fuzz("one-jump");
    assert.equal(code, 0, out);
    assert.match(out, /Played 60 random sessions/);
    assert.match(out, /Where players die/);
    assert.match(out, /fall ×\d+: most at \(\d+, \d+\) ×\d+/);
    assert.match(out, /No crashes or softlocks found/);
  });

  test("says when a level can't be won at all, instead of calling every place a trap", () => {
    const { code, out } = fuzz("impossible");
    assert.equal(code, 1, "an unwinnable level fails, like a crash");
    assert.match(out, /UNWINNABLE/);
    assert.match(out, /ludra solve/);
    assert.doesNotMatch(out, /SOFTLOCK/);
  });

  test("--json has the whole result", () => {
    const { code, out } = fuzz("softlock", "--json");
    assert.equal(code, 1);
    const result = JSON.parse(out);
    for (const key of ["sessions", "frames", "wins", "cells", "crashes", "softlocks", "deaths", "winnable", "outOfTime", "seconds"]) assert.ok(key in result, key);
    assert.equal(result.softlocks.length, 1);
    assert.equal(result.winnable, true);
  });

  test("reports a crashing script with the inputs that crash it", () => {
    const dir = join(workDir, "fragile");
    mkdirSync(join(dir, "scenes"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Fragile" }));
    writeFileSync(
      join(dir, "scripts", "bridge.ts"),
      `export default { update({ world }) { const player = world.get("player"); if (player && player.x > 400) throw new Error("the bridge broke"); } };\n`,
    );
    writeFileSync(
      join(dir, "scenes", "main.scene.json"),
      JSON.stringify({
        entities: [
          { id: "ground", components: { transform: { x: 480, y: 520 }, body: { width: 960, height: 40 } } },
          { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } },
          { id: "bridge", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/bridge.ts" } } },
        ],
      }),
    );
    const { code, out } = ludra("fuzz", dir, "--sessions", "40", "--seconds", "10");
    assert.equal(code, 1, out);
    assert.match(out, /CRASH .*the bridge broke/);
    const inputs = /--inputs "([^"]+)"/.exec(out)?.[1];
    assert.ok(inputs, out);
    const replay = ludra("play", dir, "--inputs", inputs!);
    assert.notEqual(replay.code, 0, "the printed inputs reproduce the crash");
    assert.match(replay.out, /the bridge broke/);
  });
});
