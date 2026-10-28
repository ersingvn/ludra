import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { imageSize, svgSize, wavInfo } from "../src/commands/inspect.ts";
import { readModel, readModelBuffer, readModelGeometry } from "../src/gltf.ts";
import { loadProject, readScene } from "../src/project.ts";
import { boxModel, glb } from "./models.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ludra-inspect-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function ludra(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

describe("glTF reader", () => {
  const { json, bin } = boxModel({ stride: true });
  const glbFile = join(dir, "box.glb");
  writeFileSync(glbFile, glb(json, bin));

  test("summarizes a .glb with node transforms applied to the bounds", () => {
    const model = readModel(glbFile);
    assert.equal(model.format, "glb");
    assert.equal(model.generator, "ludra test");
    assert.deepEqual(model.bounds, { min: [-1, 0, -1], max: [1, 2, 1], size: [2, 2, 2] });
    assert.equal(model.meshes, 1);
    assert.equal(model.primitives, 1);
    assert.equal(model.vertices, 8);
    assert.equal(model.triangles, 12);
    assert.deepEqual(model.materials, ["Crate"]);
    assert.equal(model.nodes, 4);
    assert.deepEqual(model.skins, [{ name: "Rig", joints: 3 }]);
    assert.deepEqual(model.animations, [{ name: "Spin", duration: 2, channels: 1 }]);
    assert.deepEqual(model.externalFiles, []);
  });

  test("reads geometry through byteStride and transforms it", () => {
    const { positions, indices } = readModelGeometry(glbFile);
    assert.equal(positions.length, 8 * 3);
    assert.equal(indices.length, 36);
    const ys = [...positions].filter((_, i) => i % 3 === 1);
    assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 2]);
  });

  test("reads a .gltf with an external .bin, and non-indexed primitives", () => {
    const flat = boxModel({ indexed: false });
    flat.json.buffers = [{ uri: "box%20data.bin", byteLength: flat.bin.length }];
    const file = join(dir, "flat.gltf");
    writeFileSync(file, JSON.stringify(flat.json));
    writeFileSync(join(dir, "box data.bin"), flat.bin);

    const model = readModel(file);
    assert.equal(model.format, "gltf");
    assert.equal(model.triangles, 12);
    assert.equal(model.vertices, 36);
    assert.deepEqual(model.externalFiles, ["box data.bin"]);
    const { positions, indices } = readModelGeometry(file);
    assert.equal(positions.length, 36 * 3);
    assert.deepEqual([...indices.subarray(0, 6)], [0, 1, 2, 3, 4, 5]);
  });

  test("reads embedded data: buffers from memory, falling back to data when min/max are missing", () => {
    const embedded = boxModel();
    embedded.json.buffers = [{ uri: `data:application/octet-stream;base64,${embedded.bin.toString("base64")}`, byteLength: embedded.bin.length }];
    const accessors = embedded.json.accessors as Record<string, unknown>[];
    delete accessors[0]!.min;
    delete accessors[0]!.max;
    delete accessors[1]!.max;
    const model = readModelBuffer(Buffer.from(JSON.stringify(embedded.json)), "embedded.gltf");
    assert.deepEqual(model.bounds.size, [2, 2, 2]);
    assert.equal(model.animations[0]!.duration, 2);
    assert.deepEqual(model.externalFiles, []);
  });

  test("names unnamed clips and rejects files that aren't glTF 2.0", () => {
    const { json: unnamed, bin: data } = boxModel();
    (unnamed.animations as { name?: string }[])[0]!.name = undefined;
    assert.equal(readModelBuffer(glb(unnamed, data), "x.glb").animations[0]!.name, "animation-0");
    assert.throws(() => readModelBuffer(Buffer.from("hello"), "bad.gltf"), /neither a \.glb/);
    assert.throws(() => readModelBuffer(Buffer.from('{"asset":{"version":"1.0"}}'), "old.gltf"), /only glTF 2\.0/);
  });

  test("names the compression extension when geometry can't be read", () => {
    const { json: compressed, bin: data } = boxModel();
    (compressed.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!.extensions = { KHR_draco_mesh_compression: {} };
    compressed.extensionsRequired = ["KHR_draco_mesh_compression"];
    const file = join(dir, "draco.glb");
    writeFileSync(file, glb(compressed, data));
    assert.deepEqual(readModel(file).extensionsRequired, ["KHR_draco_mesh_compression"]);
    assert.throws(() => readModelGeometry(file), /KHR_draco_mesh_compression/);
  });
});

describe("ludra inspect", () => {
  test("prints a model as JSON with a mesh hint", () => {
    const { json, bin } = boxModel();
    (json.animations as { name: string }[])[0]!.name = "Armature|Run";
    writeFileSync(join(dir, "hero.glb"), glb(json, bin));
    const { code, out } = ludra("inspect", join(dir, "hero.glb"), "--json");
    assert.equal(code, 0, out);
    const result = JSON.parse(out);
    assert.equal(result.kind, "model");
    assert.equal(result.triangles, 12);
    assert.deepEqual(result.bounds.size, [2, 2, 2]);
    assert.match(result.hints[0], /"animations": \{ "run": "Armature\|Run" \}/);
  });

  test("prints a readable summary", () => {
    const { code, out } = ludra("inspect", join(dir, "box.glb"));
    assert.equal(code, 0, out);
    assert.match(out, /2\.00 × 2\.00 × 2\.00 m/);
    assert.match(out, /12 triangles/);
    assert.match(out, /Spin\s+2\.00s/);
    assert.match(out, /Rig: 3 bones/);
    assert.match(out, /hint: Use it with "mesh"/);
  });

  test("reads image and WAV headers", () => {
    const png = Buffer.alloc(24);
    png.write("\x89PNG\r\n\x1a\n", 0, "latin1");
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(32, 20);
    assert.deepEqual(imageSize(png), { format: "png", width: 64, height: 32 });

    const gif = Buffer.from("GIF89a\x10\x00\x08\x00", "latin1");
    assert.deepEqual(imageSize(gif), { format: "gif", width: 16, height: 8 });

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]);
    assert.deepEqual(imageSize(jpeg), { format: "jpeg", width: 64, height: 48 });

    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">'), { format: "svg", width: 120, height: 80 });
    assert.deepEqual(svgSize('<svg width="24px" height="16" viewBox="0 0 1 1">'), { format: "svg", width: 24, height: 16 });

    const wav = Buffer.alloc(44 + 22050 * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(22050, 24);
    wav.writeUInt32LE(44100, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(22050 * 2, 40);
    assert.deepEqual(wavInfo(wav), { duration: 1, channels: 1, sampleRate: 22050 });

    writeFileSync(join(dir, "beep.wav"), wav);
    const { code, out } = ludra("inspect", join(dir, "beep.wav"), "--json");
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).duration, 1);
  });

  test("explains files it can't read", () => {
    writeFileSync(join(dir, "notes.txt"), "hi");
    const { code, out } = ludra("inspect", join(dir, "notes.txt"));
    assert.equal(code, 1);
    assert.match(out, /can't read \.txt/);
    assert.match(ludra("inspect", join(dir, "nope.glb")).out, /No file at/);
  });
});

describe("ludra check on models", () => {
  const game = join(dir, "model-game");
  const { json, bin } = boxModel();
  (json.animations as { name: string }[])[0]!.name = "Run";
  mkdirSync(join(game, "scenes"), { recursive: true });
  mkdirSync(join(game, "assets"), { recursive: true });
  writeFileSync(join(game, "ludra.json"), JSON.stringify({ name: "models", entry: "scenes/main.scene.json" }));
  writeFileSync(join(game, "assets", "hero.glb"), glb(json, bin));
  writeFileSync(join(game, "assets", "broken.glb"), "not a model");
  const split = boxModel();
  split.json.buffers = [{ uri: "split.bin", byteLength: split.bin.length }];
  writeFileSync(join(game, "assets", "split.gltf"), JSON.stringify(split.json));
  const ktx = boxModel();
  ktx.json.extensionsRequired = ["KHR_texture_basisu", "KHR_materials_emissive_strength", "KHR_draco_mesh_compression"];
  writeFileSync(join(game, "assets", "ktx.glb"), glb(ktx.json, ktx.bin));

  function check(meshes: Record<string, unknown>[], prefabs?: Record<string, unknown>) {
    const scene = {
      world: { dimensions: 3 },
      ...(prefabs ? { prefabs } : {}),
      entities: meshes.map((mesh, i) => ({ id: `thing-${i}`, components: { transform: { x: i * 3, y: 0, z: 0 }, ...(mesh.prefab ? {} : { mesh }) }, ...(mesh.prefab ? { prefab: mesh.prefab } : {}) })),
    };
    writeFileSync(join(game, "scenes", "main.scene.json"), JSON.stringify(scene));
    return readScene(loadProject(game));
  }
  const codes = (load: ReturnType<typeof check>) => load.diagnostics.filter((d) => d.code.includes("MODEL")).map((d) => `${d.code} ${d.path}`);

  test("a valid model with real clips passes", () => {
    const load = check([{ model: "assets/hero.glb", animations: { run: "Run" } }]);
    assert.deepEqual(codes(load), []);
    assert.ok(load.scene, JSON.stringify(load.diagnostics));
  });

  test("an unknown clip is an error with a suggestion and the clip list", () => {
    const load = check([{ model: "assets/hero.glb", animation: "Rnu", animations: { idle: "Run", jump: "Jump" } }]);
    assert.deepEqual(codes(load), ["E_MODEL_ANIMATION entities[0].components.mesh.animation", "E_MODEL_ANIMATION entities[0].components.mesh.animations.jump"]);
    assert.match(load.diagnostics.find((d) => d.code === "E_MODEL_ANIMATION")!.fix!, /Did you mean "Run"\? Its clips: "Run"/);
    assert.equal(load.scene, undefined);
  });

  test("an unreadable model and a missing .bin are errors", () => {
    const load = check([{ model: "assets/broken.glb" }, { model: "assets/split.gltf" }]);
    assert.deepEqual(codes(load), ["E_MODEL_INVALID entities[0].components.mesh.model", "E_MODEL_FILE_MISSING entities[1].components.mesh.model"]);
    assert.match(load.diagnostics.find((d) => d.code === "E_MODEL_FILE_MISSING")!.message, /split\.bin/);
    writeFileSync(join(game, "assets", "split.bin"), split.bin);
    assert.deepEqual(codes(check([{ model: "assets/split.gltf" }])), []);
  });

  test("extensions the renderer can't load are a warning that doesn't block", () => {
    const load = check([{ model: "assets/ktx.glb" }]);
    assert.deepEqual(codes(load), ["W_MODEL_EXTENSION entities[0].components.mesh.model"]);
    assert.match(load.diagnostics.find((d) => d.code === "W_MODEL_EXTENSION")!.message, /KTX2/);
    assert.ok(load.scene);
  });

  test("prefab meshes are checked once, on the prefab", () => {
    const load = check([{ prefab: "hero" }, { prefab: "hero" }], { hero: { components: { transform: { x: 0, y: 0, z: 0 }, mesh: { model: "assets/hero.glb", animations: { walk: "Walk" } } } } });
    assert.deepEqual(codes(load), ["E_MODEL_ANIMATION prefabs.hero.components.mesh.animations.walk"]);
  });

  test("a model that has no animations says so", () => {
    const { json: still, bin: data } = boxModel();
    still.animations = [];
    writeFileSync(join(game, "assets", "rock.glb"), glb(still, data));
    const load = check([{ model: "assets/rock.glb", animation: "Idle" }]);
    assert.match(load.diagnostics.find((d) => d.code === "E_MODEL_ANIMATION")!.fix!, /has no animations/);
  });
});

test("inspect shows models inside the current folder by their project path", () => {
  const game = join(dir, "model-game");
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "inspect", join(game, "assets", "hero.glb"), "--json"], { cwd: game, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { file, hints } = JSON.parse(result.stdout);
  assert.equal(file, "assets/hero.glb");
  assert.match(hints[0], /"model": "assets\/hero\.glb"/);
  assert.ok(!hints.some((h: string) => /fit/.test(h)), "the box rests on its origin, so there is no fit hint");
});
