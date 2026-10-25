import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dmath } from "../src/index.ts";

describe("dmath: trigonometry with the same bits everywhere", () => {
  test("agrees with Math to within a few ulps across many turns", () => {
    let worst = 0;
    for (let i = -2000; i <= 2000; i++) {
      const x = i * 0.0137;
      worst = Math.max(worst, Math.abs(dmath.sin(x) - Math.sin(x)), Math.abs(dmath.cos(x) - Math.cos(x)));
      const y = Math.sin(i * 0.37) * 5;
      const z = Math.cos(i * 0.91) * 5;
      worst = Math.max(worst, Math.abs(dmath.atan2(y, z) - Math.atan2(y, z)));
      const s = Math.sin(i * 0.53);
      worst = Math.max(worst, Math.abs(dmath.asin(s) - Math.asin(s)));
    }
    assert.ok(worst < 1e-14, `worst difference ${worst}`);
  });

  test("exact where it matters: axes, quadrants and edges", () => {
    assert.equal(dmath.sin(0), 0);
    assert.equal(dmath.cos(0), 1);
    assert.equal(dmath.atan2(0, 1), 0);
    assert.equal(dmath.atan2(1, 0), Math.PI / 2);
    assert.equal(dmath.atan2(-1, 0), -Math.PI / 2);
    assert.equal(dmath.atan2(0, -1), Math.PI);
    assert.equal(dmath.atan2(0, 0), 0);
    assert.equal(dmath.asin(1), Math.PI / 2);
    assert.equal(dmath.asin(-1), -Math.PI / 2);
    assert.ok(Number.isNaN(dmath.asin(1.5)) && Number.isNaN(dmath.sin(Infinity)));
  });

  test("gives these exact bits on every machine (CI checks Linux, Windows and macOS)", () => {
    // Pinned once; +, -, *, / and sqrt are correctly rounded by IEEE 754 everywhere, so they never change.
    const bits = (x: number) => Buffer.from(new Float64Array([x]).buffer).toString("hex");
    assert.deepEqual(
      [bits(dmath.sin(1)), bits(dmath.cos(2.5)), bits(dmath.atan2(0.18070361018180847, -0.9824995994567871)), bits(dmath.asin(-0.3))],
      ["ee0c098f54edea3f", "7f8b85eff7a2e9bf", "ae56b3d178ad0740", "fef6149e1580d3bf"],
    );
  });
});
