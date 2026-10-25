import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const player = scene.entities.findIndex((e: { id: string }) => e.id === "player");
    scene.entities[player].components.sprite.image = "assets/hero.svg";
    writeFileSync(scenePath, JSON.stringify(scene));

    const { code, out } = ludra("check", game, "--json");
    writeFileSync(scenePath, original);
    assert.equal(code, 1);
    const missing = JSON.parse(out).diagnostics.find((d: { code: string }) => d.code === "E_ASSET_MISSING");
    assert.equal(missing.path, `entities[${player}].components.sprite.image`);
    assert.match(missing.fix, /assets\/player\.svg/);
  });

  test("check fails with a fix for a broken scene", () => {
    const scenePath = join(game, "scenes", "main.scene.json");
    const original = readFileSync(scenePath, "utf8");
    const scene = JSON.parse(original);
    const player = scene.entities.find((e: { id: string }) => e.id === "player");
    player.components.platfromer = player.components.platformer;
    delete player.components.platformer;
    writeFileSync(scenePath, JSON.stringify(scene));

    const { code, out } = ludra("check", game, "--json");
    writeFileSync(scenePath, original);
    assert.equal(code, 1);
    const report = JSON.parse(out);
    assert.equal(report.diagnostics[0].code, "E_UNKNOWN_COMPONENT");
    assert.match(report.diagnostics[0].fix, /platformer/);
  });
});

describe("ludra review", () => {
  test("a new game has nothing that marks it as unfinished", () => {
    const { code, out } = ludra("review", game, "--json", "--strict");
    assert.equal(code, 0, out);
    const report = JSON.parse(out);
    assert.equal(report.issues, 0, out);
  });

  test("flags the signs of a slop game, and --strict fails on them", () => {
    const bare = join(workDir, "bare");
    mkdirSync(join(bare, "scenes"), { recursive: true });
    writeFileSync(join(bare, "ludra.json"), JSON.stringify({ name: "Bare" }));
    writeFileSync(
      join(bare, "scenes", "main.scene.json"),
      JSON.stringify({
        effects: { jump: { sound: "jump" }, land: { sound: "thud" } },
        entities: [
          { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {}, sprite: { color: "#fff" } } },
          { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#345" } } },
        ],
      }),
    );
    const { code, out } = ludra("review", bare, "--json", "--strict");
    assert.equal(code, 1);
    const codes = (JSON.parse(out).findings as { code: string }[]).map((f) => f.code);
    for (const expected of ["R_NO_TESTS", "R_DEFAULT_HUD", "R_FLAT_BACKDROP", "R_PLAIN_SHAPES", "R_NO_POSTFX", "R_UNNAMED_SCENE", "R_STOCK_SOUNDS", "R_NO_MUSIC"]) {
      assert.ok(codes.includes(expected), `${expected} in ${codes.join(", ")}`);
    }
    assert.equal(ludra("review", bare).code, 0, "without --strict, review only advises");
  });
});

describe("multiple scenes", () => {
  test("check validates every scene, and play can pick one", () => {
    const report = JSON.parse(ludra("check", game, "--json").out);
    assert.deepEqual(
      report.scenes.map((s: { file: string }) => s.file),
      ["scenes/main.scene.json", "scenes/level-2.scene.json"],
    );
    const { code, out } = ludra("play", game, "--scene", "scenes/level-2.scene.json", "--inputs", "right:1s", "--json");
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).final.score, 1, "picked up level 2's first coin");
  });

  test("a broken second scene fails check, with its own file name", () => {
    const path = join(game, "scenes", "level-2.scene.json");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, original.replace('"prefab": "slime"', '"prefab": "slim"'));
      const { code, out } = ludra("check", game);
      assert.equal(code, 1);
      assert.match(out, /level-2\.scene\.json/);
      assert.match(out, /Did you mean "slime"/);
    } finally {
      writeFileSync(path, original);
    }
  });
});

describe("rapier physics through the CLI", () => {
  test("a scene with \"physics\": \"rapier\" loads Rapier on its own for check, play and test", () => {
    const dir = join(workDir, "tumble");
    mkdirSync(join(dir, "scenes"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Tumble" }));
    const body = (width: number, height: number, extra = {}) => ({ type: "dynamic", width, height, ...extra });
    writeFileSync(
      join(dir, "scenes", "main.scene.json"),
      JSON.stringify({
        world: { physics: "rapier" },
        entities: [
          { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } },
          { id: "ramp", components: { transform: { x: 250, y: 300, rotation: 20 }, body: { type: "static", width: 360, height: 16 } } },
          { id: "ball", components: { transform: { x: 110, y: 200 }, body: body(36, 36, { shape: "circle", density: 4 }) } },
          ...[480, 439, 398].map((y, i) => ({ id: `crate-${i + 1}`, components: { transform: { x: 700, y }, body: body(40, 40) } })),
        ],
      }),
    );
    writeFileSync(
      join(dir, "tests", "physics.test.json"),
      JSON.stringify({
        tests: [
          { name: "the ball rolls and spins", duration: "1.5s", assert: ["ball.x > 400", "ball.rotation > 180"] },
          { name: "the tower falls", duration: "4s", assert: ["crate-3.y > 440", "crate-3.rotation != 0"] },
        ],
      }),
    );
    assert.equal(ludra("check", dir).code, 0);
    const played = JSON.parse(ludra("play", dir, "--duration", "1s", "--json").out);
    assert.ok(played.final.entities.ball.rotation > 0, "rotation is in play's output");
    const { code, out } = ludra("test", dir);
    assert.equal(code, 0, out);
  });

  test("a 3D scene loads Rapier 3D on its own for check, play and test", () => {
    const dir = join(workDir, "cubes");
    mkdirSync(join(dir, "scenes"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Cubes" }));
    writeFileSync(
      join(dir, "scenes", "main.scene.json"),
      JSON.stringify({
        world: { dimensions: 3 },
        entities: [
          { id: "floor", components: { transform: { x: 0, y: -0.5, z: 0 }, body: { width: 20, height: 1, depth: 20 } } },
          { id: "hero", components: { transform: { x: 0, y: 0.9, z: 0 }, body: { type: "dynamic", width: 0.6, height: 1.8, shape: "capsule" }, character: {} } },
          { id: "cube", components: { transform: { x: 3, y: 4, z: -2, rotation: { x: 30, y: 20 } }, body: { type: "dynamic", width: 1, height: 1 } } },
        ],
      }),
    );
    writeFileSync(
      join(dir, "tests", "world.test.json"),
      JSON.stringify({
        tests: [
          { name: "the cube lands", duration: "2s", assert: ["cube.y < 0.6", "cube.grounded == true"] },
          { name: "up walks away from the viewer", inputs: "up:1s", assert: ["hero.z < -4 at 1s", "hero.x > -0.01", "hero.x < 0.01"] },
        ],
      }),
    );
    assert.equal(ludra("check", dir).code, 0);
    const played = ludra("play", dir, "--inputs", "up:1s", "--duration", "1s", "--watch", "hero", "--every", "1s");
    assert.equal(played.code, 0, played.out);
    assert.match(played.out, / z +vx +vy +vz +grounded/, "play --watch shows z and vz for 3D scenes");
    const { code, out } = ludra("test", dir);
    assert.equal(code, 0, out);
  });

  test("screenshots of a 3D scene are drawn by Three.js, with and without --debug", { skip: findBrowser() ? false : "no Chrome, Edge or Chromium installed" }, () => {
    const dir = join(workDir, "cubes");
    const scenePath = join(dir, "scenes", "main.scene.json");
    const scene = JSON.parse(readFileSync(scenePath, "utf8"));
    scene.environment = { sky: "#87b5ff" };
    scene.entities.push({ id: "sun", components: { transform: { x: 5, y: 10, z: 5 }, light: { type: "directional", intensity: 2.5 } } });
    for (const e of scene.entities) if (e.components.body) e.components.mesh = { color: e.id === "floor" ? "#6f9a52" : "#ff7a59" };
    writeFileSync(scenePath, JSON.stringify(scene));
    const normal = ludra("play", dir, "--duration", "1s", "--screenshot", "1s", "--out", "shots", "--json");
    assert.equal(normal.code, 0, normal.out);
    const debug = ludra("play", dir, "--duration", "1s", "--screenshot", "1s", "--out", "shots-debug", "--debug", "--json");
    assert.equal(debug.code, 0, debug.out);
    const [plain, overlay] = [join(dir, "shots", "t-1.00s.png"), join(dir, "shots-debug", "t-1.00s.png")].map((p) => readFileSync(p));
    assert.equal(plain!.subarray(1, 4).toString(), "PNG");
    assert.ok(plain!.length > 20000, `a real 3D frame, not a blank one (${plain!.length} bytes)`);
    assert.notDeepEqual(plain, overlay, "the debug view draws colliders over the frame");
  });

  test("screenshots of a rapier scene load Rapier in the browser, with and without --debug", { skip: findBrowser() ? false : "no Chrome, Edge or Chromium installed" }, () => {
    const dir = join(workDir, "tumble");
    const normal = ludra("play", dir, "--duration", "1s", "--screenshot", "1s", "--out", "shots", "--json");
    assert.equal(normal.code, 0, normal.out);
    const debug = ludra("play", dir, "--duration", "1s", "--screenshot", "1s", "--out", "shots-debug", "--debug", "--json");
    assert.equal(debug.code, 0, debug.out);
    const [plain, overlay] = [join(dir, "shots", "t-1.00s.png"), join(dir, "shots-debug", "t-1.00s.png")].map((p) => readFileSync(p));
    assert.equal(plain!.subarray(1, 4).toString(), "PNG");
    assert.notDeepEqual(plain, overlay, "the debug view draws over the frame");
  });
});
