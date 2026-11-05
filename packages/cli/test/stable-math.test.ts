import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EASES, ease, fingerprint, InputScript, World } from "@ludra/core";
import { loadProject, requireGame } from "../src/project.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FRAMES = 900;
const INPUTS = "right:2s, right+jump:0.3s, right:1s, left:1s, jump:0.2s, wait:1s, right+action:2s, up:0.5s, down:0.5s, left+jump:0.4s, right:4s";

/**
 * Engines are free to round these differently: Chrome and Node do, in the last bit. Moving each
 * result by a hair stands in for every other engine at once, without needing any of them.
 */
const UNSTABLE = ["sin", "cos", "tan", "atan", "atan2", "asin", "acos", "exp", "log", "log2", "log10", "pow", "hypot", "cbrt", "sinh", "cosh", "tanh"] as const;

function withUnstableMath<T>(run: () => T): T {
  const saved = UNSTABLE.map((name) => [name, Math[name]] as const);
  for (const [name, real] of saved) {
    (Math as unknown as Record<string, unknown>)[name] = (...args: number[]) => (real as (...a: number[]) => number)(...args) * (1 + 3e-12);
  }
  try {
    return run();
  } finally {
    for (const [name, real] of saved) (Math as unknown as Record<string, unknown>)[name] = real;
  }
}

const games = [...readdirSync(join(ROOT, "examples")).map((name) => join(ROOT, "examples", name)), ...readdirSync(join(ROOT, "packages/cli/templates")).map((name) => join(ROOT, "packages/cli/templates", name))];

describe("the simulation doesn't lean on rounding that differs between engines", () => {
  for (const dir of games) {
    it(dir.slice(ROOT.length).replaceAll("\\", "/"), async () => {
      const { scene, scripts } = await requireGame(loadProject(dir));
      const script = InputScript.parse(INPUTS);
      const hashes = () => {
        const world = new World(scene, { scripts });
        const seen: string[] = [];
        for (let frame = 0; frame < FRAMES; frame++) {
          world.step(script.at(frame));
          seen.push(fingerprint(world));
        }
        return seen;
      };
      const honest = hashes();
      const moved = withUnstableMath(hashes);
      const first = honest.findIndex((hash, i) => hash !== moved[i]);
      assert.equal(first, -1, `frame ${first} changed when Math's rounding did: something in the simulation calls Math.sin or a friend. Use dmath.`);
    });
  }

  it("every ease", () => {
    for (const name of EASES) {
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        assert.equal(withUnstableMath(() => ease(name, t)), ease(name, t), `${name} at ${t}`);
      }
    }
  });

  it("the eases still make their curves", () => {
    for (const name of EASES) {
      assert.ok(Math.abs(ease(name, 0)) < 1e-9, `${name} starts at 0`);
      assert.ok(Math.abs(ease(name, 1) - 1) < 1e-9, `${name} ends at 1`);
    }
    assert.ok(Math.abs(ease("sineInOut", 0.25) - (1 - Math.SQRT1_2) / 2) < 1e-12);
    assert.ok(Math.abs(ease("quadInOut", 0.75) - 0.875) < 1e-12);
    assert.ok(Math.abs(ease("cubicInOut", 0.75) - 0.9375) < 1e-12);
    assert.ok(Math.abs(ease("backOut", 0.5) - (1 + 2.70158 * -0.125 + 1.70158 * 0.25)) < 1e-12);
    const t = 0.3;
    assert.ok(Math.abs(ease("elasticOut", t) - (2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1)) < 1e-12);
  });
});
