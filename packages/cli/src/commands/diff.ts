import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fixed, pad, padStart, paint } from "../format.ts";
import { decodePng, encodePng, type Rgba } from "../png.ts";
import { CliError } from "../project.ts";

export interface DiffOptions {
  out?: string;
  threshold?: string;
  json?: boolean;
}

/** A changed part of the frame, in pixels of the images compared. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where on screen, e.g. "top left", "middle". */
  where: string;
  /** Share of the region's pixels that changed, 0–1. */
  changed: number;
}

export type Comparison =
  | { name: string; status: "same" }
  | { name: string; status: "changed"; changed: number; regions: Region[]; moreRegions: number; image: string }
  | { name: string; status: "resized"; before: { width: number; height: number }; after: { width: number; height: number } }
  | { name: string; status: "added" | "removed" };

/** Pixels are compared in cells this many pixels across; nearby changed cells make one region. */
const CELL = 8;
/** Most regions listed per image, largest first. */
const MAX_REGIONS = 8;
const DEFAULT_THRESHOLD = 24;

/**
 * `ludra diff <before> <after>`: what changed between two screenshots, or two
 * folders of them matched by file name. Writes an image per changed pair with
 * the changes painted over a faded copy of the after frame.
 */
export function diff(before: string | undefined, after: string | undefined, options: DiffOptions): number {
  if (!before || !after) {
    throw new CliError("Usage: ludra diff <before> <after> [--out folder] [--threshold 24] [--json]. Compares two PNGs, or two folders of PNGs by file name.");
  }
  for (const path of [before, after]) if (!existsSync(path)) throw new CliError(`No file or folder at ${path}.`);
  const folders = statSync(before).isDirectory();
  if (folders !== statSync(after).isDirectory()) throw new CliError("Compare a file with a file, or a folder with a folder.");
  const threshold = Number(options.threshold ?? DEFAULT_THRESHOLD);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new CliError(`--threshold must be a whole number from 0 to 255 (how much a colour channel must change), got "${options.threshold}".`);
  }

  const outDir = resolve(options.out ?? join("screenshots", "diff"));
  const pairs = folders ? pairFolders(before, after) : [{ name: basename(after), before, after }];
  const results = pairs.map((pair) => compare(pair, threshold, outDir));

  if (options.json) {
    console.log(JSON.stringify({ threshold, results }, null, 2));
    return 0;
  }
  print(results, threshold);
  return 0;
}

function pairFolders(before: string, after: string): { name: string; before?: string; after?: string }[] {
  const pngs = (dir: string) => new Set(readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")));
  const a = pngs(before);
  const b = pngs(after);
  if (a.size === 0 && b.size === 0) throw new CliError(`Neither ${before} nor ${after} has any PNGs.`);
  return [...new Set([...a, ...b])]
    .sort()
    .map((name) => ({ name, before: a.has(name) ? join(before, name) : undefined, after: b.has(name) ? join(after, name) : undefined }));
}

function compare(pair: { name: string; before?: string; after?: string }, threshold: number, outDir: string): Comparison {
  if (!pair.before) return { name: pair.name, status: "added" };
  if (!pair.after) return { name: pair.name, status: "removed" };
  const a = read(pair.before);
  const b = read(pair.after);
  if (a.width !== b.width || a.height !== b.height) {
    return { name: pair.name, status: "resized", before: { width: a.width, height: a.height }, after: { width: b.width, height: b.height } };
  }
  const changedPixels = changes(a, b, threshold);
  const count = changedPixels.reduce((sum, v) => sum + v, 0);
  if (count === 0) return { name: pair.name, status: "same" };

  const regions = findRegions(changedPixels, b.width, b.height);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, pair.name);
  writeFileSync(path, encodePng(paintChanges(b, changedPixels, regions)));
  return {
    name: pair.name,
    status: "changed",
    changed: count / (b.width * b.height),
    regions: regions.slice(0, MAX_REGIONS),
    moreRegions: Math.max(0, regions.length - MAX_REGIONS),
    image: relative(process.cwd(), path).replaceAll("\\", "/"),
  };
}

function read(file: string): Rgba {
  try {
    return decodePng(readFileSync(file));
  } catch (err) {
    throw new CliError(`Can't read ${file}: ${(err as Error).message}.`);
  }
}

/** 1 where any colour channel (or alpha) moved by more than `threshold`, else 0. */
export function changes(a: Rgba, b: Rgba, threshold: number): Uint8Array {
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a.data[o + c]! - b.data[o + c]!) > threshold) {
        out[i] = 1;
        break;
      }
    }
  }
  return out;
}

/** Groups changed pixels into boxes: changed cells, touching or one cell apart, are one region. Largest first. */
export function findRegions(changed: Uint8Array, width: number, height: number): Region[] {
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const cells = new Uint32Array(columns * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (changed[y * width + x]) cells[Math.floor(y / CELL) * columns + Math.floor(x / CELL)]!++;
  }

  const seen = new Uint8Array(cells.length);
  const regions: Region[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let [minX, minY, maxX, maxY, pixels] = [columns, rows, 0, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const cx = cell % columns;
      const cy = Math.floor(cell / columns);
      [minX, minY, maxX, maxY] = [Math.min(minX, cx), Math.min(minY, cy), Math.max(maxX, cx), Math.max(maxY, cy)];
      pixels += cells[cell]!;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const next = ny * columns + nx;
          if (cells[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    const x = minX * CELL;
    const y = minY * CELL;
    const w = Math.min(width, (maxX + 1) * CELL) - x;
    const h = Math.min(height, (maxY + 1) * CELL) - y;
    regions.push({ x, y, width: w, height: h, where: where(x + w / 2, y + h / 2, width, height), changed: pixels / (w * h) });
  }
  return regions.sort((r, s) => s.width * s.height - r.width * r.height);
}

/** "top left" … "bottom right" by thirds of the frame; the centre third is "middle". */
function where(x: number, y: number, width: number, height: number): string {
  const third = (v: number, size: number) => Math.min(2, Math.floor((v / size) * 3));
  const row = ["top", "middle", "bottom"][third(y, height)]!;
  const column = ["left", "middle", "right"][third(x, width)]!;
  if (row === "middle" && column === "middle") return "middle";
  if (row === "middle") return column;
  if (column === "middle") return row;
  return `${row} ${column}`;
}

/** The after frame faded to grey, changed pixels in magenta, each region outlined. */
function paintChanges(after: Rgba, changed: Uint8Array, regions: Region[]): Rgba {
  const data = new Uint8Array(after.data.length);
  for (let i = 0; i < changed.length; i++) {
    const o = i * 4;
    if (changed[i]) {
      data.set([255, 0, 200, 255], o);
    } else {
      const grey = (after.data[o]! * 0.3 + after.data[o + 1]! * 0.59 + after.data[o + 2]! * 0.11) * 0.35 + 30;
      data.set([grey, grey, grey, 255], o);
    }
  }
  const dot = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < after.width && y < after.height) data.set([255, 230, 0, 255], (y * after.width + x) * 4);
  };
  for (const r of regions.slice(0, MAX_REGIONS)) {
    for (let t = 0; t < 2; t++) {
      for (let x = r.x - 2; x < r.x + r.width + 2; x++) {
        dot(x, r.y - 2 + t);
        dot(x, r.y + r.height + 1 - t);
      }
      for (let y = r.y - 2; y < r.y + r.height + 2; y++) {
        dot(r.x - 2 + t, y);
        dot(r.x + r.width + 1 - t, y);
      }
    }
  }
  return { width: after.width, height: after.height, data };
}

function print(results: Comparison[], threshold: number): void {
  const changed = results.filter((r) => r.status !== "same").length;
  console.log(
    paint("bold", `◧ ${results.length} image${results.length === 1 ? "" : "s"} compared: ${changed === 0 ? "no changes" : `${changed} changed`}`) +
      paint("dim", `  (a pixel counts as changed when a channel moves by more than ${threshold})`),
  );
  const width = Math.max(8, ...results.map((r) => r.name.length));
  for (const r of results) {
    const name = pad(r.name, width);
    switch (r.status) {
      case "same":
        console.log(`  ${name} ${paint("dim", "same")}`);
        break;
      case "added":
      case "removed":
        console.log(`  ${name} ${paint("yellow", `${r.status}: only in the ${r.status === "added" ? "after" : "before"} folder`)}`);
        break;
      case "resized":
        console.log(`  ${name} ${paint("yellow", `resized ${r.before.width}×${r.before.height} → ${r.after.width}×${r.after.height}`)}: not compared pixel by pixel`);
        break;
      case "changed":
        console.log(`  ${name} ${paint("red", `${padStart(fixed(r.changed * 100, 2), 6)}% of pixels changed`)} in ${r.regions.length + r.moreRegions} region${r.regions.length + r.moreRegions === 1 ? "" : "s"} → ${r.image}`);
        for (const region of r.regions) {
          console.log(
            paint("dim", `      ${pad(region.where, 13)} x ${padStart(String(region.x), 4)}  y ${padStart(String(region.y), 4)}  ${region.width}×${region.height}  (${fixed(region.changed * 100, 0)}% of it changed)`),
          );
        }
        if (r.moreRegions > 0) console.log(paint("dim", `      … ${r.moreRegions} smaller regions`));
        break;
    }
  }
}
