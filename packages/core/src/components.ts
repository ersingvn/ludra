export type FieldSpec =
  | { type: "number"; default?: number; min?: number; description: string }
  | { type: "string"; default?: string; description: string }
  | { type: "boolean"; default?: boolean; description: string }
  | { type: "enum"; values: readonly string[]; default?: string; description: string };

export interface ComponentSpec {
  description: string;
  requires?: readonly string[];
  /** Fields without a default are required. */
  fields: Record<string, FieldSpec>;
}

export const COMPONENT_NAMES = [
  "transform",
  "body",
  "sprite",
  "platformer",
  "collectible",
  "patrol",
  "hazard",
  "goal",
  "camera",
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * The single source of truth for components. Validation, defaults and
 * `ludra components` are all generated from this table, so adding a field
 * here documents it for agents automatically.
 */
export const COMPONENTS: Record<ComponentName, ComponentSpec> = {
  transform: {
    description: "Position of the entity's center in pixels. +x is right, +y is down.",
    fields: {
      x: { type: "number", description: "Center x in pixels." },
      y: { type: "number", description: "Center y in pixels." },
    },
  },
  body: {
    description:
      "Axis-aligned box collider. static = never moves (ground, walls). dynamic = falls with gravity and collides with static/kinematic bodies. kinematic = moves at a constant velocity, ignores gravity.",
    requires: ["transform"],
    fields: {
      type: { type: "enum", values: ["static", "dynamic", "kinematic"], default: "static", description: "How the body moves." },
      width: { type: "number", min: 1, description: "Collider width in pixels." },
      height: { type: "number", min: 1, description: "Collider height in pixels." },
      sensor: { type: "boolean", default: false, description: "Sensors detect overlaps but never block movement (coins, triggers)." },
      gravityScale: { type: "number", default: 1, description: "Multiplier on world gravity for dynamic bodies." },
      vx: { type: "number", default: 0, description: "Initial horizontal velocity in px/s." },
      vy: { type: "number", default: 0, description: "Initial vertical velocity in px/s." },
    },
  },
  sprite: {
    description: "How the entity is drawn. Size defaults to the body size.",
    requires: ["transform"],
    fields: {
      shape: { type: "enum", values: ["rect", "circle"], default: "rect", description: "Shape to draw." },
      color: { type: "string", default: "#ffffff", description: "Any CSS color." },
      width: { type: "number", min: 0, default: 0, description: "Draw width in pixels. 0 = use the body width." },
      height: { type: "number", min: 0, default: 0, description: "Draw height in pixels. 0 = use the body height." },
      layer: { type: "number", default: 0, description: "Higher layers are drawn on top." },
    },
  },
  platformer: {
    description: "Side-view player control: run with left/right, jump with jump. Needs a dynamic body.",
    requires: ["transform", "body"],
    fields: {
      speed: { type: "number", min: 0, default: 240, description: "Run speed in px/s." },
      jumpSpeed: { type: "number", min: 0, default: 680, description: "Upward launch speed in px/s. Jump height = jumpSpeed² / (2 · gravity)." },
      coyoteTime: { type: "number", min: 0, default: 0.1, description: "Seconds after leaving a ledge during which a jump still works." },
      jumpBuffer: { type: "number", min: 0, default: 0.1, description: "Seconds a jump press is remembered before landing." },
      variableJump: { type: "boolean", default: true, description: "Releasing jump early cuts the jump short." },
    },
  },
  collectible: {
    description: "Removed when a platformer entity touches it and adds to the score. Its body must be a sensor.",
    requires: ["transform", "body"],
    fields: {
      score: { type: "number", default: 1, description: "Points added when collected." },
    },
  },
  patrol: {
    description:
      "Moves a kinematic body back and forth between its start position and `distance` pixels along +axis. Use it for moving platforms (players standing on them are carried) and walking enemies.",
    requires: ["transform", "body"],
    fields: {
      axis: { type: "enum", values: ["x", "y"], default: "x", description: "x = right and back, y = down and back." },
      distance: { type: "number", min: 0, description: "Travel in pixels from the start position along +axis." },
      speed: { type: "number", min: 0, default: 80, description: "Speed in px/s." },
    },
  },
  hazard: {
    description:
      "Touching it kills a platformer, which respawns at its start position. Use for spikes, lava and enemies. Its body must be a sensor.",
    requires: ["transform", "body"],
    fields: {
      stompable: { type: "boolean", default: false, description: "Landing on it from above destroys it and bounces the player instead." },
      score: { type: "number", default: 0, description: "Points added when stomped." },
    },
  },
  goal: {
    description: "Touching it completes the level: the `won` flag is set and the simulation stops. Its body must be a sensor.",
    requires: ["transform", "body"],
    fields: {
      requireScore: { type: "number", min: 0, default: 0, description: "Score needed before the goal accepts the player." },
    },
  },
  camera: {
    description: "The browser camera follows this entity. Without it, the camera follows the first platformer.",
    requires: ["transform"],
    fields: {
      zoom: { type: "number", min: 0.1, default: 1, description: "Camera zoom factor." },
    },
  },
};

export interface Transform {
  x: number;
  y: number;
}

export interface Body {
  type: "static" | "dynamic" | "kinematic";
  width: number;
  height: number;
  sensor: boolean;
  gravityScale: number;
  vx: number;
  vy: number;
}

export interface Sprite {
  shape: "rect" | "circle";
  color: string;
  width: number;
  height: number;
  layer: number;
}

export interface Platformer {
  speed: number;
  jumpSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  variableJump: boolean;
}

export interface Collectible {
  score: number;
}

export interface Patrol {
  axis: "x" | "y";
  distance: number;
  speed: number;
}

export interface Hazard {
  stompable: boolean;
  score: number;
}

export interface Goal {
  requireScore: number;
}

export interface Camera {
  zoom: number;
}

export function isComponentName(name: string): name is ComponentName {
  return (COMPONENT_NAMES as readonly string[]).includes(name);
}

/** Fills in defaults for a component that has already passed validation. */
export function resolveComponent<T>(name: ComponentName, raw: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(COMPONENTS[name].fields)) {
    out[field] = raw[field] ?? spec.default;
  }
  return out as T;
}
