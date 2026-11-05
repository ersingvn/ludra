import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { glb } from "./models.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface Finding {
  level: string;
  area: string;
  code: string;
  where: string;
  message: string;
}

/** The Shipping area of `ludra review --fast` on a game made of these scenes and files. */
function shipping(entities: unknown[], extra: { world?: object; files?: Record<string, string | Buffer> } = {}): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), "ludra-shipping-"));
  try {
    writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Shipping Test", entry: "main.scene.json" }));
    writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ ...(extra.world ? { world: extra.world } : {}), entities }));
    for (const [path, data] of Object.entries(extra.files ?? {})) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "review", dir, "--fast", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
    const report = JSON.parse(result.stdout) as { findings: Finding[] };
    return report.findings.filter((f) => f.area === "shipping" || f.code === "R_CHECK_FAILS");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#335" } } };
const dots = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `dot-${i}`, components: { transform: { x: i % 960, y: Math.floor(i / 960) * 4 }, sprite: { color: "#fff", width: 2, height: 2 } } }));

/** The first bytes of a PNG this size: all `ludra inspect` and review read. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.writeUInt8(8, 24);
  header.writeUInt8(6, 25);
  return header;
}

/** A model of `triangles` triangles, every one the same three points: heavy to draw, light to store. */
function heavyModel(triangles: number): Buffer {
  const position = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => position.writeFloatLE(v, i * 4));
  const indices = Buffer.alloc(triangles * 3 * 2);
  for (let i = 0; i < triangles * 3; i++) indices.writeUInt16LE(i % 3, i * 2);
  const bin = Buffer.concat([position, indices]);
  return glb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: triangles * 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: position.length },
        { buffer: 0, byteOffset: position.length, byteLength: indices.length },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
}

describe("review's Shipping area", () => {
  it("has nothing to say about a small game", () => {
    assert.deepEqual(shipping([ground]), []);
  });

  it("counts entities alive at once: an idea past 2000, an issue past 6000", () => {
    const some = shipping([ground, ...dots(2100)]).find((f) => f.code === "R_MANY_ENTITIES");
    assert.equal(some?.level, "idea", JSON.stringify(some));
    assert.match(some!.message, /2101 entities/);
    assert.equal(shipping([ground, ...dots(6100)]).find((f) => f.code === "R_MANY_ENTITIES")?.level, "issue");
  });

  it("points out an image over 4096 px", () => {
    const sprite = { id: "sky", components: { transform: { x: 480, y: 270 }, sprite: { image: "art/sky.png", width: 960, height: 540 } } };
    const huge = shipping([ground, sprite], { files: { "art/sky.png": pngHeader(8192, 2048) } }).find((f) => f.code === "R_HUGE_IMAGE");
    assert.equal(huge?.level, "idea", "a 2D sprite: memory, not a texture that fails");
    assert.match(huge!.message, /8192 × 2048/);
    assert.deepEqual(shipping([ground, sprite], { files: { "art/sky.png": pngHeader(4096, 2048) } }), []);
  });

  it("knows a big file and a big download, but only of what the game uses", () => {
    assert.deepEqual(shipping([ground], { files: { "music/theme.wav": randomBytes(12 * 1024 * 1024) } }), [], "a file nothing names isn't in the game");
    const named = shippingWithMusic();
    const codes = named.map((f) => f.code).sort();
    assert.deepEqual(codes, ["R_BIG_BUILD", "R_HEAVY_ASSET"], JSON.stringify(named));
    assert.equal(named.find((f) => f.code === "R_BIG_BUILD")!.level, "idea");
    assert.match(named.find((f) => f.code === "R_HEAVY_ASSET")!.message, /12\.0 MB/);
  });

  it("adds up the triangles a 3D scene's models draw, once per entity showing one", { timeout: 60_000 }, () => {
    const thing = (i: number) => ({ id: `rock-${i}`, components: { transform: { x: i * 3, y: 0, z: 0 }, mesh: { model: "models/rock.glb" } } });
    const files = { "models/rock.glb": heavyModel(300_000) };
    assert.deepEqual(shipping([thing(0), thing(1)], { world: { dimensions: 3 }, files }).filter((f) => f.code === "R_HEAVY_MODEL"), [], "600,000 is fine");
    const heavy = shipping([thing(0), thing(1), thing(2), thing(3)], { world: { dimensions: 3 }, files }).find((f) => f.code === "R_HEAVY_MODEL");
    assert.equal(heavy?.level, "idea", JSON.stringify(heavy));
    assert.match(heavy!.message, /1,200,000 triangles/);
  });

  it("times a step, as an idea only: a busy machine can't fail a review", () => {
    const slow = { ...ground, components: { ...ground.components, script: { src: "scripts/slow.ts" } } };
    const found = shipping([slow], { files: { "scripts/slow.ts": `export default { update() { const until = performance.now() + 5; while (performance.now() < until) {} } };` } }).find((f) => f.code === "R_SLOW_STEP");
    assert.equal(found?.level, "idea", JSON.stringify(found));
  });
});

/** A game whose music is a 12 MB WAV: it's in the build, so the build is big too. */
function shippingWithMusic(): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), "ludra-shipping-"));
  try {
    writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Loud", entry: "main.scene.json" }));
    writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ music: "music/theme.wav", entities: [ground] }));
    mkdirSync(join(dir, "music"));
    writeFileSync(join(dir, "music", "theme.wav"), randomBytes(12 * 1024 * 1024));
    const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "review", dir, "--fast", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
    return (JSON.parse(result.stdout) as { findings: Finding[] }).findings.filter((f) => f.area === "shipping");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
