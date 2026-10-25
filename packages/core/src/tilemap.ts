/**
 * Tilemaps: a level drawn as rows of characters. Each character is looked up in a
 * legend and becomes ordinary entities before anything else sees the scene, so
 * physics, rendering, tests and `play --ascii` need nothing new.
 */

type Report = (code: string, path: string, message: string, fix?: string) => void;

/** One legend entry: a tile (merged with its neighbors into big bodies) or a thing placed in a cell. */
export interface TileDef {
  /** Image drawn tiled over the block, e.g. "assets/brick.svg". */
  image?: string;
  /** Color when there is no image. */
  color?: string;
  /** Blocks movement. Default: true, unless the entry places a prefab. */
  solid?: boolean;
  /** Overlap-only body, for hazards, ladders and triggers. */
  sensor?: boolean;
  layer?: number;
  /** Places this prefab, centered in the cell, instead of a tile. */
  prefab?: string;
  /** More components for every block or placed entity (e.g. "hazard": {}). */
  components?: Record<string, Record<string, unknown>>;
  /** Merge neighboring cells of this character into rectangles. Default: true for tiles, false for prefabs. */
  merge?: boolean;
}

/** Characters that leave a cell empty. */
export const EMPTY_CELLS = [" ", "."];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

const EXAMPLE = `Use "tilemap": { "tileSize": 40, "rows": ["#....c...#", "##########"], "legend": { "#": { "image": "assets/brick.svg" }, "c": "coin" } }.`;
const ENTRY_FIELDS = ["image", "color", "solid", "sensor", "layer", "prefab", "components", "merge"];

/**
 * Replaces every entity's `tilemap` component with the entities it describes. Generated
 * entities are added after the scene's own, so paths into the file stay correct; each is
 * named `<tilemap id>-<row>-<col>` after its top-left cell (0-based).
 */
export function expandTilemaps(raw: Record<string, unknown>, error: Report): Record<string, unknown> {
  if (!Array.isArray(raw.entities)) return raw;
  const generated: Record<string, unknown>[] = [];
  const entities = raw.entities.map((entity: unknown, i: number) => {
    if (!isObject(entity) || !isObject(entity.components) || entity.components.tilemap === undefined) return entity;
    const { tilemap, ...components } = entity.components;
    const path = `entities[${i}].components.tilemap`;
    const id = typeof entity.id === "string" ? entity.id : `tilemap${i}`;
    const origin = isObject(components.transform) ? components.transform : {};
    generated.push(...expandOne(tilemap, path, id, numberOr(origin.x, 0), numberOr(origin.y, 0), isObject(raw.prefabs) ? raw.prefabs : {}, error));
    return { ...entity, components };
  });
  return { ...raw, entities: [...entities, ...generated] };
}

function expandOne(tilemap: unknown, path: string, id: string, left: number, top: number, prefabs: Record<string, unknown>, error: Report): Record<string, unknown>[] {
  const bail = (code: string, at: string, message: string, fix?: string): [] => {
    error(code, at, message, fix);
    return [];
  };
  if (!isObject(tilemap)) return bail("E_TILEMAP", path, "tilemap must be an object.", EXAMPLE);
  const size = tilemap.tileSize ?? 40;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 1) return bail("E_TILEMAP", `${path}.tileSize`, `tilemap.tileSize must be a number of at least 1, got ${show(size)}.`);
  const rows = tilemap.rows;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => typeof row === "string")) {
    return bail("E_TILEMAP", `${path}.rows`, "tilemap.rows must be a non-empty list of strings, one per row, one character per cell.", EXAMPLE);
  }
  if (!isObject(tilemap.legend)) return bail("E_TILEMAP", `${path}.legend`, "tilemap.legend must map characters to tiles or prefab names.", EXAMPLE);
  for (const key of Object.keys(tilemap)) {
    if (!["tileSize", "rows", "legend"].includes(key)) error("E_TILEMAP", `${path}.${key}`, `tilemap has no field "${key}". Fields: tileSize, rows, legend.`);
  }

  // Read the legend once: each character is a tile or a prefab placement.
  const legend = new Map<string, TileDef>();
  for (const [char, value] of Object.entries(tilemap.legend)) {
    const at = `${path}.legend.${char}`;
    if ([...char].length !== 1) {
      error("E_TILEMAP", at, `Legend keys are single characters, got "${char}".`);
      continue;
    }
    if (EMPTY_CELLS.includes(char)) {
      error("E_TILEMAP", at, `"${char}" always means an empty cell. Pick another character.`);
      continue;
    }
    const def: TileDef | undefined = typeof value === "string" ? { prefab: value } : isObject(value) ? (value as TileDef) : undefined;
    if (!def) {
      error("E_TILEMAP", at, `A legend entry is a prefab name or a tile like { "image": "assets/brick.svg" }, got ${show(value)}.`, EXAMPLE);
      continue;
    }
    if (isObject(value)) {
      for (const key of Object.keys(value)) if (!ENTRY_FIELDS.includes(key)) error("E_TILEMAP", `${at}.${key}`, `A legend entry has no field "${key}". Fields: ${ENTRY_FIELDS.join(", ")}.`);
    }
    if (def.prefab !== undefined && (typeof def.prefab !== "string" || !isObject(prefabs[def.prefab]))) {
      const names = Object.keys(prefabs);
      error("E_UNKNOWN_PREFAB", typeof value === "string" ? at : `${at}.prefab`, `Prefab ${show(def.prefab)} does not exist.`, names.length > 0 ? `Prefabs: ${names.join(", ")}.` : 'Create prefabs/<name>.prefab.json with { "components": { ... } }.');
      continue;
    }
    if (def.components !== undefined && !isObject(def.components)) {
      error("E_TILEMAP", `${at}.components`, 'components must be an object of components, e.g. { "hazard": {} }.');
      continue;
    }
    legend.set(char, def);
  }

  // Unknown characters: report each once, with where it first appears.
  const grid = rows.map((row) => [...(row as string)]);
  const reported = new Set<string>();
  grid.forEach((cells, r) =>
    cells.forEach((char, c) => {
      if (EMPTY_CELLS.includes(char) || legend.has(char) || reported.has(char) || Object.hasOwn(tilemap.legend as object, char)) return;
      reported.add(char);
      error("E_TILEMAP", `${path}.rows[${r}]`, `"${char}" (row ${r}, column ${c}) is not in the legend.`, `Add "${char}" to the legend, or use " " or "." for an empty cell.`);
    }),
  );

  const out: Record<string, unknown>[] = [];
  const used = grid.map((cells) => cells.map(() => false));
  grid.forEach((cells, r) =>
    cells.forEach((char, c) => {
      const def = legend.get(char);
      if (!def || used[r]![c]) return;
      const merge = def.merge ?? def.prefab === undefined;
      // A whole horizontal run first (floors stay one piece), then the rows below that have
      // exactly the same run (walls and thick ground stack into one block).
      let width = 1;
      let height = 1;
      if (merge) {
        while (grid[r]![c + width] === char && !used[r]![c + width]) width++;
        const sameRun = (row: number) =>
          grid[row] !== undefined &&
          grid[row]![c - 1] !== char &&
          grid[row]![c + width] !== char &&
          Array.from({ length: width }, (_, k) => grid[row]![c + k] === char && !used[row]![c + k]).every(Boolean);
        while (sameRun(r + height)) height++;
      }
      for (let dr = 0; dr < height; dr++) for (let dc = 0; dc < width; dc++) used[r + dr]![c + dc] = true;
      out.push(cellEntity(def, `${id}-${r}-${c}`, left + (c + width / 2) * size, top + (r + height / 2) * size, width * size, height * size));
    }),
  );
  return out;
}

function cellEntity(def: TileDef, id: string, x: number, y: number, width: number, height: number): Record<string, unknown> {
  const extra = structuredClone(def.components ?? {});
  if (def.prefab !== undefined) {
    // The prefab supplies the rest; expandPrefabs merges it in next.
    return { id, prefab: def.prefab, components: { ...extra, transform: { x, y, ...(extra.transform ?? {}) } } };
  }
  const components: Record<string, Record<string, unknown>> = { transform: { x, y } };
  if (def.solid !== false || def.sensor) components.body = { type: "static", width, height, ...(def.sensor ? { sensor: true } : {}) };
  if (def.image !== undefined || def.color !== undefined) {
    components.sprite = {
      ...(def.image !== undefined ? { image: def.image, tile: true } : {}),
      ...(def.color !== undefined ? { color: def.color } : {}),
      ...(def.layer !== undefined ? { layer: def.layer } : {}),
      // Without a body the sprite needs its own size.
      ...(components.body ? {} : { width, height }),
    };
  }
  for (const [name, value] of Object.entries(extra)) components[name] = isObject(components[name]) && isObject(value) ? { ...components[name], ...value } : value;
  return { id, components };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
