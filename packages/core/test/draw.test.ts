import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkDrawHooks,
  collectAssetPaths,
  ScriptError,
  validateScene,
  validateScriptModule,
  World,
  type DrawContext,
  type SceneDef,
  type Script,
} from "../src/index.ts";

function scene(script: Script, extra: Partial<SceneDef> = {}): { scene: SceneDef; scripts: Map<string, Script> } {
  return {
    scene: {
      ...extra,
      entities: [{ id: "orb", components: { transform: { x: 10, y: 20 }, script: { src: "scripts/orb.ts", params: { glow: 3 } } } }],
    },
    scripts: new Map([["scripts/orb.ts", script]]),
  };
}

function extras(): Omit<DrawContext, "self" | "world" | "params"> {
  return {
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
}

function drawOnce(script: Script): World {
  const { scene: s, scripts } = scene(script);
  const world = new World(s, { scripts });
  world.step(new Set());
  world.callDrawHook(world.get("orb")!, "draw", extras());
  return world;
}

describe("draw hooks", () => {
  test("see the entity, the world and params", () => {
    let seen = "";
    drawOnce({
      start: ({ self, world }) => {
        self.state.charge = 2;
        world.score = 5;
      },
      draw: ({ self, world, params }) => {
        seen = `${self.x},${self.y} score ${world.score} charge ${self.state.charge} glow ${params.glow}`;
      },
    });
    assert.equal(seen, "10,20 score 5 charge 2 glow 3");
  });

  test("can't change the game, so the browser never drifts from what tests verified", () => {
    const attempts: Array<[string, (ctx: DrawContext) => void]> = [
      ["Setting x", ({ self }) => void (self.x = 99)],
      ["Setting score", ({ world }) => void (world.score = 1)],
      ["world.emit", ({ world }) => world.emit("sparkle")],
      ["world.random", ({ world }) => void world.random()],
      ["world.destroy", ({ world, self }) => world.destroy(self)],
    ];
    for (const [what, draw] of attempts) {
      assert.throws(
        () => drawOnce({ draw }),
        (err: unknown) => err instanceof ScriptError && err.message.includes(what) && err.message.includes("draw hook") && err.hook === "draw",
        what,
      );
    }
    // State is a frozen copy while drawing.
    assert.throws(() => drawOnce({ draw: ({ self }) => void (self.state.flash = 1) }), ScriptError);
  });

  test("the game works normally again after a draw hook", () => {
    const world = drawOnce({ draw: () => {}, update: ({ self }) => void (self.x += 1) });
    world.step(new Set());
    assert.equal(world.get("orb")!.transform.x, 12);
  });

  test("hasHook finds drawUI, which replaces the default HUD", () => {
    assert.equal(drawOnce({ drawUI: () => {} }).hasHook("drawUI"), true);
    assert.equal(drawOnce({ draw: () => {} }).hasHook("drawUI"), false);
  });

  test("are valid script hooks", () => {
    assert.deepEqual(validateScriptModule({ default: { draw() {}, drawUI() {} } }, "scripts/x.ts"), []);
  });
});

describe("checkDrawHooks", () => {
  test("runs draw code against a mock canvas and accepts any canvas call", () => {
    const { scene: s, scripts } = scene({
      draw: ({ g, self, time, local }) => {
        const gradient = g.createRadialGradient(self.x, self.y, 0, self.x, self.y, 40);
        gradient.addColorStop(0, "#fff");
        g.fillStyle = gradient;
        g.globalCompositeOperation = "lighter";
        g.shadowBlur = 20 + Math.sin(time) * 5;
        g.fillRect(self.x - 20, self.y - 20, 40, 40);
        local.trail = [...((local.trail as number[]) ?? []), self.x].slice(-8);
      },
      drawUI: ({ g, world, view }) => {
        g.font = "900 32px Orbitron";
        const width = g.measureText(`SCORE ${world.score}`).width;
        g.fillText(`SCORE ${world.score}`, view.width - width - 16, 40);
      },
    });
    assert.deepEqual(checkDrawHooks(s, scripts), []);
  });

  test("reports hooks that throw, once per hook", () => {
    const { scene: s, scripts } = scene({
      draw: ({ local }) => {
        (local.trail as number[]).push(1); // never initialized
      },
      drawUI: ({ self }) => void (self.vx = 1),
    });
    const diagnostics = checkDrawHooks(s, scripts);
    assert.deepEqual(diagnostics.map((d) => [d.code, d.path]), [
      ["E_DRAW_HOOK", "scripts/orb.ts → draw"],
      ["E_DRAW_HOOK", "scripts/orb.ts → drawUI"],
    ]);
    assert.match(diagnostics[1]!.message, /Setting vx/);
  });
});

describe("fonts and postfx", () => {
  test("are validated", () => {
    const codes = (raw: unknown) => validateScene(raw).diagnostics.map((d) => d.code);
    assert.deepEqual(codes({ fonts: { Orbitron: "google", Pixel: "assets/pixel.woff2" }, postfx: { shader: "shaders/crt.frag", uniforms: { strength: 0.5 } }, entities: [] }).filter((c) => c.startsWith("E_")), []);
    assert.ok(codes({ fonts: { Pixel: "assets/pixel.png" }, entities: [] }).includes("E_INVALID_FONT"));
    assert.ok(codes({ postfx: { uniforms: {} }, entities: [] }).includes("E_POSTFX_SHADER"));
    assert.ok(codes({ postfx: { shader: "a.frag", uniforms: { u_time: 1 } }, entities: [] }).includes("E_POSTFX_UNIFORMS"));
    assert.ok(codes({ postfx: { shader: "a.frag", uniforms: { glow: "lots" } }, entities: [] }).includes("E_POSTFX_UNIFORMS"));
  });

  test("their files, and images named in script params, are project assets", () => {
    const refs = collectAssetPaths({
      fonts: { Orbitron: "google", Pixel: "assets/pixel.woff2" },
      postfx: { shader: "shaders/crt.frag" },
      entities: [{ id: "a", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/a.ts", params: { halo: "assets/halo.png", speed: 3, label: "hi" } } } }],
    });
    assert.deepEqual(refs.map((r) => [r.kind, r.path]), [
      ["script", "scripts/a.ts"],
      ["image", "assets/halo.png"],
      ["font", "assets/pixel.woff2"],
      ["shader", "shaders/crt.frag"],
    ]);
  });
});
