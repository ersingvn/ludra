export type Action = "left" | "right" | "up" | "down" | "jump" | "action";

export const ACTIONS: readonly Action[] = ["left", "right", "up", "down", "jump", "action"];

export const EVENT_TYPES = ["jump", "land", "collect", "die", "stomp", "win"] as const;
export type GameEventType = (typeof EVENT_TYPES)[number];

/** What happens visually and audibly when a game event fires. See `EFFECT_FIELDS`. */
export interface EffectDef {
  particles?: Record<string, unknown>;
  sound?: string;
  shake?: number;
}

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
  /** Seed for `world.random()` in scripts. Defaults to 1. */
  seed?: number;
}

/** A scene file (`*.scene.json`). */
export interface SceneDef {
  name?: string;
  world?: WorldSettings;
  /**
   * Feedback for game events, e.g. `{ "collect": { "sound": "coin" } }`. Visual and audio only.
   * Keys are built-in event types or names scripts pass to `world.emit`.
   */
  effects?: Partial<Record<GameEventType, EffectDef>> & Record<string, EffectDef | undefined>;
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
