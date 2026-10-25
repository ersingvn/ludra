import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateAssertion, parseAssertion, PhysicsUnavailableError, validateScene, World, type PhysicsEngine, type SceneDef } from "../src/index.ts";

const codes = (scene: unknown) =>
  validateScene(scene)
    .diagnostics.filter((d) => d.code !== "W_NO_PLAYER")
    .map((d) => `${d.code} ${d.path}`);

/** Stands in for Rapier 3D (step 2): bodies stay where they are. */
const still: PhysicsEngine = {
  name: "still",
  add() {},
  remove() {},
  step() {},
  overlaps: () => false,
  mass: () => 1,
  applyImpulse() {},
  angularVelocity: () => 0,
  setAngularVelocity() {},
  raycast: () => undefined,
};

const crate3d = {
  id: "crate",
  components: {
    transform: { x: 1, y: 2, z: -3, rotation: { x: 10, y: 45 } },
    body: { type: "dynamic", width: 1, height: 1, depth: 0.5, vz: 2 },
  },
};
const world3d = (entities: unknown[], world: Record<string, unknown> = {}) => ({ world: { dimensions: 3, ...world }, entities });

describe("3D scenes", () => {
  test("a 3D crate validates: z, a rotation object, depth, vz and 3D shapes", () => {
    const floor = { id: "floor", components: { transform: { x: 0, y: -0.5, z: 0 }, body: { width: 20, height: 1, depth: 20 } } };
    assert.deepEqual(codes(world3d([crate3d, floor])), []);
    const ball = { id: "ball", components: { transform: { x: 0, y: 5, z: 0 }, body: { type: "dynamic", width: 0.5, height: 0.5, shape: "sphere" } } };
    const rock = { id: "rock", components: { transform: { x: 0, y: 0 }, body: { width: 2, height: 1, shape: "convex", points: [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1]] } } };
    assert.deepEqual(codes(world3d([ball, rock, { id: "pillar", components: { transform: { x: 0, y: 0 }, body: { width: 1, height: 4, shape: "cylinder" } } }])), []);
  });

  test("the world holds z, vz and 3D rotation, and snapshots them", () => {
    const { scene } = validateScene(world3d([crate3d]));
    const world = new World(scene!, { physics: still });
    assert.equal(world.dimensions, 3);
    assert.equal(world.gravity, 9.81, "3D defaults to metres per second squared");
    const crate = world.get("crate")!;
    assert.deepEqual(crate.transform, { x: 1, y: 2, z: -3, rotation: 0, rotationX: 10, rotationY: 45 });
    assert.equal(crate.body!.vz, 2);
    assert.equal(crate.body!.depth, 0.5);
    assert.deepEqual(world.snapshot().entities.crate, { x: 1, y: 2, vx: 0, vy: 0, grounded: false, z: -3, vz: 2, rotationX: 10, rotationY: 45 });
  });

  test("tests can assert z, vz and rotations", () => {
    const { scene } = validateScene(world3d([crate3d]));
    const world = new World(scene!, { physics: still });
    for (const [source, pass] of [
      ["crate.z == -3", true],
      ["crate.vz > 1", true],
      ["crate.rotationY == 45", true],
      ["crate.rotation == 0", true],
      ["crate.z > 0", false],
    ] as const) {
      assert.equal(evaluateAssertion(parseAssertion(source), world.snapshot(), world.events).pass, pass, source);
    }
  });

  test("scripts read and write z and vz, and draw hooks can't", () => {
    const { scene } = validateScene(world3d([{ ...crate3d, components: { ...crate3d.components, script: { src: "s.ts" } } }]));
    const world = new World(scene!, {
      physics: still,
      scripts: new Map([["s.ts", { update: ({ self }) => ((self.z += 1), (self.vz = 7)), draw: ({ self }) => void (self.z = 0) }]]),
    });
    world.step(new Set());
    assert.equal(world.get("crate")!.transform.z, -2);
    assert.equal(world.get("crate")!.body!.vz, 7);
    assert.throws(() => world.callDrawHook(world.get("crate")!, "draw", {} as never), /Setting z changes the game/);
  });

  test("a 3D world needs Rapier 3D, and says how to load it", () => {
    const { scene } = validateScene(world3d([]));
    assert.throws(() => new World(scene!), (err: unknown) => err instanceof PhysicsUnavailableError && /loadRapier3DPhysics\(\)/.test((err as Error).message));
  });
});

describe("2D and 3D stay apart", () => {
  test("3D rejects 2D shapes, single-number rotations and 2D controllers, and warns about 2D-only looks", () => {
    const entities = [
      { id: "a", components: { transform: { x: 0, y: 0, rotation: 30 }, body: { width: 1, height: 1, shape: "circle" } } },
      { id: "b", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 1, height: 1 }, platformer: {}, sprite: { color: "#fff" } } },
      { id: "c", components: { transform: { x: 0, y: 0 }, body: { width: 1, height: 1, shape: "convex", points: [[0, 1], [1, 0], [-1, 0], [0, 0]] } } },
    ];
    assert.deepEqual(codes(world3d(entities)), [
      "E_3D_ROTATION entities[0].components.transform.rotation",
      "E_2D_SHAPE entities[0].components.body.shape",
      "E_2D_ONLY entities[1].components.platformer",
      "W_2D_ONLY entities[1].components.sprite",
      "E_SHAPE_POINTS entities[2].components.body.points",
    ]);
    const fix = validateScene(world3d(entities)).diagnostics.find((d) => d.code === "E_3D_ROTATION")!.fix;
    assert.equal(fix, 'Use "rotation": { "y": 30 } to turn it around the vertical axis.');
  });

  test("2D warns about 3D-only fields and rejects 3D shapes", () => {
    const scene = {
      world: { physics: "rapier" },
      entities: [
        { id: "a", components: { transform: { x: 0, y: 0, z: 5 }, body: { width: 10, height: 10, depth: 4, shape: "sphere" } } },
        { id: "b", components: { transform: { x: 0, y: 0 }, body: { type: "kinematic", width: 10, height: 10 }, patrol: { axis: "z", distance: 10 } } },
      ],
    };
    assert.deepEqual(codes(scene), [
      "W_3D_ONLY entities[0].components",
      "E_3D_SHAPE entities[0].components.body.shape",
      "W_3D_ONLY entities[1].components",
    ]);
  });

  test("3D can't be arcade, and dimensions is 2 or 3", () => {
    assert.deepEqual(codes(world3d([], { physics: "arcade" })), ["E_3D_NEEDS_RAPIER world.physics"]);
    assert.deepEqual(codes({ world: { dimensions: 4 }, entities: [] }), ["E_INVALID_WORLD world.dimensions"]);
  });

  test("2D worlds keep their snapshots exactly as before: no z", () => {
    const scene: SceneDef = { entities: [{ id: "box", components: { transform: { x: 10, y: 20 }, body: { type: "dynamic", width: 10, height: 10 } } }] };
    const world = new World(scene);
    world.step(new Set());
    assert.deepEqual(Object.keys(world.snapshot().entities.box!), ["x", "y", "vx", "vy", "grounded"]);
    assert.equal(world.dimensions, 2);
  });
});
