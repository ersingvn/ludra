import type { MusicDef, SoundDef } from "./sound.ts";

export type Action = "left" | "right" | "up" | "down" | "jump" | "action";

export const ACTIONS: readonly Action[] = ["left", "right", "up", "down", "jump", "action"];

export const EVENT_TYPES = ["jump", "land", "collect", "die", "stomp", "win", "bounce", "checkpoint", "gameover", "goto"] as const;
export type GameEventType = (typeof EVENT_TYPES)[number];

/** What happens visually and audibly when a game event fires. See `EFFECT_FIELDS`. */
export interface EffectDef {
  particles?: Record<string, unknown>;
  sound?: string;
  shake?: number;
}

export interface PostFxDef {
  /** Path to a GLSL ES 1.0 fragment shader, e.g. "shaders/crt.frag". */
  shader: string;
  /** Extra float uniforms, e.g. { "strength": 0.6 } becomes `uniform float strength;`. */
  uniforms?: Record<string, number>;
}

/** An entity as written in a scene file. */
export interface EntityDef {
  id: string;
  /** Name of a prefab to start from. Gone after validation: its components are merged in. */
  prefab?: string;
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
  /** Lives before game over. Leave out for unlimited retries. */
  lives?: number;
  /**
   * "arcade" (default): axis-aligned boxes, tight and predictable, the classic platformer feel.
   * "rapier": a real physics engine (rotation, circles and capsules, friction, mass, stacking).
   */
  physics?: "arcade" | "rapier";
}

/** A reusable entity template: `prefabs/<name>.prefab.json` or the scene's `prefabs` map. */
export interface PrefabDef {
  description?: string;
  components: Record<string, Record<string, unknown>>;
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
  /**
   * Fonts that draw hooks can use in `ctx.g.font`: family name → "google" (loaded from
   * Google Fonts) or a font file in the project (.woff2, .woff, .ttf, .otf).
   */
  fonts?: Record<string, string>;
  /** A GLSL fragment shader applied to every rendered frame. Presentation only. */
  postfx?: PostFxDef;
  /**
   * The game's own sounds by name: synthesized from tone and noise layers, or an audio file.
   * Effects and scripts (`ctx.play`) use them like presets. See `ludra components sounds`.
   */
  sounds?: Record<string, SoundDef | string>;
  /** Music that loops while the scene plays: an audio file, or tracks of notes. */
  music?: string | MusicDef;
  /**
   * Entity templates by name. Entities use one with `"prefab": "<name>"` and override
   * components; scripts spawn them with `world.spawn({ prefab: "<name>" })`. The CLI
   * adds every `prefabs/*.prefab.json` file here.
   */
  prefabs?: Record<string, PrefabDef>;
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
