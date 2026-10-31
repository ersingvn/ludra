import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SceneDef } from "@ludra/core";
import type { Rgba } from "./png.ts";
import { rgbToLab } from "./readability.ts";

const HUES = 12;
/** Colors under this chroma have no hue worth comparing. */
const GREY = 8;
/** Set on real frames: levels with a theme each stayed under 0.55, levels on one palette reached 0.81. */
const ALIKE = 0.75;
/** A block thinner than this is a floor strip, which reads as a line and not as a pattern. */
const THICK_CELLS = 3;
/** Fewer copies than this don't show a pattern. */
const MANY_CELLS = 60;

/** The share of a frame's color in each hue, grey left out: light and shade barely move it. */
export function hueProfile({ data }: Rgba): number[] {
  const bins = new Array<number>(HUES).fill(0);
  let total = 0;
  for (let at = 0; at < data.length; at += 16) {
    const [, a, b] = rgbToLab(data[at]!, data[at + 1]!, data[at + 2]!);
    const chroma = Math.hypot(a, b);
    if (chroma < GREY) continue;
    const hue = (Math.atan2(b, a) / (2 * Math.PI) + 1) % 1;
    bins[Math.floor(hue * HUES) % HUES]! += chroma;
    total += chroma;
  }
  return total === 0 ? bins : bins.map((v) => v / total);
}

/** 1 when two profiles spend their color in the same hues, 0 when they share none. */
export function hueOverlap(x: readonly number[], y: readonly number[]): number {
  return x.reduce((sum, v, i) => sum + Math.min(v, y[i]!), 0);
}

export function areAlike(overlap: number): boolean {
  return overlap >= ALIKE;
}

export function averageProfile(profiles: readonly number[][]): number[] {
  return profiles[0]!.map((_, i) => profiles.reduce((sum, p) => sum + p[i]!, 0) / profiles.length);
}

/** An image's size from its own header, SVG only: other formats are told by the sprite's frame size. */
function svgSize(file: string): { width: number; height: number } | undefined {
  if (!file.endsWith(".svg") || !existsSync(file)) return undefined;
  const head = readFileSync(file, "utf8").slice(0, 400);
  const width = Number(head.match(/\bwidth="([\d.]+)/)?.[1]);
  const height = Number(head.match(/\bheight="([\d.]+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Tile images repeated in thick blocks without variants, and how many copies of each a scene shows. */
export function repeatedTiles(dir: string, scene: SceneDef): { image: string; cells: number }[] {
  const cells = new Map<string, number>();
  for (const entity of scene.entities) {
    const sprite = entity.components.sprite;
    if (!sprite?.tile || typeof sprite.image !== "string") continue;
    if (Array.isArray(sprite.variants) && sprite.variants.length > 0) continue;
    const size = svgSize(join(dir, sprite.image));
    const width = Number(sprite.width || entity.components.body?.width || 0);
    const height = Number(sprite.height || entity.components.body?.height || 0);
    if (!size || width / size.width < THICK_CELLS || height / size.height < THICK_CELLS) continue;
    cells.set(sprite.image, (cells.get(sprite.image) ?? 0) + (width / size.width) * (height / size.height));
  }
  return [...cells].filter(([, count]) => count >= MANY_CELLS).map(([image, count]) => ({ image, cells: Math.round(count) }));
}
