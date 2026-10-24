export type Action = "left" | "right" | "up" | "down" | "jump" | "action";

export const ACTIONS: readonly Action[] = ["left", "right", "up", "down", "jump", "action"];

/** An entity as written in a scene file. */
export interface EntityDef {
  id: string;
  components: Record<string, Record<string, unknown>>;
}

export interface WorldSettings {
  /** World size in pixels. Defaults to 960 x 540. */
  width?: number;
  height?: number;
  /** Downward acceleration in px/s². Defaults to 1800. */
  gravity?: number;
  background?: string;
}

/** A scene file (`*.scene.json`). */
export interface SceneDef {
  name?: string;
  world?: WorldSettings;
  entities: EntityDef[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  /** JSON path to the problem, e.g. `entities[2].components.body.width`. */
  path: string;
  message: string;
  /** A concrete change an agent can apply directly. */
  fix?: string;
}
