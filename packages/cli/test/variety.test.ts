import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SceneDef } from "@ludra/core";
import { findBrowser } from "../src/headless.ts";
import { decodePng, type Rgba } from "../src/png.ts";
import { areAlike, hueOverlap, hueProfile, repeatedTiles } from "../src/variety.ts";

/** Whether a game varies: its levels, and the blocks they are built of. */

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ludra-variety-"));

after(() => rmSync(workDir, { recursive: true, force: true }));

function ludra(...args: string[]) {
  const run = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8", cwd: workDir });
  return { code: run.status, out: run.stdout + run.stderr };
}

function flat(color: [number, number, number]): Rgba {
  const data = new Uint8Array(32 * 32 * 4);
  for (let at = 0; at < data.length; at += 4) data.set([...color, 255], at);
  return { width: 32, height: 32, data };
}

const tile = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#556"/></svg>`;

function sceneWith(sprite: Record<string, unknown>, width: number, height: number): SceneDef {
  return { entities: [{ id: "wall", components: { transform: { x: 0, y: 0 }, body: { type: "static", width, height }, sprite } }] } as unknown as SceneDef;
}

describe("levels that look like each other", () => {
  test("the same color overlaps fully, a darker shade of it nearly so, another hue not at all", () => {
    const teal = hueProfile(flat([40, 140, 130]));
    assert.ok(hueOverlap(teal, hueProfile(flat([40, 140, 130]))) > 0.99);
    assert.ok(areAlike(hueOverlap(teal, hueProfile(flat([24, 90, 84])))));
    assert.ok(!areAlike(hueOverlap(teal, hueProfile(flat([160, 60, 170])))));
  });

  test("a grey frame has no hues to compare", () => {
    assert.deepEqual(hueProfile(flat([90, 90, 90])), new Array(12).fill(0));
  });
});

describe("tiles that show their grid", () => {
  const dir = join(workDir, "tiles");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "rock.svg"), tile(40));

  test("a thick block of one image is counted", () => {
    const sprite = { image: "assets/rock.svg", tile: true };
    assert.deepEqual(repeatedTiles(dir, sceneWith(sprite, 400, 320)), [{ image: "assets/rock.svg", cells: 80 }]);
  });

  test("variants, a floor strip and a small block are fine", () => {
    assert.deepEqual(repeatedTiles(dir, sceneWith({ image: "assets/rock.svg", tile: true, variants: ["assets/rock2.svg"] }, 400, 320)), []);
    assert.deepEqual(repeatedTiles(dir, sceneWith({ image: "assets/rock.svg", tile: true }, 4000, 80)), []);
    assert.deepEqual(repeatedTiles(dir, sceneWith({ image: "assets/rock.svg", tile: true }, 160, 160)), []);
  });

  test("variants really are mixed in by the renderer", { skip: !findBrowser() && "no browser" }, () => {
    const game = join(workDir, "mixed");
    mkdirSync(join(game, "assets"), { recursive: true });
    mkdirSync(join(game, "scenes"), { recursive: true });
    const fill = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`;
    writeFileSync(join(game, "assets", "red.svg"), fill("#ff0000"));
    writeFileSync(join(game, "assets", "blue.svg"), fill("#0000ff"));
    writeFileSync(join(game, "ludra.json"), JSON.stringify({ name: "Mixed", window: { width: 400, height: 200 } }));
    writeFileSync(
      join(game, "scenes", "main.scene.json"),
      JSON.stringify({
        world: { width: 400, height: 200 },
        entities: [
          { id: "player", components: { transform: { x: 200, y: -300 }, body: { type: "dynamic", width: 10, height: 10 }, platformer: {} } },
          {
            id: "wall",
            components: {
              transform: { x: 0, y: 0 },
              tilemap: { tileSize: 40, rows: ["##########", "##########", "##########", "##########", "##########"], legend: { "#": { image: "assets/red.svg", variants: ["assets/blue.svg"] } } },
            },
          },
        ],
      }),
    );
    const { code, out } = ludra("play", game, "--seconds", "0.1", "--screenshot", "0.05s");
    assert.equal(code, 0, out);
    const shots = join(game, "screenshots");
    const { data } = decodePng(readFileSync(join(shots, readdirSync(shots)[0]!)));
    let red = 0;
    let blue = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at]! > 200 && data[at + 2]! < 60) red++;
      if (data[at + 2]! > 200 && data[at]! < 60) blue++;
    }
    assert.ok(red > 0 && blue > 0, `red ${red}, blue ${blue}`);
  });
});
