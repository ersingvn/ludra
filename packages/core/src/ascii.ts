import type { Entity, World } from "./world.ts";

export interface AsciiOptions {
  /** Width of the map in characters. Defaults to 80. */
  columns?: number;
}

const LEGEND = "@ player  # solid  = moving solid  o collectible  ^ hazard  E enemy  G goal  + sensor  D dynamic";

/**
 * Draws the world as text so an agent can "see" a frame without a browser.
 * Characters are about twice as tall as they are wide, so each row covers
 * two columns' worth of pixels.
 */
export function renderAscii(world: World, options: AsciiOptions = {}): string {
  const columns = options.columns ?? 80;
  const cellWidth = world.width / columns;
  const cellHeight = cellWidth * 2;
  const rows = Math.max(1, Math.ceil(world.height / cellHeight));
  const grid = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  const outside: string[] = [];

  const paint = (e: Entity, char: string) => {
    const b = e.body!;
    const left = Math.floor((e.transform.x - b.width / 2) / cellWidth);
    const right = Math.max(left, Math.ceil((e.transform.x + b.width / 2) / cellWidth) - 1);
    const top = Math.floor((e.transform.y - b.height / 2) / cellHeight);
    const bottom = Math.max(top, Math.ceil((e.transform.y + b.height / 2) / cellHeight) - 1);
    if (right < 0 || left >= columns || bottom < 0 || top >= rows) {
      // Off-screen static bodies (boundary walls) are expected; moving ones usually mean a bug.
      if (b.type !== "static") outside.push(`${char} ${e.id} is outside the world at (${Math.round(e.transform.x)}, ${Math.round(e.transform.y)})`);
      return;
    }
    for (let row = Math.max(0, top); row <= Math.min(rows - 1, bottom); row++) {
      for (let col = Math.max(0, left); col <= Math.min(columns - 1, right); col++) {
        grid[row]![col] = char;
      }
    }
  };

  // Later passes draw on top of earlier ones.
  const withBody = world.entities.filter((e) => e.body);
  const passes: [string, (e: Entity) => boolean][] = [
    ["#", (e) => e.body!.type === "static" && !e.body!.sensor],
    ["=", (e) => e.body!.type === "kinematic" && !e.body!.sensor],
    ["+", (e) => e.body!.sensor && !e.collectible && !e.hazard && !e.goal],
    ["o", (e) => !!e.collectible],
    ["G", (e) => !!e.goal],
    ["^", (e) => !!e.hazard && e.body!.type !== "kinematic"],
    ["E", (e) => !!e.hazard && e.body!.type === "kinematic"],
    ["D", (e) => e.body!.type === "dynamic" && !e.platformer && !e.topdown],
    ["@", (e) => !!(e.platformer || e.topdown)],
  ];
  for (const [char, test] of passes) {
    for (const e of withBody.filter(test)) paint(e, char);
  }

  const border = `+${"-".repeat(columns)}+`;
  const lines = [
    `t=${world.time.toFixed(2)}s  frame ${world.frame}  score ${world.score}  deaths ${world.deaths}${world.won ? "  WON" : ""}  (1 char = ${round(cellWidth)}x${round(cellHeight)}px)`,
    border,
    ...grid.map((row) => `|${row.join("")}|`),
    border,
    LEGEND,
    ...outside,
  ];
  return lines.join("\n");
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
