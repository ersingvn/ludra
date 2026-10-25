import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ArcadePhysics, InputScript, simulate, World, type Entity, type PhysicsEngine, type PhysicsHost, type SceneDef } from "../src/index.ts";

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
    const frozen: PhysicsEngine = { name: "frozen", add() {}, remove() {}, step() {}, overlaps: () => false };
    const world = new World(scene, { physics: frozen });
    simulate(world, InputScript.parse("right:1s"), 60);
    assert.equal(world.get("hero")!.transform.x, 100);
    assert.equal(world.score, 0);
    assert.equal(world.get("hero")!.body!.vx, 240, "the platformer still asks to run");
  });
});
