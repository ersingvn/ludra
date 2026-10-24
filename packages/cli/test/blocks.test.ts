import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { runTest, validateScene, type EntityDef, type SceneDef, type Script, type TestCase } from "@ludra/core";
import { addBlock, listBlocks, placeBlock, type Block } from "../src/blocks.ts";

/** A block's demo: where to place it in a plain test level, and tests that prove it works. */
interface Demo {
  at: [number, number];
  tests: (TestCase & { playerAt?: [number, number] })[];
}

const ground: EntityDef = {
  id: "ground",
  components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } },
};
const walls: EntityDef[] = [-10, 970].map((x, i) => ({
  id: `wall-${i}`,
  components: { transform: { x, y: 270 }, body: { type: "static", width: 20, height: 540 } },
}));

function demoScene(block: Block, demo: Demo, playerAt: [number, number] = [100, 482]): SceneDef {
  const player: EntityDef = {
    id: "player",
    components: {
      transform: { x: playerAt[0], y: playerAt[1] },
      body: { type: "dynamic", width: 28, height: 36 },
      platformer: {},
    },
  };
  const base: SceneDef = { entities: [ground, ...walls, player] };
  const { entities, effects } = placeBlock(block, base, { x: demo.at[0], y: demo.at[1] });
  return { ...base, effects, entities: [...base.entities, ...entities] };
}

async function loadScripts(block: Block): Promise<Map<string, Script>> {
  const scripts = new Map<string, Script>();
  for (const path of block.files.filter((f) => f.endsWith(".ts"))) {
    const module = (await import(pathToFileURL(join(block.dir, path)).href)) as { default: Script };
    scripts.set(path, module.default);
  }
  return scripts;
}

const blocks = listBlocks();

describe("block library", () => {
  test("every block has a manifest, its files and a demo", () => {
    assert.ok(blocks.length >= 10, `expected at least 10 blocks, found ${blocks.length}`);
    for (const block of blocks) {
      for (const file of block.files) assert.ok(existsSync(join(block.dir, file)), `${block.name}: missing ${file}`);
      assert.ok(existsSync(join(block.dir, "demo.json")), `${block.name}: missing demo.json`);
      assert.ok(block.description && block.usage, `${block.name}: needs a description and usage`);
    }
  });

  for (const block of blocks) {
    test(`${block.name}: demo scene is valid and its tests pass`, async () => {
      const demo = JSON.parse(readFileSync(join(block.dir, "demo.json"), "utf8")) as Demo;
      const scripts = await loadScripts(block);
      for (const { playerAt, ...testCase } of demo.tests) {
        const scene = demoScene(block, demo, playerAt);
        const errors = validateScene(scene).diagnostics.filter((d) => d.severity === "error");
        assert.deepEqual(errors, [], `${block.name}: demo scene has errors`);
        const result = runTest(scene, testCase, { scripts });
        const failures = result.error ? [result.error] : result.results.filter((r) => !r.pass).map((r) => `${r.source} → ${r.message}`);
        assert.equal(result.pass, true, `${block.name} / ${testCase.name}:\n  ${failures.join("\n  ")}`);
      }
    });
  }
});

describe("ludra add", () => {
  const dir = mkdtempSync(join(tmpdir(), "ludra-add-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const scenePath = join(dir, "scene.json");
  writeFileSync(scenePath, JSON.stringify({ entities: [ground, { id: "pad", components: { transform: { x: 0, y: 0 } } }] }));
  const keyAndDoor = blocks.find((b) => b.name === "key-and-door")!;

  test("places entities at --at, links them by id and copies files", () => {
    const result = addBlock(dir, scenePath, keyAndDoor, { x: 300, y: 500 });
    assert.deepEqual(
      result.entities.map((e) => `${e.id}@${e.x},${e.y}`),
      ["key-and-door-key@300,460", "key-and-door-door@500,440"],
    );
    const scene = JSON.parse(readFileSync(scenePath, "utf8")) as SceneDef;
    const key = scene.entities.find((e) => e.id === "key-and-door-key")!;
    assert.equal(key.components.script!.params && (key.components.script!.params as { door: string }).door, "key-and-door-door");
    assert.ok(readdirSync(join(dir, "scripts")).includes("key.ts"));
    assert.deepEqual(result.effects.sort(), ["door-open", "key"]);
  });

  test("a second copy gets unique ids and leaves identical files alone", () => {
    const result = addBlock(dir, scenePath, keyAndDoor, { x: 600, y: 500 });
    assert.deepEqual(
      result.entities.map((e) => e.id),
      ["key-and-door-2-key", "key-and-door-2-door"],
    );
    assert.ok(result.files.every((f) => f.status === "unchanged"));
    assert.deepEqual(result.effects, [], "existing effects are not overwritten");
  });

  test("never overwrites a file the user changed, unless forced", () => {
    writeFileSync(join(dir, "scripts", "key.ts"), "// my own key\nexport default {};\n");
    const kept = addBlock(dir, scenePath, keyAndDoor, { x: 700, y: 500 });
    assert.equal(kept.files.find((f) => f.path === "scripts/key.ts")?.status, "kept yours");
    assert.match(readFileSync(join(dir, "scripts", "key.ts"), "utf8"), /my own key/);
    const forced = addBlock(dir, scenePath, keyAndDoor, { x: 800, y: 500 }, { force: true });
    assert.equal(forced.files.find((f) => f.path === "scripts/key.ts")?.status, "replaced");
  });
});
