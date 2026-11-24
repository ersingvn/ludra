import type { EntityDef, SceneDef } from "../src/index.ts";

/**
 * A long platformer level for testing search at scale: `columns` 40 px columns of ground with gaps,
 * raised ledges, spikes and patrolling enemies, the goal at the far end. Built from a fixed pattern,
 * so it is the same on every run, and every part of it can be cleared with ordinary jumps.
 * `coins` puts a coin over every other column: each changes the score, so the situations a search
 * tells apart multiply along the level.
 */
export function longLevel(columns = 100, options: { coins?: boolean } = {}): SceneDef {
  const tile = 40;
  const width = columns * tile;
  const entities: EntityDef[] = [];
  const solid = (id: string, x: number, y: number, w: number, h: number) => entities.push({ id, components: { transform: { x, y }, body: { type: "static", width: w, height: h } } });
  // Ground pieces: runs of columns, broken by gaps of 2 columns (80 px), every few runs a raised ledge.
  let col = 0;
  let piece = 0;
  while (col < columns) {
    const run = 6 + ((piece * 5) % 5);
    const end = Math.min(columns, col + run);
    const raised = piece % 4 === 3;
    const top = raised ? 420 : 500;
    solid(`ground-${piece}`, ((col + end) / 2) * tile, top + 20 + (raised ? 40 : 0), (end - col) * tile, raised ? 120 : 40);
    if (piece % 3 === 1 && end - col >= 6) {
      const x = (col + 3) * tile;
      entities.push({ id: `spikes-${piece}`, components: { transform: { x, y: top - 10 }, body: { type: "static", width: 36, height: 20, sensor: true }, hazard: {} } });
    }
    if (piece % 5 === 2 && end - col >= 7) {
      entities.push({
        id: `slime-${piece}`,
        components: { transform: { x: (col + 1.5) * tile, y: top - 12 }, body: { type: "kinematic", width: 28, height: 24, sensor: true }, patrol: { axis: "x", distance: (end - col - 3) * tile, speed: 60 }, hazard: {} },
      });
    }
    if (options.coins) {
      for (let c = col; c < end; c += 2) {
        entities.push({ id: `coin-${c}`, components: { transform: { x: (c + 0.5) * tile, y: top - 60 }, body: { type: "static", width: 16, height: 16, sensor: true }, collectible: {} } });
      }
    }
    col = end + 2;
    piece++;
  }
  solid("wall-left", -10, 270, 20, 540);
  entities.push({ id: "player", components: { transform: { x: 60, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } });
  entities.push({ id: "goal", components: { transform: { x: width - 80, y: 440 }, body: { type: "static", width: 30, height: 60, sensor: true }, goal: {} } });
  return { world: { width, height: 540 }, entities };
}
