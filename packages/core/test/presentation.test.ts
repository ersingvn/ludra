import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectAssetPaths, InputScript, isFrameList, parseFrames, simulate, validateScene, World, type EntityDef, type SceneDef } from "../src/index.ts";
import { LABEL_HEIGHT, layoutLabels } from "../src/labels.ts";
import { ParticleSystem } from "../src/particles.ts";

const ground: EntityDef = {
  id: "ground",
  components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } },
};
const player: EntityDef = {
  id: "player",
  components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 20, height: 36 }, platformer: {} },
};

function codes(scene: unknown): string[] {
  return validateScene(scene).diagnostics.map((d) => d.code);
}

describe("sprite frames", () => {
  test("parses single frames, ranges and lists", () => {
    assert.deepEqual(parseFrames("0"), [0]);
    assert.deepEqual(parseFrames("1-4"), [1, 2, 3, 4]);
    assert.deepEqual(parseFrames("0, 2-3, 5"), [0, 2, 3, 5]);
    assert.deepEqual(parseFrames("3-1"), [3, 2, 1]);
    assert.deepEqual(parseFrames(""), []);
    assert.equal(isFrameList("1-"), false);
    assert.equal(isFrameList("a"), false);
  });

  test("validates frame lists and image paths on sprites", () => {
    const sprite = (fields: Record<string, unknown>): SceneDef => ({
      entities: [ground, { ...player, components: { ...player.components, sprite: fields } }],
    });
    assert.deepEqual(codes(sprite({ image: "assets/p.svg", frameWidth: 20, run: "1-4" })), []);
    assert.ok(codes(sprite({ run: "one" })).includes("E_INVALID_FIELD"));
    assert.ok(codes(sprite({ image: "assets/player.txt" })).includes("E_INVALID_IMAGE"));
  });
});

describe("effects", () => {
  test("accepts presets, files and particle settings", () => {
    const scene = {
      effects: {
        collect: { sound: "coin", particles: { count: 12, color: "#ffd166" } },
        die: { sound: "sounds/ouch.wav", shake: 8 },
      },
      entities: [ground, player],
    };
    assert.deepEqual(codes(scene), []);
  });

  test("suggests the right event and sound names", () => {
    const result = validateScene({ effects: { colect: { sound: "coin" }, jump: { sound: "jmp" } }, entities: [ground, player] });
    // Unknown names may be custom events fired by scripts, so a likely typo is a warning, not an error.
    const unknownEvent = result.diagnostics.find((d) => d.code === "W_EVENT_LOOKS_LIKE_TYPO");
    const badSound = result.diagnostics.find((d) => d.code === "E_INVALID_SOUND");
    assert.match(unknownEvent?.fix ?? "", /Did you mean "collect"/);
    assert.match(badSound?.fix ?? "", /Did you mean "jump"/);
  });

  test("checks particle fields", () => {
    const result = validateScene({ effects: { land: { particles: { count: 0, colour: "red" } } }, entities: [ground, player] });
    const found = result.diagnostics.map((d) => `${d.code} ${d.path}`);
    assert.ok(found.includes("E_INVALID_FIELD effects.land.particles.count"));
    assert.ok(found.includes("W_UNKNOWN_FIELD effects.land.particles.colour"));
  });

  test("collectAssetPaths lists images and sound files but not presets", () => {
    const scene: SceneDef = {
      effects: { jump: { sound: "jump" }, die: { sound: "sounds/die.ogg" } },
      entities: [{ ...player, components: { ...player.components, sprite: { image: "assets/p.svg" } } }],
    };
    assert.deepEqual(
      collectAssetPaths(scene).map((r) => `${r.kind} ${r.path} ${r.at}`),
      ["image assets/p.svg entities[0].components.sprite.image", "audio sounds/die.ogg effects.die.sound"],
    );
  });

  test("effects and sprites never change the simulation", () => {
    const plain: SceneDef = { entities: [ground, player] };
    const dressed: SceneDef = {
      effects: { jump: { sound: "jump", shake: 4, particles: { count: 50 } } },
      entities: [ground, { ...player, components: { ...player.components, sprite: { image: "assets/p.svg" }, emitter: { rate: 30 } } }],
    };
    const run = (scene: SceneDef) => {
      const world = new World(scene);
      simulate(world, InputScript.parse("right:0.5s, jump:0.4s, left:0.5s"), 120);
      return world.snapshot();
    };
    assert.deepEqual(run(dressed), run(plain));
  });
});

describe("events", () => {
  test("carry the position where they happened", () => {
    const coin: EntityDef = {
      id: "coin",
      components: { transform: { x: 160, y: 470 }, body: { width: 10, height: 10, sensor: true }, collectible: {} },
    };
    const world = new World({ entities: [ground, player, coin] });
    simulate(world, InputScript.parse("wait:0.1s, right+jump:0.3s"), 60);
    const jump = world.events.find((e) => e.type === "jump");
    const collect = world.events.find((e) => e.type === "collect");
    assert.equal(jump?.y, 500, "jumps start at the feet");
    assert.deepEqual([collect?.x, collect?.y], [160, 470], "collect happens at the coin");
  });
});

describe("ParticleSystem", () => {
  test("bursts, moves and expires particles deterministically", () => {
    const make = () => {
      const particles = new ParticleSystem(42);
      particles.burst(0, 0, { count: 5, life: 0.5 });
      return particles;
    };
    const a = make();
    assert.equal(a.count, 5);
    a.update(0.25);
    assert.equal(a.count, 5);
    a.update(0.3);
    assert.equal(a.count, 0);
    assert.equal(make().random(), make().random());
  });
});

describe("map labels", () => {
  const measure = (text: string) => text.length * 7;
  const boxes = (placed: ReturnType<typeof layoutLabels>) =>
    placed.map((l) => ({ left: l.textX, top: l.textY, right: l.textX + l.width, bottom: l.textY + LABEL_HEIGHT }));

  test("points in the same spot share one label", () => {
    const placed = layoutLabels([{ text: "plaza", x: 100, y: 100 }, { text: "plaza-rock", x: 102, y: 101 }, { text: "gate", x: 300, y: 100 }], measure, 960, 540);
    assert.deepEqual(placed.map((l) => l.text).sort(), ["gate", "plaza, plaza-rock"]);
  });

  test("a crowded column of points gets labels that don't overlap and stay on the frame", () => {
    const labels = Array.from({ length: 14 }, (_, i) => ({ text: `shard-number-${i}`, x: 480, y: 100 + i * 9 }));
    const placed = boxes(layoutLabels(labels, measure, 960, 540));
    assert.equal(placed.length, 14);
    for (const [i, a] of placed.entries()) {
      assert.ok(a.left >= 0 && a.top >= 0 && a.right <= 960 && a.bottom <= 540, "inside the frame");
      for (const b of placed.slice(i + 1)) assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "no two overlap");
    }
  });

  test("a point at the frame's edge keeps its label on the frame, and a full frame drops nothing", () => {
    assert.ok(boxes(layoutLabels([{ text: "corner", x: 2, y: 2 }], measure, 960, 540)).every((b) => b.left >= 0 && b.top >= 0));
    const labels = Array.from({ length: 60 }, (_, i) => ({ text: `entity-${i}`, x: 20 + i * 8, y: 20 }));
    assert.equal(layoutLabels(labels, measure, 100, 40).length, labels.length);
  });
});
