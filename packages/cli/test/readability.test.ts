import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../src/headless.ts";
import type { Rgba } from "../src/png.ts";
import { closeEnough, isClear, measurePresence } from "../src/readability.ts";

/** review's "Readable" area: a frame drawn with and without what matters. */

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ludra-readable-"));

after(() => rmSync(workDir, { recursive: true, force: true }));

type Color = [number, number, number];

function image(background: Color, square?: { color: Color; size: number }, speck?: Color): Rgba {
  const width = 64;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = square && x < square.size && y < square.size;
      const color = inside ? square.color : speck && x === 63 && y === 63 ? speck : background;
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function ludra(...args: string[]) {
  const run = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: run.status, out: run.stdout + run.stderr };
}

describe("review: readable", () => {
  const dark: Color = [20, 20, 30];
  const measure = (back: Color, thing: Color) => measurePresence(image(back, { color: thing, size: 10 }), image(back), image(back, { color: thing, size: 10 }));

  test("a speck far away says nothing, unless a speck is all there ever is", () => {
    const presence = (share: number) => ({ pixels: 1, share, contrast: 2, difference: 30, brightness: 0.5 });
    assert.deepEqual(closeEnough([presence(0.00001), presence(0.001)]), [presence(0.001)]);
    assert.deepEqual(closeEnough([presence(0.00001)]), [presence(0.00001)]);
  });

  test("the difference between two drawings is where the thing is", () => {
    const seen = measure(dark, [240, 240, 240]);
    assert.equal(seen.pixels, 100);
    assert.equal(seen.share, 100 / (64 * 64));
    assert.ok(seen.contrast > 10);
    assert.ok(isClear(seen));
  });

  test("nothing changes: it isn't on screen", () => {
    assert.equal(measure(dark, dark).pixels, 0);
  });

  test("near the backdrop's own color is not clear; the same brightness in another color is", () => {
    assert.equal(isClear(measure(dark, [34, 34, 46])), false);
    assert.equal(isClear(measure([200, 60, 60], [60, 190, 60])), true);
    assert.equal(isClear(measure([20, 25, 60], [60, 20, 50])), false, "hue doesn't save it in the dark");
  });

  test("a thing's faint glow doesn't count as the thing", () => {
    const glow = image(dark, { color: [240, 240, 240], size: 10 });
    for (let at = 10 * 4; at < 64 * 4; at += 4) glow.data[at] = 50;
    assert.equal(measurePresence(glow, image(dark), glow).pixels, 100);
  });

  test("the game's own flicker isn't taken for the thing", () => {
    const frame = image(dark, undefined, [255, 255, 255]);
    assert.equal(measurePresence(frame, image(dark), image(dark)).pixels, 0);
  });

  test("a player the color of the night behind it is an issue; a clear one isn't", { skip: findBrowser() ? false : "no Chrome, Edge or Chromium installed" }, () => {
    const game = join(workDir, "night");
    assert.equal(ludra("new", game).code, 0);
    const file = join(game, JSON.parse(readFileSync(join(game, "ludra.json"), "utf8")).entry);
    const readable = () => {
      const { out } = ludra("review", game, "--json");
      return (JSON.parse(out).findings as { area: string; code: string; level: string; where: string; message: string }[]).filter((f) => f.area === "readable");
    };
    assert.deepEqual(readable().filter((f) => f.level === "issue"), [], "the template reads clearly");

    const scene = JSON.parse(readFileSync(file, "utf8"));
    scene.entities = scene.entities.filter((e: { id: string }) => e.id !== "sky");
    const player = scene.entities.find((e: { id: string }) => e.id === "player");
    player.components.sprite = { color: "#33254e", layer: 3 };
    writeFileSync(file, JSON.stringify(scene));
    const blends = readable().find((f) => f.code === "R_LOW_CONTRAST" && f.message.startsWith("The player"));
    assert.ok(blends, "R_LOW_CONTRAST");
    assert.equal(blends.level, "issue");

    player.components.sprite.opacity = 0;
    writeFileSync(file, JSON.stringify(scene));
    assert.ok(readable().some((f) => f.code === "R_PLAYER_NOT_DRAWN"));
  });
});