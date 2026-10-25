import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ArcadePhysics,
  InputScript,
  PhysicsUnavailableError,
  ScriptError,
  simulate,
  validateScene,
  World,
  type DrawContext,
  type Entity,
  type EntityDef,
  type PhysicsEngine,
  type PhysicsHost,
  type SceneDef,
  type Script,
} from "../src/index.ts";

const scene: SceneDef = {
  entities: [
    { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } },
    { id: "hero", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } },
    { id: "coin", components: { transform: { x: 160, y: 482 }, body: { type: "static", width: 20, height: 20, sensor: true }, collectible: {} } },
  ],
};

/** Arcade physics that records what the world asks of it. */
class Recording extends ArcadePhysics implements PhysicsEngine {
  readonly calls: string[] = [];
  override add(entity: Entity): void {
    this.calls.push(`add ${entity.id}`);
  }
  override remove(entity: Entity): void {
    this.calls.push(`remove ${entity.id}`);
  }
  override step(host: PhysicsHost): void {
    this.calls.push("step");
    super.step(host);
  }
}

describe("physics engines", () => {
  test("arcade is the default engine", () => {
    assert.equal(new World(scene).physics.name, "arcade");
  });

  test("a rapier scene explains how to load rapier when it isn't loaded", () => {
    // Core never loads @ludra/physics, so "rapier" isn't registered in this process.
    assert.throws(() => new World({ ...scene, world: { physics: "rapier" } }), (err: Error) =>
      err instanceof PhysicsUnavailableError && /await loadRapierPhysics\(\) from @ludra\/physics/.test(err.message),
    );
  });

  test("the world tells its engine about every entity, steps it, and asks it about overlaps", () => {
    const physics = new Recording();
    const world = new World(scene, { physics });
    simulate(world, InputScript.parse("right:0.5s"), 30);
    assert.deepEqual(physics.calls.slice(0, 3), ["add ground", "add hero", "add coin"]);
    assert.equal(physics.calls.filter((c) => c === "step").length, 30);
    assert.ok(physics.calls.includes("remove coin"), "a collected coin is removed from the engine");
    assert.equal(world.score, 1, "pickups go through the engine's overlap query");
  });

  test("gameplay only sees the engine through velocities, grounded and overlaps", () => {
    // An engine that never moves anything and reports no overlaps: nothing can happen.
    const frozen: PhysicsEngine = {
      name: "frozen",
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
    const world = new World(scene, { physics: frozen });
    simulate(world, InputScript.parse("right:1s"), 60);
    assert.equal(world.get("hero")!.transform.x, 100);
    assert.equal(world.score, 0);
    assert.equal(world.get("hero")!.body!.vx, 240, "the platformer still asks to run");
  });
});

describe("forces and raycasts under arcade physics", () => {
  const crate = (id: string, x: number, density = 1): EntityDef => ({
    id,
    components: { transform: { x, y: 480 }, body: { type: "dynamic", width: 40, height: 40, density } },
  });
  const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };

  test("an impulse changes velocity by impulse / mass, so heavier bodies move less", () => {
    const world = new World({ entities: [ground, crate("light", 100), crate("heavy", 300, 4)] });
    world.physics.applyImpulse(world.get("light")!, 1600 * 50, 0);
    world.physics.applyImpulse(world.get("heavy")!, 1600 * 50, 0);
    assert.equal(world.get("light")!.body!.vx, 50);
    assert.equal(world.get("heavy")!.body!.vx, 12.5);
    world.physics.applyImpulse(world.get("ground")!, 1e9, 0);
    assert.equal(world.get("ground")!.body!.vx, 0, "static bodies don't move");
  });

  test("a ray hits the nearest box, with the hit point, distance and normal", () => {
    const world = new World({ entities: [ground, crate("near", 400), crate("far", 700)] });
    const hit = world.physics.raycast((world as unknown as { physicsHost: PhysicsHost }).physicsHost, { x: 100, y: 480 }, { x: 900, y: 480 });
    assert.equal(hit?.entity.id, "near");
    assert.deepEqual([hit!.x, hit!.y, hit!.distance], [380, 480, 280]);
    assert.deepEqual(hit!.normal, { x: -1, y: 0 });
  });

  test("scripts kick bodies, cast rays (skipping what they ignore), and turn things", () => {
    const scripts = new Map<string, Script>([
      [
        "eye.ts",
        {
          update({ self, world }) {
            const near = world.get("near")!;
            const seen = world.raycast({ x: self.x, y: self.y }, { x: 900, y: self.y }, { ignore: [self, "near"] });
            self.state.sees = seen?.entity.id ?? "nothing";
            if (world.frame === 1) near.applyImpulse(near.mass * 100, 0);
            self.rotation = 45;
          },
        },
      ],
    ]);
    const eye: EntityDef = { id: "eye", components: { transform: { x: 100, y: 480 }, body: { type: "static", width: 10, height: 10, sensor: true }, script: { src: "eye.ts" } } };
    const world = new World({ entities: [ground, eye, crate("near", 400), crate("far", 700)] }, { scripts });
    world.step(new Set());
    assert.equal(world.get("eye")!.state.sees, "far", "the ignored crate is looked through");
    assert.equal(world.get("near")!.body!.vx, 100);
    assert.equal(world.get("eye")!.transform.rotation, 45);
  });

  test("draw hooks can cast rays but can't push bodies or reach the raw engine", () => {
    const extras: Omit<DrawContext, "self" | "world" | "params"> = {
      g: {} as CanvasRenderingContext2D,
      time: 0,
      local: {},
      view: { width: 960, height: 540, cameraX: 0, cameraY: 0, zoom: 1 },
      recent: () => [],
      image: () => undefined,
      burst: () => {},
      shake: () => {},
      random: () => 0.5,
    };
    for (const [name, draw, allowed] of [
      ["raycast", ({ world: w }: DrawContext) => void w.raycast({ x: 0, y: 480 }, { x: 900, y: 480 }), true],
      ["applyImpulse", ({ self }: DrawContext) => self.applyImpulse(10, 0), false],
      ["physics.raw", ({ world: w }: DrawContext) => void w.physics.raw, false],
    ] as const) {
      const scripts = new Map<string, Script>([["d.ts", { draw }]]);
      const scene: SceneDef = { entities: [ground, { id: "d", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 9, height: 9 }, script: { src: "d.ts" } } }] };
      const world = new World(scene, { scripts });
      const call = () => world.callDrawHook(world.get("d")!, "draw", extras);
      if (allowed) assert.doesNotThrow(call, name);
      else assert.throws(call, ScriptError, name);
    }
  });

  test("joints are checked: their target must exist, and arcade ignores them", () => {
    const { diagnostics } = validateScene({
      entities: [
        ground,
        { id: "bob", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 9, height: 9 }, joint: { to: "grond", anchor: { x: 0 } } } },
      ],
    });
    const codes = diagnostics.map((d) => d.code);
    assert.ok(codes.includes("E_JOINT_TARGET"));
    assert.match(diagnostics.find((d) => d.code === "E_JOINT_TARGET")!.fix!, /Did you mean "ground"/);
    assert.ok(diagnostics.some((d) => d.path.endsWith("joint.anchor")), "anchor needs x and y");
    assert.match(diagnostics.find((d) => d.code === "W_RAPIER_ONLY")!.message, /the joint component/);
  });
});
