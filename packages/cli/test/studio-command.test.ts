import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/** `ludra studio` opens the desktop app; these check what it says before any window opens. */

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const ludra = (...args: string[]) => spawnSync(process.execPath, ["--conditions=ludra-dev", CLI, ...args], { encoding: "utf8" });

describe("ludra studio", () => {
  test("is in the help", () => {
    assert.match(ludra("--help").stdout, /ludra studio \[folder\]/);
  });

  test("wants a game folder", () => {
    const run = ludra("studio", fileURLToPath(new URL(".", import.meta.url)));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /No ludra\.json/);
  });

  test("rejects a bad port before opening anything", () => {
    const run = ludra("studio", fileURLToPath(new URL("../templates/platformer", import.meta.url)), "--port", "nope");
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Invalid --port/);
  });
});
