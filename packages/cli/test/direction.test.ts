import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { colorsOfProject, hasLeftPalette, missingFromDirection, offPalette, parseDirection } from "../src/direction.ts";

/** game.md: the look a game has decided on, and the part of that review can hold it to. */

const workDir = mkdtempSync(join(tmpdir(), "ludra-direction-"));

after(() => rmSync(workDir, { recursive: true, force: true }));

const written = `# Last Lantern

## Promise

The dark closes in, and the lantern is all you have.

## Look

- style: 16-color pixel art at 480x270
- type: an own pixel font, nothing smooth
- palette: #120C0A, #4a3529, #ffcf70, #58e

## Notes

- palette: #000000
`;

describe("game.md", () => {
  test("reads the decisions, and only from their own sections", () => {
    assert.deepEqual(parseDirection(written), {
      promise: "The dark closes in, and the lantern is all you have.",
      style: "16-color pixel art at 480x270",
      type: "an own pixel font, nothing smooth",
      palette: ["#120c0a", "#4a3529", "#ffcf70", "#58e"],
    });
    assert.deepEqual(missingFromDirection(parseDirection(written)), []);
  });

  test("says what hasn't been decided", () => {
    assert.equal(missingFromDirection(parseDirection("# A game\n")).length, 4);
    const missing = missingFromDirection(parseDirection("## Promise\n\nFun.\n\n## Look\n\n- style: flat\n- palette: #fff, #000\n"));
    assert.deepEqual(missing, ['"- type:" under "## Look"', '"- palette:" with at least 3 colors under "## Look"']);
  });

  test("near a palette color is on it; greys belong to every palette; far is off", () => {
    const palette = ["#ffcf70", "#2c4650", "#c03030"];
    assert.deepEqual(offPalette(["#ffd070", "#c82828", "#808080", "#101010", "#00ff00"], palette), { off: ["#00ff00"], weighed: 3 });
  });

  test("a stray color is drift, most of the art off the palette has left it", () => {
    assert.equal(hasLeftPalette({ off: ["#00ff00"], weighed: 10 }), false);
    assert.equal(hasLeftPalette({ off: ["#00ff00", "#ff00ff"], weighed: 3 }), true);
    assert.equal(hasLeftPalette({ off: [], weighed: 0 }), false);
  });

  test("colors are collected from the art and the code, once each", () => {
    const game = join(workDir, "game");
    mkdirSync(join(game, "assets"), { recursive: true });
    mkdirSync(join(game, "scripts"), { recursive: true });
    mkdirSync(join(game, "tests"), { recursive: true });
    writeFileSync(join(game, "assets", "a.svg"), '<rect fill="#FF0000"/><rect fill="#ff0000"/>');
    writeFileSync(join(game, "scripts", "b.ts"), 'g.fillStyle = "#0f0";');
    writeFileSync(join(game, "tests", "c.json"), '"#123456"');
    assert.deepEqual(colorsOfProject(game).sort(), ["#0f0", "#ff0000"]);
  });
});
