import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { colorDistance } from "./readability.ts";

/**
 * `game.md`: what a game means to be, written before its first asset. Tools can tell a working
 * game from a broken one, but only a decision can tell one game's look from any other's, so
 * review asks for that decision and holds the art to the part of it that can be measured.
 */
export interface Direction {
  /** What a player should remember. */
  promise: string;
  /** The visual language in a few words: "16-color pixel art at 480x270". */
  style: string;
  /** How text looks, and why. */
  type: string;
  palette: string[];
}

/** Colors this far from every palette color (ΔE) were not chosen from it. */
const NEAR_PALETTE = 24;
/** Below this, greys and near-blacks: shadows and outlines belong to every palette. */
const NEUTRAL_CHROMA = 12;
/** Art drifts a little; past this share of its colors it has left the palette. */
const MAX_OFF_PALETTE = 0.4;
const MIN_PALETTE = 3;
const HEX = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi;
const ART_FILES = new Set([".svg", ".ts", ".js", ".frag", ".json"]);
const ART_FOLDERS = ["assets", "scripts", "shaders", "scenes", "prefabs"];

export function parseDirection(text: string): Partial<Direction> {
  const section = (name: string) => text.match(new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"))?.[1]?.trim();
  const field = (body: string | undefined, name: string) => body?.match(new RegExp(`^[-*]\\s*${name}\\s*:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const look = section("Look");
  const palette = field(look, "palette")?.match(HEX)?.map((c) => c.toLowerCase());
  const parsed: Partial<Direction> = {};
  const promise = section("Promise");
  const style = field(look, "style");
  const type = field(look, "type");
  if (promise) parsed.promise = promise;
  if (style) parsed.style = style;
  if (type) parsed.type = type;
  if (palette) parsed.palette = palette;
  return parsed;
}

/** What game.md has yet to decide. */
export function missingFromDirection(direction: Partial<Direction>): string[] {
  const missing: string[] = [];
  if (!direction.promise) missing.push('"## Promise"');
  if (!direction.style) missing.push('"- style:" under "## Look"');
  if (!direction.type) missing.push('"- type:" under "## Look"');
  if ((direction.palette?.length ?? 0) < MIN_PALETTE) missing.push(`"- palette:" with at least ${MIN_PALETTE} colors under "## Look"`);
  return missing;
}

export function readDirection(dir: string): Partial<Direction> | undefined {
  const file = join(dir, "game.md");
  return existsSync(file) ? parseDirection(readFileSync(file, "utf8")) : undefined;
}

function rgb(hex: string): number[] {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
}

function chroma([r, g, b]: number[]): number {
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
}

/** Every color written into the game's art and code, once each. */
export function colorsOfProject(dir: string): string[] {
  const found = new Set<string>();
  const visit = (folder: string) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (ART_FILES.has(extname(entry.name))) for (const color of readFileSync(path, "utf8").match(HEX) ?? []) found.add(color.toLowerCase());
    }
  };
  for (const folder of ART_FOLDERS) visit(join(dir, folder));
  return [...found];
}

/** The colors that belong to no palette entry, once the neutrals are set aside, and how many were weighed. */
export function offPalette(colors: readonly string[], palette: readonly string[]): { off: string[]; weighed: number } {
  const chosen = palette.map(rgb);
  const weighed = colors.filter((color) => chroma(rgb(color)) >= NEUTRAL_CHROMA);
  return { off: weighed.filter((color) => chosen.every((c) => colorDistance(rgb(color), c) > NEAR_PALETTE)), weighed: weighed.length };
}

export function hasLeftPalette({ off, weighed }: { off: string[]; weighed: number }): boolean {
  return weighed > 0 && off.length / weighed > MAX_OFF_PALETTE;
}
