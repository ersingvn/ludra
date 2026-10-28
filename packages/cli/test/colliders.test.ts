import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { InputScript, simulate, validateScene, World } from "@ludra/core";
import { loadGame, loadProject, readScene } from "../src/project.ts";
import { boxModel, glb } from "./models.ts";

const dir = mkdtempSync(join(tmpdir(), "ludra-colliders-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A 3D project whose assets/crate.glb is a 2 m cube standing on its origin (y 0..2). */
function project(entities: object[], prefabs?: object): string {
  const game = mkdtempSync(join(dir, "game-"));
  mkdirSync(join(game, "scenes"));
  mkdirSync(join(game, "assets"));
  writeFileSync(join(game, "ludra.json"), JSON.stringify({ name: "colliders", entry: "scenes/main.scene.json" }));
  const { json, bin } = boxModel();
  writeFileSync(join(game, "assets", "crate.glb"), glb(json, bin));
  writeFileSync(join(game, "scenes", "main.scene.json"), JSON.stringify({ name: "Colliders", world: { dimensions: 3 }, entities, ...(prefabs ? { prefabs } : {}) }));
  return game;
}

function bodyOf(game: string, id: string): { points: number[][]; triangles?: number[][] } {
  const { scene, diagnostics } = readScene(loadProject(game));
  assert.ok(scene, JSON.stringify(diagnostics));
  return scene.entities.find((e) => e.id === id)!.components.body as { points: number[][]; triangles?: number[][] };
}

function bounds(points: number[][]): { min: number[]; max: number[] } {
  const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]!)));
  const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]!)));
  return { min, max };
}

describe("colliders from models", () => {
  test("a mesh shape takes the model's triangles, fitted like the drawn model", () => {
    const game = project([
      { id: "crate", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "static", width: 3, height: 3, shape: "mesh" }, mesh: { model: "assets/crate.glb" } } },
    ]);
    const body = bodyOf(game, "crate");
    assert.equal(body.triangles!.length, 12);
    // fit "height": 3 m tall, centred, its lowest point at the bottom of the body.
    assert.deepEqual(bounds(body.points), { min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] });
  });

  test("fit box stretches, and turn, scale and offset apply as they do to the mesh", () => {
    const game = project([
      { id: "slab", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "static", width: 4, height: 1, depth: 6, shape: "mesh" }, mesh: { model: "assets/crate.glb", fit: "box" } } },
      { id: "turned", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "static", width: 1, height: 1, shape: "mesh" }, mesh: { model: "assets/crate.glb", fit: "none", turn: { y: 45 }, scale: 0.5, offset: { y: 2 } } } },
    ]);
    assert.deepEqual(bounds(bodyOf(game, "slab").points), { min: [-2, -0.5, -3], max: [2, 0.5, 3] });
    const turned = bounds(bodyOf(game, "turned").points);
    // A 2 m cube turned 45° spans its diagonal, 2√2 m, halved by scale; its own y 0..2 becomes 2..3.
    assert.ok(Math.abs(turned.max[0]! - Math.SQRT2 / 2) < 1e-3, `x max ${turned.max[0]}`);
    assert.deepEqual([turned.min[1], turned.max[1]], [2, 3]);
  });

  test("a convex shape gets each corner once; body.model overrides the mesh's model; prefabs are filled too", () => {
    const game = project(
      [{ id: "rock", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "dynamic", width: 1, height: 1, shape: "convex", model: "assets/crate.glb" }, mesh: { color: "#888" } } }],
      { boulder: { components: { body: { type: "dynamic", width: 2, height: 2, shape: "convex" }, mesh: { model: "assets/crate.glb" } } } },
    );
    assert.equal(bodyOf(game, "rock").points.length, 8);
    const { scene } = readScene(loadProject(game));
    assert.equal((scene!.prefabs!.boulder!.components.body as { points: unknown[] }).points.length, 8);
  });

  test("points the scene gives itself are kept", () => {
    const own = [[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]];
    const game = project([{ id: "wedge", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "static", width: 1, height: 1, shape: "convex", points: own }, mesh: { model: "assets/crate.glb" } } }]);
    assert.deepEqual(bodyOf(game, "wedge").points, own);
  });

  test("things fall onto a model's triangles and onto generated terrain, and stop there", async () => {
    // A 2x2 quad at y 0, the simplest generated terrain.
    const ground = { points: [[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]], triangles: [[0, 2, 1], [0, 3, 2]] };
    const game = project([
      { id: "terrain", components: { transform: { x: 0, y: 0, z: 0 }, body: { type: "static", width: 10, height: 0.1, depth: 10, shape: "mesh", ...ground } } },
      { id: "crate", components: { transform: { x: 3, y: 1, z: 0 }, body: { type: "static", width: 2, height: 2, shape: "mesh" }, mesh: { model: "assets/crate.glb" } } },
      { id: "ball", components: { transform: { x: 3, y: 5, z: 0 }, body: { type: "dynamic", width: 0.5, height: 0.5, shape: "sphere" } } },
      { id: "ball-2", components: { transform: { x: -3, y: 4, z: 0 }, body: { type: "dynamic", width: 0.5, height: 0.5, shape: "sphere" } } },
    ]);
    const { game: loaded, diagnostics } = await loadGame(loadProject(game));
    assert.ok(loaded, JSON.stringify(diagnostics));
    const world = new World(loaded.scene, { scripts: loaded.scripts });
    simulate(world, InputScript.parse("wait:3s"), 180);
    const snap = world.snapshot();
    // On top of the 2 m crate (0..2) and on the ground, each resting on its radius.
    assert.ok(Math.abs(snap.entities.ball!.y - 2.25) < 0.02, `ball on the crate at ${snap.entities.ball!.y}`);
    assert.ok(Math.abs(snap.entities["ball-2"]!.y - 0.25) < 0.02, `ball on the ground at ${snap.entities["ball-2"]!.y}`);
  });
});

describe("validating mesh and model fields", () => {
  const scene = (components: object) => ({ name: "t", world: { dimensions: 3 }, entities: [{ id: "e", components: { transform: { x: 0, y: 0, z: 0 }, ...components } }] });
  const codes = (components: object) => validateScene(scene(components)).diagnostics.map((d) => d.code).filter((code) => code !== "W_NO_PLAYER");

  test("a mesh shape needs a model, or points and triangles, and can't be dynamic", () => {
    assert.ok(codes({ body: { type: "static", width: 1, height: 1, shape: "mesh" } }).includes("E_SHAPE_POINTS"));
    assert.ok(codes({ body: { type: "dynamic", width: 1, height: 1, shape: "mesh", model: "assets/a.glb" } }).includes("E_MESH_DYNAMIC"));
    assert.ok(codes({ body: { type: "static", width: 1, height: 1, shape: "mesh", points: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], triangles: [[0, 1, 5]] } }).includes("E_SHAPE_TRIANGLES"));
    assert.deepEqual(codes({ body: { type: "static", width: 1, height: 1, shape: "mesh", points: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], triangles: [[0, 2, 1]] } }), []);
    assert.deepEqual(codes({ body: { type: "static", width: 1, height: 1, shape: "convex" }, mesh: { model: "assets/a.glb" } }), []);
  });

  test("models must be glTF, and animations name movement states", () => {
    assert.ok(codes({ mesh: { model: "assets/hero.fbx" } }).includes("E_INVALID_MODEL"));
    const diagnostic = validateScene(scene({ mesh: { model: "assets/a.glb", animations: { runn: "Run" } } })).diagnostics.find((d) => d.code === "E_ANIMATION_STATE");
    assert.match(diagnostic?.fix ?? "", /Did you mean "run"/);
  });
});
