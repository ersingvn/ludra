import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CameraRig, cameraGoal, ease, EASES, InputScript, simulate, validateScene, World, type CameraSubject, type SceneDef } from "../src/index.ts";

const codes = (scene: unknown) =>
  validateScene(scene)
    .diagnostics.filter((d) => d.code !== "W_NO_PLAYER")
    .map((d) => `${d.code} ${d.path}`);

function build(raw: unknown): SceneDef {
  const { scene, diagnostics } = validateScene(raw);
  assert.ok(scene, JSON.stringify(diagnostics, null, 2));
  return scene;
}

const coin = { components: { body: { type: "static", width: 20, height: 20, sensor: true }, collectible: {} } };

describe("tilemap", () => {
  const level = {
    prefabs: { coin },
    entities: [
      { id: "player", components: { transform: { x: 60, y: 60 }, body: { type: "dynamic", width: 20, height: 30 }, platformer: {} } },
      {
        id: "map",
        components: {
          transform: { x: 0, y: 0 },
          tilemap: {
            tileSize: 40,
            rows: ["#........#", "#...c..^.#", "##########", "##########"],
            legend: { "#": { image: "assets/brick.svg" }, c: "coin", "^": { color: "#f33", sensor: true, components: { hazard: {} } } },
          },
        },
      },
    ],
  };

  test("cells become entities: merged blocks, placed prefabs and sensor tiles", () => {
    const scene = build(level);
    const ids = scene.entities.map((e) => e.id);
    // The scene's own entities keep their places; generated ones come after.
    assert.deepEqual(ids.slice(0, 2), ["player", "map"]);
    assert.equal(scene.entities[1]!.components.tilemap, undefined);
    // Two bottom rows merge into one 400x80 block; the side columns into 40x80 posts.
    const floor = scene.entities.find((e) => e.id === "map-2-0")!;
    assert.deepEqual(floor.components.transform, { x: 200, y: 120 });
    assert.deepEqual(floor.components.body, { type: "static", width: 400, height: 80 });
    assert.deepEqual(floor.components.sprite, { image: "assets/brick.svg", tile: true });
    assert.deepEqual(scene.entities.find((e) => e.id === "map-0-0")!.components.body, { type: "static", width: 40, height: 80 });
    const placed = scene.entities.find((e) => e.id === "map-1-4")!;
    assert.deepEqual(placed.components.transform, { x: 180, y: 60 });
    assert.deepEqual(placed.components.collectible, {});
    assert.deepEqual(scene.entities.find((e) => e.id === "map-1-7")!.components.hazard, {});
    assert.equal(ids.length, 2 + 5);
  });

  test("a player walks on it, collects from it and dies on it", () => {
    const world = new World(build(level));
    simulate(world, InputScript.parse("right:1.2s"), 90);
    assert.equal(world.score, 1, "collected the placed coin");
    assert.equal(world.deaths, 1, "the spike tile is a hazard");
    assert.equal(world.get("player")!.body!.grounded, true, "standing on the merged floor");
  });

  test("an offset tilemap places everything from its top-left corner", () => {
    const scene = build({ entities: [{ id: "m", components: { transform: { x: 100, y: 200 }, tilemap: { tileSize: 10, rows: ["##"], legend: { "#": { color: "#fff" } } } } }] });
    assert.deepEqual(scene.entities[1]!.components.transform, { x: 110, y: 205 });
  });

  test("mistakes name the row, column and character", () => {
    const raw = {
      entities: [
        {
          id: "m",
          components: {
            transform: { x: 0, y: 0 },
            tilemap: { rows: ["#?#", "#@#"], legend: { "#": { image: "assets/b.svg", glow: 1 }, "@": "hero", ".": { color: "#fff" }, ab: {} } },
          },
        },
      ],
    };
    assert.deepEqual(codes(raw), [
      "E_TILEMAP entities[0].components.tilemap.legend.#.glow",
      "E_UNKNOWN_PREFAB entities[0].components.tilemap.legend.@",
      "E_TILEMAP entities[0].components.tilemap.legend..",
      "E_TILEMAP entities[0].components.tilemap.legend.ab",
      "E_TILEMAP entities[0].components.tilemap.rows[0]",
    ]);
    const unknown = validateScene(raw).diagnostics.find((d) => d.path.endsWith("rows[0]"))!;
    assert.match(unknown.message, /"\?" \(row 0, column 1\) is not in the legend/);
    assert.deepEqual(codes({ entities: [{ id: "m", components: { transform: { x: 0, y: 0 }, tilemap: { rows: "###", legend: {} } } }] }), ["E_TILEMAP entities[0].components.tilemap.rows"]);
  });
});

describe("tween", () => {
  const door = (tween: unknown, type = "kinematic") => ({
    entities: [{ id: "door", components: { transform: { x: 100, y: 300 }, body: { type, width: 40, height: 120 }, sprite: { color: "#888" }, tween } }],
  });

  test("every ease starts at 0 and ends at 1", () => {
    for (const name of EASES) {
      assert.ok(Math.abs(ease(name, 0)) < 1e-9, `${name}(0)`);
      assert.ok(Math.abs(ease(name, 1) - 1) < 1e-9, `${name}(1)`);
    }
    assert.ok(ease("backOut", 0.6) > 1, "backOut overshoots");
  });

  test("a kinematic door glides up by 120 px, lands exactly and stops", () => {
    const world = new World(build(door({ property: "y", by: -120, duration: 1, ease: "quadOut" })));
    const ys: number[] = [];
    simulate(world, InputScript.parse(""), 90, (w) => ys.push(w.get("door")!.transform.y));
    assert.ok(ys[29]! < 300 - 60, `fast at first (quadOut): ${ys[29]} at 0.5s`);
    assert.ok(Math.abs(ys[60]! - 180) < 1e-6, `arrived at 1s: ${ys[60]}`);
    assert.ok(Math.abs(ys.at(-1)! - 180) < 1e-6, "and stays");
    assert.equal(world.get("door")!.body!.vy, 0);
  });

  test("pingpong goes there and back forever; loop restarts", () => {
    const ping = new World(build(door({ property: "x", to: 200, duration: 0.5, repeat: "pingpong", ease: "linear" })));
    const xs: number[] = [];
    simulate(ping, InputScript.parse(""), 120, (w) => xs.push(w.get("door")!.transform.x));
    assert.ok(Math.abs(Math.max(...xs) - 200) < 1e-6 && Math.abs(xs[60]! - 100) < 1e-6, `back at the start after 1s: ${xs[60]}`);
    const spin = new World(build(door({ property: "rotation", by: 360, duration: 1, repeat: "loop", ease: "linear" }, "static")));
    simulate(spin, InputScript.parse(""), 90);
    assert.ok(Math.abs(spin.get("door")!.transform.rotation - 180) < 7, `half a turn into the second loop: ${spin.get("door")!.transform.rotation}`);
  });

  test("a repeating tween waits out its delay at each end", () => {
    const world = new World(build(door({ property: "y", by: -100, duration: 1, delay: 0.5, repeat: "pingpong", ease: "linear" })));
    const ys: number[] = [];
    simulate(world, InputScript.parse(""), 200, (w) => ys.push(w.get("door")!.transform.y));
    assert.equal(ys[30], 300, "waits 0.5s before the first pass");
    assert.ok(Math.abs(ys[90]! - 200) < 1e-6 && Math.abs(ys[115]! - 200) < 1e-6, `rests at the top: ${ys[90]}, ${ys[115]}`);
    assert.ok(ys[150]! > 200, `then heads back down: ${ys[150]}`);
  });

  test("a tween waiting on an event starts when it fires, once", () => {
    const scene = build({
      entities: [
        { id: "player", components: { transform: { x: 50, y: 482 }, body: { type: "dynamic", width: 20, height: 36 }, platformer: {} } },
        { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } },
        { id: "flag", components: { transform: { x: 150, y: 470 }, body: { type: "static", width: 20, height: 60, sensor: true }, checkpoint: {} } },
        { id: "sign", components: { transform: { x: 300, y: 300 }, sprite: { color: "#fff", opacity: 0 }, tween: { property: "opacity", to: 1, duration: 0.5, on: "checkpoint" } } },
      ],
    });
    const world = new World(scene);
    simulate(world, InputScript.parse("wait:0.5s"), 30);
    assert.equal(world.get("sign")!.sprite!.opacity, 0, "not before the event");
    simulate(world, InputScript.parse("right:1s"), 60);
    assert.equal(world.events.filter((e) => e.type === "checkpoint").length, 1);
    assert.equal(world.get("sign")!.sprite!.opacity, 1, "faded in after the checkpoint");
  });

  test("a lift moved by a tween carries the player", () => {
    const scene = build({
      entities: [
        { id: "player", components: { transform: { x: 100, y: 382 }, body: { type: "dynamic", width: 20, height: 36 }, platformer: {} } },
        { id: "lift", components: { transform: { x: 100, y: 410 }, body: { type: "kinematic", width: 100, height: 20 }, tween: { property: "x", by: 200, duration: 2, delay: 0.3 } } },
      ],
    });
    const world = new World(scene);
    simulate(world, InputScript.parse(""), 150);
    assert.ok(Math.abs(world.get("lift")!.transform.x - 300) < 1e-6);
    assert.ok(Math.abs(world.get("player")!.transform.x - 300) < 1, `rode along to ${world.get("player")!.transform.x}`);
  });

  test("scripts start tweens; draw hooks can't", () => {
    const scene = build({ entities: [{ id: "box", components: { transform: { x: 0, y: 0 }, sprite: { color: "#fff" }, script: { src: "s.ts" } } }] });
    const world = new World(scene, {
      scripts: new Map([
        [
          "s.ts",
          {
            start: ({ self }) => self.tween({ property: "scale", to: 2, duration: 0.5, ease: "backOut" }),
            draw: ({ self }) => self.tween({ property: "x", to: 5, duration: 1 }),
          },
        ],
      ]),
    });
    simulate(world, InputScript.parse(""), 40);
    assert.equal(world.get("box")!.sprite!.scale, 2);
    assert.throws(() => world.callDrawHook(world.get("box")!, "draw", {} as never), /tween changes the game/);
    const bad = new World(scene, { scripts: new Map([["s.ts", { start: ({ self }) => self.tween({ property: "x", duration: 1 }) }]]) });
    assert.throws(() => bad.step(new Set()), /self\.tween: .*no "to" or "by"/);
  });

  test("validation: a target, a sprite to fade, and a moving body", () => {
    assert.deepEqual(codes(door({ property: "y", duration: 1 })), ["E_TWEEN_TARGET entities[0].components.tween"]);
    assert.deepEqual(codes({ entities: [{ id: "a", components: { transform: { x: 0, y: 0 }, tween: [{ property: "opacity", to: 0, duration: 1 }] } }] }), [
      "E_TWEEN_NEEDS_SPRITE entities[0].components.tween[0].property",
    ]);
    assert.deepEqual(codes(door({ property: "y", by: 10, duration: 1 }, "static")), ["W_TWEEN_STATIC_BODY entities[0].components.tween.property"]);
    assert.deepEqual(codes(door([{ property: "y", by: 10, duration: 1, ease: "wobble" }])), ["E_INVALID_FIELD entities[0].components.tween[0].ease"]);
  });
});

describe("camera zones", () => {
  const screen = { width: 400, height: 300 };
  const world = { width: 2000, height: 1000 };
  const player = (x: number, y: number): CameraSubject => ({ id: "player", transform: { x, y }, platformer: {} });
  const zone = (id: string, x: number, y: number, width: number, height: number, extra: Partial<NonNullable<CameraSubject["cameraZone"]>> = {}): CameraSubject => ({
    id,
    transform: { x, y },
    cameraZone: { width, height, mode: "room", zoom: 0, blend: 0.5, priority: 0, ...extra },
  });

  test("without zones the camera centers the player, inside the world", () => {
    assert.deepEqual(cameraGoal([player(1000, 500)], world, screen).view, { x: 800, y: 350, zoom: 1 });
    assert.deepEqual(cameraGoal([player(50, 50)], world, screen).view, { x: 0, y: 0, zoom: 1 });
  });

  test("a room keeps the view inside it; a small room is centered", () => {
    const room = zone("room", 600, 500, 800, 600); // x 200..1000, y 200..800
    assert.deepEqual(cameraGoal([player(250, 250), room], world, screen).view, { x: 200, y: 200, zoom: 1 });
    assert.deepEqual(cameraGoal([player(600, 500), room], world, screen).view, { x: 400, y: 350, zoom: 1 });
    const closet = zone("closet", 600, 500, 200, 100);
    assert.deepEqual(cameraGoal([player(560, 480), closet], world, screen).view, { x: 400, y: 350, zoom: 1 });
  });

  test("fixed holds the zone's center, zoom changes the view size, priority picks between overlaps", () => {
    const vista = zone("vista", 1000, 500, 600, 400, { mode: "fixed", zoom: 0.5 });
    assert.deepEqual(cameraGoal([player(900, 450), vista], world, screen).view, { x: 600, y: 200, zoom: 0.5 });
    const boss = zone("boss", 900, 450, 100, 100, { mode: "fixed", priority: 1 });
    assert.equal(cameraGoal([player(900, 450), boss, vista], world, screen).zone!.id, "boss");
  });

  test("entering and leaving a zone eases over its blend time", () => {
    const vista = zone("vista", 1000, 500, 600, 400, { mode: "fixed", blend: 0.5 });
    const rig = new CameraRig();
    const dt = 1 / 60;
    rig.update([player(500, 500), vista], world, screen, 0);
    assert.deepEqual(rig.view, { x: 300, y: 350, zoom: 1 });
    rig.update([player(705, 500), vista], world, screen, dt); // just inside
    assert.ok(rig.view!.x > 300 && rig.view!.x < 800, `starts blending: ${rig.view!.x}`);
    for (let i = 0; i < 30; i++) rig.update([player(705, 500), vista], world, screen, dt);
    assert.deepEqual(rig.view, { x: 800, y: 350, zoom: 1 });
  });
});
