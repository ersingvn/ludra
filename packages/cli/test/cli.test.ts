import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../src/headless.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ludra-cli-"));
const game = join(workDir, "my-game");

function ludra(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

after(() => rmSync(workDir, { recursive: true, force: true }));

describe("ludra CLI", () => {
  test("new creates a project from the template", () => {
    const { code } = ludra("new", game);
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(game, "ludra.json"), "utf8")).name, "my-game");
    assert.match(readFileSync(join(game, ".gitignore"), "utf8"), /screenshots\//);
    assert.equal(existsSync(join(game, "_gitignore")), false);
  });

  test("play --screenshot renders real frames as PNG", { skip: findBrowser() ? false : "no Chrome, Edge or Chromium installed" }, () => {
    const { code, out } = ludra("play", game, "--inputs", "right:0.5s", "--screenshot", "0.25s,end", "--out", "shots", "--json");
    assert.equal(code, 0, out);
    const shots = JSON.parse(out).screenshots as { time: number; file: string }[];
    assert.deepEqual(
      shots.map((s) => s.time.toFixed(2)),
      ["0.25", "2.00"],
      "end is the last frame of the run, which lasts at least 2s",
    );
    for (const name of ["t-0.25s.png", "t-2.00s.png"]) {
      const png = readFileSync(join(game, "shots", name));
      assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from("PNG")], `${name} is a PNG`);
      assert.equal(png.readUInt32BE(16), 960, "width matches the project window");
      assert.equal(png.readUInt32BE(20), 540, "height matches the project window");
    }
  });

  test("play --screenshot rejects a time after the run", () => {
    const { code, out } = ludra("play", game, "--duration", "1s", "--screenshot", "5s");
    assert.equal(code, 1);
    assert.match(out, /after the end of the run/);
  });

  test("check passes on the template", () => {
    const { code, out } = ludra("check", game);
    assert.equal(code, 0, out);
    assert.match(out, /no problems/);
  });

  test("the template's own tests pass", () => {
    const { code, out } = ludra("test", game, "--json");
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).failed, 0);
  });

  test("play reports events and an ASCII frame", () => {
    const { code, out } = ludra("play", game, "--inputs", "wait:0.2s, jump:0.4s", "--ascii");
    assert.equal(code, 0, out);
    assert.match(out, /jump\s+player/);
    assert.match(out, /@/);
  });

  test("the template ships every image it references", () => {
    const { code, out } = ludra("check", game, "--json");
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).diagnostics.filter((d: { code: string }) => d.code === "E_ASSET_MISSING").length, 0);
  });

  test("check reports a missing image and lists the available ones", () => {
    const scenePath = join(game, "scenes", "main.scene.json");
    const original = readFileSync(scenePath, "utf8");
    const scene = JSON.parse(original);
    scene.entities[0].components.sprite.image = "assets/hero.svg";
    writeFileSync(scenePath, JSON.stringify(scene));

    const { code, out } = ludra("check", game, "--json");
    writeFileSync(scenePath, original);
    assert.equal(code, 1);
    const missing = JSON.parse(out).diagnostics.find((d: { code: string }) => d.code === "E_ASSET_MISSING");
    assert.equal(missing.path, "entities[0].components.sprite.image");
    assert.match(missing.fix, /assets\/player\.svg/);
  });

  test("check fails with a fix for a broken scene", () => {
    const scenePath = join(game, "scenes", "main.scene.json");
    const scene = JSON.parse(readFileSync(scenePath, "utf8"));
    scene.entities[0].components.platfromer = scene.entities[0].components.platformer;
    delete scene.entities[0].components.platformer;
    writeFileSync(scenePath, JSON.stringify(scene));

    const { code, out } = ludra("check", game, "--json");
    assert.equal(code, 1);
    const report = JSON.parse(out);
    assert.equal(report.diagnostics[0].code, "E_UNKNOWN_COMPONENT");
    assert.match(report.diagnostics[0].fix, /platformer/);
  });
});
