/**
 * Finding a way around walls, for enemies, companions and anything else that has somewhere to be.
 *
 * The world is laid out as a grid of cells. A cell is blocked when a solid (a static body that isn't a
 * sensor) covers it, grown by the walker's half-size so that a path through free cells keeps the
 * walker's whole body clear of walls. A* finds the cheapest way through free cells (8 directions, never
 * cutting a wall's corner), and the path is then pulled tight, so it goes straight wherever it can.
 *
 * Deterministic: integer costs, a fixed neighbor order and a total tie-break, so the same world gives the
 * same path on every machine.
 */

export interface NavPoint {
  x: number;
  y: number;
}

/** A solid's box, centered on (x, y). */
export interface NavObstacle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavGrid {
  cell: number;
  cols: number;
  rows: number;
  /** 1 where the walker can't stand. */
  blocked: Uint8Array;
}

/** Straight and diagonal step costs: 10 and 14 keep the costs integers (√2 ≈ 1.4). */
const STRAIGHT = 10;
const DIAGONAL = 14;
/** The 8 neighbors, in the fixed order that keeps paths the same everywhere. */
const STEPS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, STRAIGHT],
  [0, 1, STRAIGHT],
  [-1, 0, STRAIGHT],
  [0, -1, STRAIGHT],
  [1, 1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
  [1, -1, DIAGONAL],
];

/**
 * Lays the world out as cells of `cell` px, with every obstacle grown by `inflate` px on each side.
 * The world spans (0, 0) to (width, height); a walker can't leave it.
 */
export function buildGrid(width: number, height: number, cell: number, inflate: number, obstacles: readonly NavObstacle[]): NavGrid {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const blocked = new Uint8Array(cols * rows);
  for (const o of obstacles) {
    const left = o.x - o.width / 2 - inflate;
    const right = o.x + o.width / 2 + inflate;
    const top = o.y - o.height / 2 - inflate;
    const bottom = o.y + o.height / 2 + inflate;
    // A cell is blocked when its center is inside the grown box.
    const c0 = Math.max(0, Math.ceil(left / cell - 0.5));
    const c1 = Math.min(cols - 1, Math.floor(right / cell - 0.5));
    const r0 = Math.max(0, Math.ceil(top / cell - 0.5));
    const r1 = Math.min(rows - 1, Math.floor(bottom / cell - 0.5));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[r * cols + c] = 1;
  }
  // The world's edges are walls too: keep the walker's body inside.
  const edge = Math.ceil(inflate / cell - 0.5);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cell;
      const cy = (r + 0.5) * cell;
      if (edge > 0 && (cx < inflate || cy < inflate || cx > width - inflate || cy > height - inflate)) blocked[r * cols + c] = 1;
    }
  }
  return { cell, cols, rows, blocked };
}

/**
 * The way from `from` to `to` as waypoints, without the start and ending at `to` (or, when `to` is inside
 * a wall, at the nearest place the walker can stand). Undefined when there's no way at all.
 */
export function findPath(grid: NavGrid, from: NavPoint, to: NavPoint): NavPoint[] | undefined {
  const start = nearestFree(grid, cellOf(grid, from));
  const goal = nearestFree(grid, cellOf(grid, to));
  if (start === undefined || goal === undefined) return undefined;
  const goalExact = goal === cellOf(grid, to) && !grid.blocked[goal];

  const cells = aStar(grid, start, goal);
  if (!cells) return undefined;

  // Pull the path tight: from each corner, go to the farthest cell still in a straight, clear line.
  const center = (i: number): NavPoint => ({ x: ((i % grid.cols) + 0.5) * grid.cell, y: (Math.floor(i / grid.cols) + 0.5) * grid.cell });
  const points: NavPoint[] = [];
  let here = from;
  let k = 0;
  while (k < cells.length - 1) {
    let far = k + 1;
    for (let j = cells.length - 1; j > k + 1; j--) {
      if (clear(grid, here, center(cells[j]!))) {
        far = j;
        break;
      }
    }
    here = center(cells[far]!);
    points.push(here);
    k = far;
  }
  const end = goalExact ? { x: to.x, y: to.y } : center(goal);
  if (points.length > 0) points[points.length - 1] = end;
  else points.push(end);
  // The start itself was the corner: from a free start, a straight line may reach farther.
  while (points.length > 1 && clear(grid, from, points[1]!)) points.shift();
  return points;
}

/** True when a walker can go straight from a to b without entering a blocked cell. */
export function clear(grid: NavGrid, a: NavPoint, b: NavPoint): boolean {
  // Walk the line in steps of a quarter cell: fine enough that it can't skip a cell's corner.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(length / (grid.cell / 4)));
  for (let s = 0; s <= steps; s++) {
    const x = a.x + (dx * s) / steps;
    const y = a.y + (dy * s) / steps;
    const c = Math.floor(x / grid.cell);
    const r = Math.floor(y / grid.cell);
    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
    if (grid.blocked[r * grid.cols + c]) {
      // The start may be in a wall's grown edge (pressed against it): let it leave.
      if (s === 0) continue;
      return false;
    }
  }
  return true;
}

function cellOf(grid: NavGrid, p: NavPoint): number {
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor(p.x / grid.cell)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.floor(p.y / grid.cell)));
  return r * grid.cols + c;
}

/** The free cell closest to `i` (itself when free), searching outward ring by ring. */
function nearestFree(grid: NavGrid, i: number): number | undefined {
  if (!grid.blocked[i]) return i;
  const c0 = i % grid.cols;
  const r0 = Math.floor(i / grid.cols);
  const max = Math.max(grid.cols, grid.rows);
  for (let ring = 1; ring < max; ring++) {
    let best: number | undefined;
    let bestDistance = Infinity;
    for (let r = r0 - ring; r <= r0 + ring; r++) {
      for (let c = c0 - ring; c <= c0 + ring; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
        const j = r * grid.cols + c;
        if (grid.blocked[j]) continue;
        const d = (r - r0) * (r - r0) + (c - c0) * (c - c0);
        if (d < bestDistance || (d === bestDistance && j < best!)) {
          best = j;
          bestDistance = d;
        }
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

/** Octile distance in step costs: exact on an empty grid, so A* never overestimates. */
function heuristic(grid: NavGrid, a: number, b: number): number {
  const dx = Math.abs((a % grid.cols) - (b % grid.cols));
  const dy = Math.abs(Math.floor(a / grid.cols) - Math.floor(b / grid.cols));
  return STRAIGHT * Math.max(dx, dy) + (DIAGONAL - STRAIGHT) * Math.min(dx, dy);
}

/** The cells from start to goal, both included, or undefined when they aren't connected. */
function aStar(grid: NavGrid, start: number, goal: number): number[] | undefined {
  const n = grid.cols * grid.rows;
  const g = new Int32Array(n).fill(-1);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap();
  g[start] = 0;
  heap.push(heuristic(grid, start, goal), heuristic(grid, start, goal), start);
  while (heap.size > 0) {
    const i = heap.pop();
    if (closed[i]) continue;
    if (i === goal) {
      const cells = [i];
      for (let j = from[i]!; j !== -1; j = from[j]!) cells.push(j);
      return cells.reverse();
    }
    closed[i] = 1;
    const c = i % grid.cols;
    const r = Math.floor(i / grid.cols);
    for (const [dc, dr, cost] of STEPS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
      const j = nr * grid.cols + nc;
      if (grid.blocked[j] || closed[j]) continue;
      // No cutting corners: a diagonal step needs both cells beside it free.
      if (dc !== 0 && dr !== 0 && (grid.blocked[r * grid.cols + nc] || grid.blocked[nr * grid.cols + c])) continue;
      const next = g[i]! + cost;
      if (g[j] !== -1 && next >= g[j]!) continue;
      g[j] = next;
      from[j] = i;
      const h = heuristic(grid, j, goal);
      heap.push(next + h, h, j);
    }
  }
  return undefined;
}

/** A binary min-heap ordered by f, then h, then cell index: a total order, so ties never depend on luck. */
class Heap {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length / 3;
  }

  push(f: number, h: number, i: number): void {
    const a = this.items;
    a.push(f, h, i);
    let k = a.length / 3 - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }

  pop(): number {
    const a = this.items;
    const top = a[2]!;
    const last = a.length / 3 - 1;
    if (last > 0) this.swap(0, last);
    a.length -= 3;
    let k = 0;
    const size = a.length / 3;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < size && this.less(l, m)) m = l;
      if (r < size && this.less(r, m)) m = r;
      if (m === k) break;
      this.swap(k, m);
      k = m;
    }
    return top;
  }

  private less(x: number, y: number): boolean {
    const a = this.items;
    const [fx, hx, ix] = [a[3 * x]!, a[3 * x + 1]!, a[3 * x + 2]!];
    const [fy, hy, iy] = [a[3 * y]!, a[3 * y + 1]!, a[3 * y + 2]!];
    return fx !== fy ? fx < fy : hx !== hy ? hx < hy : ix < iy;
  }

  private swap(x: number, y: number): void {
    const a = this.items;
    for (let k = 0; k < 3; k++) {
      const t = a[3 * x + k]!;
      a[3 * x + k] = a[3 * y + k]!;
      a[3 * y + k] = t;
    }
  }
}
