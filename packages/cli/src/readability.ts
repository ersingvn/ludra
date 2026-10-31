import type { Rgba } from "./png.ts";

/** What one thing adds to a frame, measured from the frame with it and without it. */
export interface Presence {
  /** Pixels it visibly changes. 0: it isn't on screen. */
  pixels: number;
  /** The same as a share of the frame, 0 to 1. */
  share: number;
  /** Luminance contrast with what's right behind it, the median of its pixels, from 1:1 up. */
  contrast: number;
  /** Color difference from what's right behind it (CIE76 ΔE), the median of its pixels. */
  difference: number;
  /** Luminance of the brighter of the two, the median of its pixels, 0 to 1. */
  brightness: number;
}

/** Below this, a change between the two drawings is noise, not the thing. */
const NOISE = 16;
/** A glow or a shadow changes far more pixels than the thing itself, but changes them less. */
const CORE = 0.35;
/** Set by eye on real frames: a character at 1.4:1 can be followed, one washed out by a glow at 1.25:1 can't. */
const MIN_CONTRAST = 1.35;
const MIN_DIFFERENCE = 25;
/** In the dark the eye barely sees hue, whatever the numbers say: purple on navy is black on black. */
const MIN_BRIGHTNESS = 0.08;

/** A player smaller than this share of the screen is hard to find at a glance (12×12 of 960×540). */
export const TINY_SHARE = 0.0003;

/**
 * `again` is the whole frame drawn once more right afterwards: whatever changes between
 * those two is the game's own motion and flicker (ctx.random, a shader's noise), not the thing being measured.
 */
export function measurePresence(frame: Rgba, without: Rgba, again: Rgba): Presence {
  const { data: a, width, height } = frame;
  const { data: b } = without;
  const { data: c } = again;
  const apart = (x: Uint8Array, y: Uint8Array, at: number) => Math.max(Math.abs(x[at]! - y[at]!), Math.abs(x[at + 1]! - y[at + 1]!), Math.abs(x[at + 2]! - y[at + 2]!));
  const change = (at: number) => (apart(a, c, at) >= NOISE ? 0 : apart(a, b, at));
  let strongest = 0;
  for (let at = 0; at < a.length; at += 4) strongest = Math.max(strongest, change(at));
  if (strongest < NOISE) return { pixels: 0, share: 0, contrast: 1, difference: 0, brightness: 0 };

  const cutoff = Math.max(NOISE, strongest * CORE);
  // Pixel by pixel: on a backdrop half light and half dark, averages would cancel out to nothing.
  const contrasts: number[] = [];
  const differences: number[] = [];
  const brightest: number[] = [];
  const color = (data: Uint8Array, at: number): [number, number, number] => [linear(data[at]!), linear(data[at + 1]!), linear(data[at + 2]!)];
  for (let at = 0; at < a.length; at += 4) {
    if (change(at) < cutoff) continue;
    const front = color(a, at);
    const back = color(b, at);
    const hi = Math.max(luminance(front), luminance(back));
    const lo = Math.min(luminance(front), luminance(back));
    const [l1, a1, b1] = lab(front);
    const [l2, a2, b2] = lab(back);
    contrasts.push((hi + 0.05) / (lo + 0.05));
    differences.push(Math.hypot(l1 - l2, a1 - a2, b1 - b2));
    brightest.push(hi);
  }
  const pixels = contrasts.length;
  return { pixels, share: pixels / (width * height), contrast: median(contrasts), difference: median(differences), brightness: median(brightest) };
}

function median(values: number[]): number {
  return values.sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;
}

/** The moments that say something about a thing: a speck far down the path isn't there to be read yet. */
export function closeEnough(moments: Presence[]): Presence[] {
  const close = moments.filter((p) => p.share >= TINY_SHARE);
  return close.length > 0 ? close : moments;
}

/** Clear if it differs in brightness or in color: red on an equally bright green still reads. */
export function isClear(presence: Presence): boolean {
  return presence.contrast >= MIN_CONTRAST || (presence.difference >= MIN_DIFFERENCE && presence.brightness >= MIN_BRIGHTNESS);
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  return lab([linear(r), linear(g), linear(b)]);
}

/** How far apart two 8-bit colors look (CIE76 ΔE). */
export function colorDistance(x: readonly number[], y: readonly number[]): number {
  const [l1, a1, b1] = rgbToLab(x[0]!, x[1]!, x[2]!);
  const [l2, a2, b2] = rgbToLab(y[0]!, y[1]!, y[2]!);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function linear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(luminance([r, g, b]));
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}