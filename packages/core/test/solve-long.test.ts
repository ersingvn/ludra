import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputScript } from "../src/input.ts";
import { solve, World } from "../src/index.ts";
import { longLevel } from "./long-level.ts";

/**
 * `solve` on long levels: exploring alone drowns in situations (each coin changes the score, so
 * every place is many cells), and the beam has to carry the search to the far end.
 */

describe("solve on long levels", () => {
  test("a short level is still won by exploring", () => {
    const scene = longLevel(30);
    const result = solve(() => new World(scene), { quick: true });
    assert.ok(result.solved);
    assert.equal(result.strategy, "explore");
  });

  test("a long level full of coins is won by the beam, with a route that wins on its own", () => {
    const scene = longLevel(100, { coins: true });
    const result = solve(() => new World(scene), { quick: true, budget: 1_000_000 });
    assert.ok(result.solved, `unsolved after ${result.explored} frames, closest ${JSON.stringify(result.closest)}`);
    assert.equal(result.strategy, "beam");
    const world = new World(scene);
    const inputs = InputScript.parse(result.inputs!);
    for (let f = 0; f < result.frame!; f++) world.step(inputs.at(f));
    assert.ok(world.won);
    assert.equal(world.deaths, 0);
  });
});
