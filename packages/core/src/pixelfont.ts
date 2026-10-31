/**
 * A 5×7 bitmap font drawn with rectangles, so text stays as sharp as the art in a low window:
 * a web font is smoothed at any size, and a smoothed letter among hard pixels reads as pasted on.
 * Capitals only, with the marks of Turkish and the common Latin languages.
 */

/** Seven rows, two hex digits each, the low five bits of each row being its pixels. */
const GLYPHS: Record<string, string> = {
  A: "0E11111F111111", B: "1E11111E11111E", C: "0E11101010110E", D: "1E11111111111E", E: "1F10101E10101F", F: "1F10101E101010", G: "0E11101711110F",
  H: "1111111F111111", I: "0E04040404040E", J: "0702020202120C", K: "11121418141211", L: "1010101010101F", M: "111B1515111111", N: "11191513111111",
  O: "0E11111111110E", P: "1E11111E101010", Q: "0E11111115120D", R: "1E11111E141211", S: "0F10100E01011E", T: "1F040404040404", U: "1111111111110E",
  V: "11111111110A04", W: "11111115151B11", X: "11110A040A1111", Y: "11110A04040404", Z: "1F01020408101F",
  0: "0E11131519110E", 1: "040C040404040E", 2: "0E11010608101F", 3: "1F02040201110E", 4: "02060A121F0202", 5: "1F101E0101110E", 6: "0608101E11110E",
  7: "1F010204080808", 8: "0E11110E11110E", 9: "0E11110F01020C",
  ".": "00000000000606", ",": "00000000060204", ":": "00060600060600", ";": "00060600060204", "!": "04040404040004", "?": "0E110102040004",
  "-": "0000001F000000", "'": "04040800000000", "/": "01010204081010", "(": "02040808080402", ")": "08040202020408", "+": "0004041F040400",
  "=": "00001F001F0000", "<": "02040810080402", ">": "08040201020408", "%": "19190204081313", "·": "00000006060000", "…": "00000000001515", " ": "00000000000000",
};

/** Rectangles [column, row, width, height] added to a capital; rows above 0 sit over it, rows from 7 under it. */
const MARKS: Record<string, [string, [number, number, number, number][]]> = {
  Ç: ["C", [[2, 7, 2, 1], [1, 8, 2, 1]]],
  Ş: ["S", [[2, 7, 2, 1], [1, 8, 2, 1]]],
  Ğ: ["G", [[1, -3, 1, 1], [3, -3, 1, 1], [2, -2, 1, 1]]],
  İ: ["I", [[2, -2, 1, 1]]],
  Ö: ["O", [[1, -2, 1, 1], [3, -2, 1, 1]]],
  Ü: ["U", [[1, -2, 1, 1], [3, -2, 1, 1]]],
  Ä: ["A", [[1, -2, 1, 1], [3, -2, 1, 1]]],
  Â: ["A", [[2, -3, 1, 1], [1, -2, 1, 1], [3, -2, 1, 1]]],
  Ê: ["E", [[2, -3, 1, 1], [1, -2, 1, 1], [3, -2, 1, 1]]],
  Á: ["A", [[2, -3, 2, 1], [1, -2, 2, 1]]],
  É: ["E", [[2, -3, 2, 1], [1, -2, 2, 1]]],
  Ñ: ["N", [[1, -2, 3, 1]]],
};

const ADVANCE = 6;

export interface PixelTextOptions {
  /** Size of one font pixel in canvas pixels. Default 1. */
  scale?: number;
  color?: string;
  align?: "left" | "center" | "right";
  /** Color of a hard one-pixel drop shadow, or false for none. Default a dark one. */
  shadow?: string | false;
  /** The language of the text, for its capitals: in "tr", i becomes İ and ı becomes I. */
  locale?: string;
}

function capitals(text: string, locale?: string): string[] {
  return [...text.toLocaleUpperCase(locale ?? "en")];
}

/** Width of `text` in canvas pixels, without the gap after the last letter. */
export function pixelTextWidth(text: string, scale = 1, locale?: string): number {
  const length = capitals(text, locale).length;
  return length === 0 ? 0 : (length * ADVANCE - 1) * scale;
}

function letter(g: CanvasRenderingContext2D, char: string, x: number, y: number, s: number): void {
  const marked = MARKS[char];
  const rows = GLYPHS[marked?.[0] ?? char] ?? GLYPHS["?"]!;
  for (let row = 0; row < 7; row++) {
    const bits = parseInt(rows.slice(row * 2, row * 2 + 2), 16);
    for (let column = 0; column < 5; column++) if (bits & (16 >> column)) g.fillRect(x + column * s, y + row * s, s, s);
  }
  for (const [column, row, width, height] of marked?.[1] ?? []) g.fillRect(x + column * s, y + row * s, width * s, height * s);
}

/** Draws `text` with its top-left at (x, y), or its top-center or top-right with `align`. */
export function pixelText(g: CanvasRenderingContext2D, text: string, x: number, y: number, options: PixelTextOptions = {}): void {
  const { scale = 1, color = "#ffffff", align = "left", shadow = "rgba(0, 0, 0, 0.75)", locale } = options;
  const s = Math.max(1, Math.round(scale));
  const width = pixelTextWidth(text, s, locale);
  const left = Math.round(align === "center" ? x - width / 2 : align === "right" ? x - width : x);
  const top = Math.round(y);
  const fill = g.fillStyle;
  const each = (dx: number, dy: number) => capitals(text, locale).forEach((char, i) => letter(g, char, left + i * ADVANCE * s + dx, top + dy, s));
  if (shadow !== false) {
    g.fillStyle = shadow;
    each(s, s);
  }
  g.fillStyle = color;
  each(0, 0);
  g.fillStyle = fill;
}
