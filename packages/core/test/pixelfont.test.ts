import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pixelText, pixelTextWidth } from "../src/pixelfont.ts";

/** The bitmap font: what it draws is a list of rectangles, so a stand-in canvas can read it. */

function canvas() {
  const cells: { x: number; y: number; size: number; color: string }[] = [];
  const g = {
    fillStyle: "#000000",
    fillRect(x: number, y: number, size: number) {
      cells.push({ x, y, size, color: g.fillStyle });
    },
  };
  return { g: g as unknown as CanvasRenderingContext2D, cells };
}

describe("pixelText", () => {
  test("a letter is five by seven, and letters sit six apart", () => {
    const { g, cells } = canvas();
    pixelText(g, "HH", 0, 0, { shadow: false });
    const first = cells.filter((c) => c.x < 6);
    assert.equal(Math.max(...first.map((c) => c.x)), 4);
    assert.equal(Math.max(...first.map((c) => c.y)), 6);
    assert.ok(cells.some((c) => c.x === 6));
    assert.equal(pixelTextWidth("HH"), 11);
    assert.equal(pixelTextWidth("HH", 3), 33);
    assert.equal(pixelTextWidth(""), 0);
  });

  test("lower case is drawn in capitals", () => {
    const small = canvas();
    const big = canvas();
    pixelText(small.g, "ateş", 0, 0);
    pixelText(big.g, "ATEŞ", 0, 0);
    assert.deepEqual(small.cells, big.cells);
  });

  test("Turkish letters keep their marks", () => {
    const shape = (char: string) => {
      const { g, cells } = canvas();
      pixelText(g, char, 0, 0, { shadow: false });
      return cells;
    };
    for (const [marked, plain] of [["Ç", "C"], ["Ş", "S"], ["Ğ", "G"], ["İ", "I"], ["Ö", "O"], ["Ü", "U"]] as const) {
      assert.ok(shape(marked).length > shape(plain).length, marked);
    }
    assert.ok(shape("Ç").some((c) => c.y >= 7), "the cedilla hangs under the letter");
    assert.ok(shape("Ö").some((c) => c.y < 0), "the dots sit over it");
  });

  test("a language has its own capitals", () => {
    const drawn = (text: string, locale?: string) => {
      const { g, cells } = canvas();
      pixelText(g, text, 0, 0, { shadow: false, locale });
      return cells;
    };
    assert.deepEqual(drawn("kiriş", "tr"), drawn("KİRİŞ"));
    assert.deepEqual(drawn("ışık", "tr"), drawn("IŞIK"));
    assert.deepEqual(drawn("kiriş"), drawn("KIRIŞ"));
  });

  test("every position lands on the pixel grid, whatever it was given", () => {
    const { g, cells } = canvas();
    pixelText(g, "A", 10.4, 20.6, { scale: 2.4, align: "center" });
    assert.ok(cells.every((c) => Number.isInteger(c.x) && Number.isInteger(c.y) && c.size === 2));
  });

  test("the shadow goes under the text, and the fill style is left as it was", () => {
    const { g, cells } = canvas();
    g.fillStyle = "#123456";
    pixelText(g, "I", 0, 0, { color: "#ffffff", shadow: "#000000" });
    assert.equal(cells[0]!.color, "#000000");
    assert.equal(cells.at(-1)!.color, "#ffffff");
    assert.equal(g.fillStyle, "#123456");
  });

  test("an unknown character shows as a question mark rather than nothing", () => {
    const unknown = canvas();
    const mark = canvas();
    pixelText(unknown.g, "€", 0, 0);
    pixelText(mark.g, "?", 0, 0);
    assert.deepEqual(unknown.cells, mark.cells);
  });
});
