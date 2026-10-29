import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { changes, findRegions } from "../src/commands/diff.ts";
import { decodePng, encodePng, type Rgba } from "../src/png.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ludra-diff-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function ludra(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8", cwd: dir });
  return { code: result.status, out: result.stdout + result.stderr };
}

/** A width×height image of one colour, with optional filled boxes on it. */
function image(width: number, height: number, boxes: { x: number; y: number; w: number; h: number; rgb: number[] }[] = []): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([40, 60, 90, 255], i * 4);
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) data.set([...b.rgb, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

/** A hand-built RGB PNG whose rows use the given filters, to test decoding filters encodePng never writes. */
function filteredRgbPng(width: number, rows: number[][], filters: number[]): Buffer {
  const raw = Buffer.concat(rows.map((row, y) => Buffer.from([filters[y]!, ...row])));
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("PNG codec", () => {
  test("decodes what it encodes", () => {
    const original = image(13, 7, [{ x: 2, y: 1, w: 4, h: 3, rgb: [250, 10, 0] }]);
    const decoded = decodePng(encodePng(original));
    assert.equal(decoded.width, 13);
    assert.equal(decoded.height, 7);
    assert.deepEqual(decoded.data, original.data);
  });

  test("undoes sub, up, average and Paeth filters on RGB", () => {
    // Two pixels per row. Row 0 plain, then each filter stores differences that decode back to the same values.
    const png = filteredRgbPng(
      2,
      [
        [10, 20, 30, 40, 50, 60],
        [10, 20, 30, 30, 30, 30], // sub: second pixel = first + 30 → 40 50 60
        [0, 0, 0, 0, 0, 0], // up: same as the row above
        [5, 10, 15, 0, 0, 0], // average: first = 5+up/2…, second = (left+up)/2
        [0, 0, 0, 0, 0, 0], // Paeth with zero residue copies the predictor
      ],
      [0, 1, 2, 3, 4],
    );
    const { data } = decodePng(png);
    const pixel = (x: number, y: number) => [...data.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)];
    assert.deepEqual(pixel(1, 1), [40, 50, 60, 255]);
    assert.deepEqual(pixel(0, 2), [10, 20, 30, 255]);
    assert.deepEqual(pixel(1, 2), [40, 50, 60, 255]);
    assert.deepEqual(pixel(0, 3), [10, 20, 30, 255], "5 + floor(10 / 2)");
    assert.deepEqual(pixel(1, 3), [25, 35, 45, 255], "floor((10 + 40) / 2)");
    assert.deepEqual(pixel(0, 4), [10, 20, 30, 255], "Paeth picks up when left and up-left are 0");
    assert.deepEqual(pixel(1, 4), [25, 35, 45, 255], "left + up - upLeft is nearest up");
  });

  test("names what it can't read", () => {
    assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  });
});

describe("change regions", () => {
  test("finds each changed box, largest first, and says where it is", () => {
    const before = image(300, 180);
    const after = image(300, 180, [
      { x: 10, y: 10, w: 20, h: 20, rgb: [255, 255, 255] },
      { x: 200, y: 130, w: 60, h: 30, rgb: [255, 255, 255] },
    ]);
    const regions = findRegions(changes(before, after, 24), 300, 180);
    assert.equal(regions.length, 2);
    assert.equal(regions[0]!.where, "bottom right");
    assert.equal(regions[1]!.where, "top left");
    const small = regions[1]!;
    assert.ok(small.x <= 10 && small.y <= 10 && small.x + small.width >= 30 && small.y + small.height >= 30, "the box covers the change");
  });

  test("ignores changes within the threshold", () => {
    const before = image(16, 16);
    const after = image(16, 16, [{ x: 0, y: 0, w: 16, h: 16, rgb: [50, 70, 100] }]);
    assert.equal(changes(before, after, 24).reduce((s, v) => s + v, 0), 0);
    assert.equal(changes(before, after, 5).reduce((s, v) => s + v, 0), 256);
  });
});

describe("ludra diff", () => {
  const before = join(dir, "before");
  const afterDir = join(dir, "after");
  mkdirSync(before);
  mkdirSync(afterDir);
  writeFileSync(join(before, "t-1.00s.png"), encodePng(image(96, 54)));
  writeFileSync(join(afterDir, "t-1.00s.png"), encodePng(image(96, 54)));
  writeFileSync(join(before, "t-2.00s.png"), encodePng(image(96, 54)));
  writeFileSync(join(afterDir, "t-2.00s.png"), encodePng(image(96, 54, [{ x: 70, y: 4, w: 16, h: 10, rgb: [255, 200, 0] }])));
  writeFileSync(join(afterDir, "t-3.00s.png"), encodePng(image(96, 54)));

  test("compares folders by file name and writes an image for each change", () => {
    const { code, out } = ludra("diff", "before", "after", "--json");
    assert.equal(code, 0, out);
    const results = JSON.parse(out).results as { name: string; status: string; changed?: number; regions?: { where: string }[]; image?: string }[];
    assert.deepEqual(
      results.map((r) => [r.name, r.status]),
      [
        ["t-1.00s.png", "same"],
        ["t-2.00s.png", "changed"],
        ["t-3.00s.png", "added"],
      ],
    );
    const changed = results[1]!;
    assert.equal(changed.changed!.toFixed(4), ((16 * 10) / (96 * 54)).toFixed(4));
    assert.deepEqual(changed.regions!.map((r) => r.where), ["top right"]);
    assert.equal(changed.image, "screenshots/diff/t-2.00s.png");
    const painted = decodePng(readFileSync(join(dir, changed.image!)));
    assert.deepEqual([...painted.data.subarray((8 * 96 + 75) * 4, (8 * 96 + 75) * 4 + 4)], [255, 0, 200, 255], "changed pixels are magenta");
    assert.equal(existsSync(join(dir, "screenshots/diff/t-1.00s.png")), false, "no image for frames that didn't change");
  });

  test("prints a summary with the region", () => {
    const { code, out } = ludra("diff", "before", "after");
    assert.equal(code, 0, out);
    assert.match(out, /3 images compared: 2 changed/);
    assert.match(out, /t-2\.00s\.png +\d+\.\d+% of pixels changed in 1 region/);
    assert.match(out, /top right/);
    assert.match(out, /t-3\.00s\.png added: only in the after folder/);
  });

  test("refuses a file against a folder", () => {
    const { code, out } = ludra("diff", "before/t-1.00s.png", "after");
    assert.equal(code, 1);
    assert.match(out, /a file with a file, or a folder with a folder/);
  });
});
