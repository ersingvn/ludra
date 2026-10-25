// TEMPORARY: finds which part of the 3D golden scene diverges between machines. Remove after.
import { createHash } from "node:crypto";
import { test } from "node:test";
import { InputScript, simulate, validateScene, World, type EntityDef } from "@ludra/core";
import { loadRapier3DPhysics } from "../src/index.ts";
import { degreesFromQuaternion, quaternionFromDegrees } from "../src/rapier3d.ts";

const floor: EntityDef = { id: "floor", components: { transform: { x: 0, y: -0.5, z: 0 }, body: { width: 60, height: 1, depth: 60 } } };
const box = (id: string, x: number, y: number, z: number, extra: Record<string, unknown> = {}): EntityDef => ({
  id,
  components: { transform: { x, y, z }, body: { type: "dynamic", width: 1, height: 1, ...extra } },
});
const hero: EntityDef = { id: "hero", components: { transform: { x: 0, y: 0.9, z: 6 }, body: { type: "dynamic", width: 0.6, height: 1.8, shape: "capsule" }, character: {} } };

const parts: Record<string, EntityDef[]> = {
  crates: Array.from({ length: 6 }, (_, i) => box(`crate-${i}`, (i % 3) - 1, 0.5 + Math.floor(i / 3) * 1.01, -2, { friction: 0.6 })),
  ball: [box("ball", -6, 3, 0, { shape: "sphere", vx: 4, vz: -1, bounce: 0.5 })],
  ramp: [
    { id: "ramp", components: { transform: { x: -8, y: 1, z: 0, rotation: { z: -15 } }, body: { width: 6, height: 0.3, depth: 3 } } },
    box("roller", -9, 3, 0, { shape: "sphere" }),
  ],
  bob: [{ id: "bob", components: { transform: { x: 4, y: 5, z: 0 }, body: { type: "dynamic", width: 0.6, height: 0.6, shape: "sphere" }, joint: { type: "spherical", anchor: { x: -2, y: 0, z: 1 } } } }],
  lift: [{ id: "lift", components: { transform: { x: 5, y: 1, z: 4 }, body: { type: "kinematic", width: 2, height: 0.2, depth: 2 }, patrol: { axis: "z", distance: 3, speed: 1.5 } } }],
  hero: [hero],
  tumble: [box("tumble", 0, 3, 0, {}), { id: "t2", components: { transform: { x: 0.3, y: 5, z: 0.2, rotation: { x: 30, y: 40, z: 10 } }, body: { type: "dynamic", width: 1, height: 1 } } }],
};

test("diagnose 3D determinism", async () => {
  await loadRapier3DPhysics();
  const q = quaternionFromDegrees(30, 40, 10);
  const back = degreesFromQuaternion(q);
  console.log("DIAG quat", JSON.stringify(q), JSON.stringify(back), Math.sin(0.3), Math.atan2(0.3, 0.7), Math.asin(0.4), Math.hypot(1, 2, 3), 2 ** 0.5);
  for (const [name, entities] of Object.entries(parts)) {
    const { scene } = validateScene({ world: { dimensions: 3 }, entities: [floor, ...entities] });
    const world = new World(scene!);
    let first: number | undefined;
    const hashes: string[] = [];
    simulate(world, InputScript.parse("up:1s, up+jump:0.4s, up:1.2s, left+up:1s, wait:0.4s"), 360, (w) => {
      const h = createHash("sha256").update(JSON.stringify(w.snapshot())).digest("hex").slice(0, 8);
      hashes.push(h);
      if (first === undefined && [1, 2, 3, 5, 10, 30, 60, 120, 240, 360].includes(w.frame)) void 0;
    });
    const marks = [1, 2, 3, 5, 10, 20, 30, 60, 120, 240, 360].map((f) => `${f}:${hashes[f]}`).join(" ");
    console.log(`DIAG ${name} ${marks}`);
    console.log(`DIAG ${name} f1 ${JSON.stringify(new World(scene!).snapshot().entities)}`);
    const w2 = new World(scene!);
    simulate(w2, InputScript.parse(""), 1);
    console.log(`DIAG ${name} after1 ${JSON.stringify(w2.snapshot().entities)}`);
  }
});
