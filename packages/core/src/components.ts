export type FieldSpec =
  | { type: "number"; default?: number; min?: number; description: string }
  | { type: "string"; default?: string; description: string }
  | { type: "boolean"; default?: boolean; description: string }
  | { type: "enum"; values: readonly string[]; default?: string; description: string }
  /** Spritesheet frame indices: "0", "1-4" or "0,2,4-6". Empty = not used. */
  | { type: "frames"; default?: string; description: string }
  /** Any JSON object. */
  | { type: "object"; default?: Record<string, unknown>; description: string };

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
  "topdown",
  "collectible",
  "patrol",
  "hazard",
  "goal",
  "checkpoint",
  "joint",
  "emitter",
  "script",
  "camera",
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/** Shared by the `emitter` component and the particles of scene `effects`. Purely visual. */
export const PARTICLE_FIELDS: Record<string, FieldSpec> = {
  count: { type: "number", min: 1, default: 10, description: "Particles per burst (effects only)." },
  color: { type: "string", default: "#ffffff", description: "Any CSS color." },
  speed: { type: "number", min: 0, default: 120, description: "Launch speed in px/s." },
  direction: { type: "number", default: -90, description: "Launch angle in degrees. 0 = right, -90 = up, 90 = down." },
  spread: { type: "number", min: 0, default: 360, description: "Random spread around direction, in degrees. 360 = all directions." },
  life: { type: "number", min: 0, default: 0.5, description: "Seconds each particle lives; it shrinks and fades over that time." },
  size: { type: "number", min: 0, default: 3, description: "Starting size in pixels." },
  gravity: { type: "number", default: 400, description: "Downward acceleration in px/s². Negative values float up." },
};

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
      rotation: { type: "number", default: 0, description: "Rotation in degrees, clockwise. Rapier physics only: arcade bodies never rotate." },
    },
  },
  body: {
    description:
      "Collider. static = never moves (ground, walls). dynamic = falls with gravity and collides with other bodies. kinematic = moves at a constant velocity, ignores gravity. With arcade physics (the default) every body is an axis-aligned box; with \"physics\": \"rapier\" bodies can be circles or capsules, rotate, and have friction and mass.",
    requires: ["transform"],
    fields: {
      type: { type: "enum", values: ["static", "dynamic", "kinematic"], default: "static", description: "How the body moves." },
      width: { type: "number", min: 1, description: "Collider width in pixels." },
      height: { type: "number", min: 1, description: "Collider height in pixels." },
      sensor: { type: "boolean", default: false, description: "Sensors detect overlaps but never block movement (coins, triggers)." },
      gravityScale: { type: "number", default: 1, description: "Multiplier on world gravity for dynamic bodies." },
      bounce: {
        type: "number",
        min: 0,
        default: 0,
        description: "How much speed a dynamic body keeps when it hits a solid: 0 stops it, 1 bounces it back at full speed (balls, pinballs).",
      },
      vx: { type: "number", default: 0, description: "Initial horizontal velocity in px/s." },
      vy: { type: "number", default: 0, description: "Initial vertical velocity in px/s." },
      shape: {
        type: "enum",
        values: ["box", "circle", "capsule"],
        default: "box",
        description: "Rapier only. circle: diameter = width. capsule: a rounded box, upright when taller than wide (characters).",
      },
      friction: { type: "number", min: 0, default: 0.5, description: "Rapier only. 0 = ice, 1 = rubber." },
      density: { type: "number", min: 0, default: 1, description: "Rapier only. Mass per area: heavier bodies push lighter ones." },
      fixedRotation: { type: "boolean", default: false, description: "Rapier only. Keeps a dynamic body upright (crates that slide but never tip). Players are always upright." },
      bullet: { type: "boolean", default: false, description: "Rapier only. Continuous collision detection, so fast bodies (bullets, balls) can't pass through thin walls." },
    },
  },
  sprite: {
    description:
      "How the entity is drawn: a colored shape, or an image (SVG, PNG...) path relative to the project. An image can be a horizontal spritesheet with animations; platformers pick idle/run/jump/fall automatically, everything else plays run while moving and idle otherwise. Size defaults to the body size.",
    requires: ["transform"],
    fields: {
      shape: { type: "enum", values: ["rect", "circle"], default: "rect", description: "Shape to draw when there is no image." },
      color: { type: "string", default: "#ffffff", description: "Any CSS color. Used when there is no image." },
      image: { type: "string", default: "", description: 'Image path relative to the project, e.g. "assets/player.svg".' },
      frameWidth: { type: "number", min: 0, default: 0, description: "Width of one spritesheet frame in image pixels. 0 = the whole image is one frame." },
      frameHeight: { type: "number", min: 0, default: 0, description: "Height of one frame in image pixels. 0 = the image height." },
      idle: { type: "frames", default: "0", description: 'Frames to loop when standing still, e.g. "0" or "0-1".' },
      run: { type: "frames", default: "", description: 'Frames to loop while moving, e.g. "2-5". Empty = use idle.' },
      jump: { type: "frames", default: "", description: "Frames while moving up in the air. Empty = use idle." },
      fall: { type: "frames", default: "", description: "Frames while falling. Empty = use jump." },
      fps: { type: "number", min: 0, default: 8, description: "Animation speed in frames per second." },
      flip: { type: "boolean", default: true, description: "Mirror the image while moving left. Draw images facing right." },
      tile: { type: "boolean", default: false, description: "Repeat the image to fill the sprite instead of stretching it (ground, walls, spikes)." },
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
      maxSlope: { type: "number", min: 0, default: 50, description: "Rapier only. Steepest slope in degrees the player can walk up; steeper ones slide it back down." },
      stepHeight: { type: "number", min: 0, default: 10, description: "Rapier only. Ledges up to this many px are stepped onto without jumping (stairs, bumps). 0 turns it off." },
      push: { type: "number", min: 0, default: 1, description: "Rapier only. How hard the player pushes dynamic bodies, as a multiple of its own mass. 0 = can't push." },
    },
  },
  topdown: {
    description:
      "Player control seen from above or for vehicles: moves with the arrow keys, no gravity. directions picks 8-way, 4-way, or one axis (\"x\" for a breakout paddle or a shooter ship). Needs a dynamic body (collides with walls) or a kinematic one (passes through, use clampToWorld).",
    requires: ["transform", "body"],
    fields: {
      speed: { type: "number", min: 0, default: 200, description: "Move speed in px/s." },
      directions: {
        type: "enum",
        values: ["8", "4", "x", "y"],
        default: "8",
        description: '"8": any direction (diagonals keep the same speed). "4": up/down/left/right only. "x" or "y": one axis.',
      },
      clampToWorld: { type: "boolean", default: true, description: "Keep the entity inside the world bounds." },
    },
  },
  collectible: {
    description: "Removed when a player (platformer or topdown) touches it and adds to the score. Its body must be a sensor.",
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
      next: {
        type: "string",
        default: "",
        description: 'Scene to play after this one is won, e.g. "scenes/level-2.scene.json". The browser moves on and keeps score, deaths and lives; each scene is tested on its own.',
      },
    },
  },
  joint: {
    description:
      'Rapier only. Connects this body to another (`to`) or to a point in the world: a hinge (revolute), a slider (prismatic), a weld (fixed), a rope or a spring. Chains, bridges, pendulums, wheels, doors, cranes. Positions are offsets from each body\'s center in px.',
    requires: ["transform", "body"],
    fields: {
      type: { type: "enum", values: ["revolute", "prismatic", "fixed", "rope", "spring"], default: "revolute", description: "revolute = hinge, prismatic = slides along axis, fixed = welded, rope = at most length apart, spring = pulled toward length." },
      to: { type: "string", default: "", description: "Id of the other body. Empty: a fixed point in the world." },
      anchor: {
        type: "object",
        default: { x: 0, y: 0 },
        description: "Where the joint sits on this body: { x, y } offset from its center. A hinge, slider or weld joins the other body (or the world) right at that point: a pendulum hinged 200 px to its left is { \"x\": -200, \"y\": 0 }.",
      },
      toAnchor: {
        type: "object",
        default: { x: 0, y: 0 },
        description: "rope and spring: where the other end is, as an offset from the other body's center, or with no `to` from this body's starting center (a rope hanging from 100 px above is { \"x\": 0, \"y\": -100 }).",
      },
      length: { type: "number", min: 0, default: 0, description: "rope: longest it stretches; spring: length it pulls toward. 0 = the distance at the start." },
      stiffness: { type: "number", min: 0, default: 1000, description: "spring: how hard it pulls." },
      damping: { type: "number", min: 0, default: 20, description: "spring: how quickly it stops bouncing." },
      axis: { type: "number", default: 0, description: "prismatic: the direction it slides, in degrees clockwise from right." },
      min: { type: "number", default: 0, description: "Limit: revolute angle in degrees, prismatic position in px. Used when min < max." },
      max: { type: "number", default: 0, description: "Upper limit (see min)." },
      motorSpeed: { type: "number", default: 0, description: "revolute: degrees per second clockwise; prismatic: px per second. Needs motorForce." },
      motorForce: { type: "number", min: 0, default: 0, description: "How strong the motor is. 0 = no motor." },
      collide: { type: "boolean", default: false, description: "Whether the two connected bodies still collide with each other." },
    },
  },
  checkpoint: {
    description:
      "When a player touches it, that player respawns here after dying (standing on the checkpoint's bottom edge). Fires a checkpoint event once. Its body must be a sensor.",
    requires: ["transform", "body"],
    fields: {},
  },
  emitter: {
    description: "Continuously emits visual particles from the entity (torches, sparkles, smoke). It does not affect gameplay.",
    requires: ["transform"],
    fields: {
      rate: { type: "number", min: 0, default: 10, description: "Particles per second." },
      ...Object.fromEntries(Object.entries(PARTICLE_FIELDS).filter(([field]) => field !== "count")),
    },
  },
  script: {
    description:
      "Custom behavior written in TypeScript or JavaScript: a file that default-exports hooks (start, update, touch). Use it for anything the built-in components don't do: chasing, doors and keys, timers, shooting, boss phases. Run `ludra components script` for the API.",
    requires: ["transform"],
    fields: {
      src: { type: "string", description: 'Script path relative to the project, e.g. "scripts/chase.ts".' },
      params: { type: "object", default: {}, description: "Values passed to the script as ctx.params, so one script can serve many entities." },
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
  /** Degrees, clockwise. Only rapier physics rotates bodies. */
  rotation: number;
}

export interface Body {
  type: "static" | "dynamic" | "kinematic";
  width: number;
  height: number;
  sensor: boolean;
  gravityScale: number;
  bounce: number;
  vx: number;
  vy: number;
  shape: "box" | "circle" | "capsule";
  friction: number;
  density: number;
  fixedRotation: boolean;
  bullet: boolean;
}

export interface Sprite {
  shape: "rect" | "circle";
  color: string;
  image: string;
  frameWidth: number;
  frameHeight: number;
  idle: string;
  run: string;
  jump: string;
  fall: string;
  fps: number;
  flip: boolean;
  tile: boolean;
  width: number;
  height: number;
  layer: number;
}

export interface ParticleSpec {
  count: number;
  color: string;
  speed: number;
  direction: number;
  spread: number;
  life: number;
  size: number;
  gravity: number;
}

export interface Emitter extends Omit<ParticleSpec, "count"> {
  rate: number;
}

export interface ScriptComponent {
  src: string;
  params: Record<string, unknown>;
}

export interface Platformer {
  speed: number;
  jumpSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  variableJump: boolean;
  maxSlope: number;
  stepHeight: number;
  push: number;
}

export interface Topdown {
  speed: number;
  directions: "8" | "4" | "x" | "y";
  clampToWorld: boolean;
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

export interface Joint {
  type: "revolute" | "prismatic" | "fixed" | "rope" | "spring";
  to: string;
  anchor: { x: number; y: number };
  toAnchor: { x: number; y: number };
  length: number;
  stiffness: number;
  damping: number;
  axis: number;
  min: number;
  max: number;
  motorSpeed: number;
  motorForce: number;
  collide: boolean;
}

export interface Goal {
  requireScore: number;
  next: string;
}

export interface Camera {
  zoom: number;
}

export function isComponentName(name: string): name is ComponentName {
  return (COMPONENT_NAMES as readonly string[]).includes(name);
}

/** Fills in defaults for a component that has already passed validation. */
export function resolveComponent<T>(name: ComponentName, raw: Record<string, unknown>): T {
  return resolveFields<T>(COMPONENTS[name].fields, raw);
}

export function resolveFields<T>(fields: Record<string, FieldSpec>, raw: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(fields)) {
    out[field] = raw[field] ?? spec.default;
  }
  return out as T;
}

const FRAMES_PATTERN = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

export function isFrameList(text: string): boolean {
  return text === "" || FRAMES_PATTERN.test(text.replaceAll(" ", ""));
}

/** Expands "0,2-4" to [0, 2, 3, 4]. Assumes `isFrameList(text)`. */
export function parseFrames(text: string): number[] {
  if (text.trim() === "") return [];
  return text
    .replaceAll(" ", "")
    .split(",")
    .flatMap((part) => {
      const [start = 0, end = start] = part.split("-").map(Number);
      const step = end >= start ? 1 : -1;
      return Array.from({ length: Math.abs(end - start) + 1 }, (_, i) => start + i * step);
    });
}
