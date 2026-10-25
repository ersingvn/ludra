import type { Action, Diagnostic } from "./types.ts";
import type { Ease } from "./tween.ts";
import { closestName } from "./validate.ts";

/**
 * A game object as scripts see it. Reading and writing `x`, `y`, `vx` and
 * `vy` changes the entity directly.
 */
export interface ScriptEntity {
  readonly id: string;
  x: number;
  y: number;
  /** Velocity in px/s. Always 0 for entities without a body. */
  vx: number;
  vy: number;
  readonly grounded: boolean;
  /** Degrees, clockwise. Only rapier physics turns bodies by itself; setting it turns one. */
  rotation: number;
  /** Spin in degrees per second, clockwise. Always 0 under arcade physics. */
  angularVelocity: number;
  /** Density × area. Heavier bodies move less when struck and push lighter ones. */
  readonly mass: number;
  /**
   * Strikes the body: its velocity changes by (x, y) / mass. Applied `at` a point in the
   * world (rapier) it also spins the body. For a jump pad, a kick, an explosion.
   */
  applyImpulse(x: number, y: number, at?: { x: number; y: number }): void;
  /**
   * Eases a value over time: { property: "x" | "y" | "rotation" | "scale" | "opacity", to or by,
   * duration, ease?, delay?, repeat? }. Same fields as the tween component; starts now and
   * replaces a running tween of the same property. A door: self.tween({ property: "y", by: -120, duration: 0.6, ease: "quadOut" }).
   */
  tween(def: { property: "x" | "y" | "rotation" | "scale" | "opacity"; to?: number; by?: number; duration: number; delay?: number; ease?: Ease; repeat?: "once" | "loop" | "pingpong" }): void;
  /** Pushes the body steadily: call it every frame (thrusters, wind, magnets). */
  applyForce(x: number, y: number, at?: { x: number; y: number }): void;
  readonly width: number;
  readonly height: number;
  /** False once the entity has been destroyed or collected. */
  readonly exists: boolean;
  /**
   * Data kept between frames. Use JSON values only. Tests can read it as
   * `<id>.state.<key>`, for example `"door.state.open == true"`.
   */
  readonly state: Record<string, unknown>;
  has(component: string): boolean;
  /** True when this entity overlaps or touches the other one. */
  touches(other: ScriptEntity | string): boolean;
}

/** Where a ray first hits a body. */
export interface ScriptRayHit {
  entity: ScriptEntity;
  x: number;
  y: number;
  distance: number;
  /** The surface's outward normal (unit length, +y down). */
  normal: { x: number; y: number };
}

export interface SpawnDef {
  /** Generated when left out. */
  id?: string;
  /** Start from a prefab; `components` then only needs what differs (usually the transform). */
  prefab?: string;
  components?: Record<string, Record<string, unknown>>;
}

export interface ScriptWorld {
  readonly time: number;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  score: number;
  /** Times a player has died so far. */
  readonly deaths: number;
  /** True once the level is complete. */
  readonly won: boolean;
  /** Lives left, or undefined when the scene has unlimited retries. Writable: an extra life is `world.lives += 1`. */
  lives: number | undefined;
  /** True once the game is over (out of lives, or world.lose()). */
  readonly lost: boolean;
  /** The scene this one hands over to (a won goal's next, or world.goto), once it does. */
  readonly exit: string | undefined;
  get(id: string): ScriptEntity | undefined;
  /** Every entity, or only those with the given component. */
  all(component?: string): ScriptEntity[];
  /** The first entity with a `platformer` component. */
  player(): ScriptEntity | undefined;
  spawn(def: SpawnDef): ScriptEntity;
  destroy(entity: ScriptEntity | string): void;
  /** Players die and respawn; anything else is destroyed. */
  kill(entity: ScriptEntity | string): void;
  /** Completes the level, like reaching a goal. */
  win(): void;
  /** Ends the game as lost (a time limit ran out, the base was destroyed...). Fires "gameover". */
  lose(): void;
  /**
   * Moves on to another scene, e.g. world.goto("scenes/level-1.scene.json") from a title
   * screen. The current scene stops; the browser loads the next one, keeping score,
   * deaths and lives. Fires "goto" (tests can assert events.goto).
   */
  goto(scene: string): void;
  /** Fires a custom event that tests can count (`events.<name>`) and `effects` can react to. */
  emit(name: string, data?: unknown): void;
  /** A number in [0, 1). Seeded by `world.seed`, so runs stay deterministic. Never use Math.random. */
  random(): number;
  /**
   * The first body on the line from `from` to `to`: line of sight, lasers, "is there
   * ground ahead?". Sensors are skipped unless `sensors` is true.
   */
  raycast(
    from: { x: number; y: number },
    to: { x: number; y: number },
    options?: { ignore?: ScriptEntity | string | (ScriptEntity | string)[]; sensors?: boolean },
  ): ScriptRayHit | undefined;
  /**
   * The physics engine. Under rapier, `raw` is { RAPIER, world, body(entity), collider(entity),
   * joint(entity, index?), toRapier(point), fromRapier(point) }: the whole Rapier API, for anything Ludra's components
   * don't cover. Rapier runs y-up, so convert points with toRapier/fromRapier.
   */
  readonly physics: { readonly name: string; readonly raw: unknown };
}

export interface ScriptInput {
  /** True while the action is held. */
  held(action: Action): boolean;
  /** True only on the frame the action is pressed. */
  pressed(action: Action): boolean;
}

export interface ScriptContext {
  self: ScriptEntity;
  world: ScriptWorld;
  input: ScriptInput;
  /** The `params` object from the entity's `script` component. */
  params: Record<string, unknown>;
  /** Seconds per frame (1/60). */
  dt: number;
}

/** A game event as draw hooks see it. Custom events carry the name passed to world.emit. */
export interface DrawEvent {
  /** Built-in type ("collect", "die", "bounce"...) or the custom event's name. */
  name: string;
  time: number;
  x: number;
  y: number;
  /** The entity that caused it. */
  entity: string;
  /** Custom events: what the script passed to world.emit. Built-in ones: their details, e.g. { checkpoint: "lantern" } or { item: "coin-1", score: 1 }. */
  data?: unknown;
}

/**
 * What `draw` and `drawUI` receive. `g` is the real Canvas 2D context, so
 * anything the canvas can do is allowed: gradients, glow (shadowBlur), blend
 * modes (globalCompositeOperation), paths, text, filters, images.
 *
 * Draw hooks only paint. `self` and `world` are read-only here (changing the
 * game must happen in `update` so tests see it); keep animation memory in `local`.
 */
export interface DrawContext {
  g: CanvasRenderingContext2D;
  self: ScriptEntity;
  world: ScriptWorld;
  params: Record<string, unknown>;
  /** Simulation time in seconds. Animate with it so screenshots stay reproducible. */
  time: number;
  /** Per-entity memory for presentation (trails, tweens). Not part of the game state and not testable. */
  local: Record<string, unknown>;
  /** Visible area: canvas size, camera position (world px at the top-left) and zoom. */
  view: { width: number; height: number; cameraX: number; cameraY: number; zoom: number };
  /** Events that happened in the last `seconds` (default 0.5), optionally only those named `name`. Newest last. */
  recent(name?: string, seconds?: number): DrawEvent[];
  /** An image from the project, e.g. "assets/glow.png". Images in sprites or in string script params are preloaded. */
  image(path: string): HTMLImageElement | undefined;
  /** A particle burst through the engine's particle system (same fields as effects particles). */
  burst(x: number, y: number, particles?: Record<string, unknown>): void;
  /** Shakes the screen by `amount` px (decays on its own). */
  shake(amount: number): void;
  /** A number in [0, 1) for visual variety. Seeded, independent of world.random, so it never affects the game. */
  random(): number;
}

/**
 * What the `sound` hook receives: the real Web Audio API, so there are no limits on
 * sound. Like draw hooks, it only presents: `self` and `world` are read-only.
 */
export interface SoundContext {
  /** The real AudioContext: oscillators, filters, convolvers, buffers, `audio.currentTime`. */
  audio: AudioContext;
  /** Connect nodes here: the scene's bus. Muting and scene changes are handled for you. */
  out: AudioNode;
  self: ScriptEntity;
  world: ScriptWorld;
  params: Record<string, unknown>;
  /** Simulation time in seconds. */
  time: number;
  /** Game events since this hook last ran, oldest first. */
  events: DrawEvent[];
  /** Plays a preset, one of the scene's own "sounds" or an audio file. `pitch` 2 is an octave up. */
  play(name: string, options?: { volume?: number; pitch?: number }): void;
  /** Per-entity memory for nodes and timers. Not game state. */
  local: Record<string, unknown>;
  /** A number in [0, 1) for variety. Never affects the game. */
  random(): number;
}

/**
 * The default export of a script file. All hooks are optional.
 *
 * ```ts
 * import type { Script } from "@ludra/core";
 * export default {
 *   update({ self, world, params }) { ... },
 * } satisfies Script;
 * ```
 */
export interface Script {
  /** Runs once, on the entity's first frame. */
  start?(ctx: ScriptContext): void;
  /** Runs every frame, after player input and before physics. */
  update?(ctx: ScriptContext): void;
  /** Runs when this entity starts touching another one (after physics). */
  touch?(ctx: ScriptContext, other: ScriptEntity): void;
  /**
   * Paints this entity in world space, every rendered frame, right after its sprite
   * (or instead of one: an entity without a sprite is drawn only by this hook).
   * Order follows `sprite.layer` (0 without a sprite). Browser only; tests never call it.
   */
  draw?(ctx: DrawContext): void;
  /**
   * Paints in screen space, above the world. If any script has `drawUI`, the engine's
   * default HUD and "Level complete" screen are turned off: the game draws its own.
   */
  drawUI?(ctx: DrawContext): void;
  /**
   * Makes sound with the real Web Audio API, every rendered frame in the browser once the
   * player has pressed a key (browsers block audio before that). Tests never call it.
   */
  sound?(ctx: SoundContext): void;
}

export const SCRIPT_HOOKS = ["start", "update", "touch", "draw", "drawUI", "sound"] as const;

/** Printed by `ludra components script`. Keep in sync with the interfaces above. */
export const SCRIPT_API_REFERENCE = `A script file default-exports hooks. Only "import type" is allowed: scripts run without a bundler.

  import type { Script } from "@ludra/core";
  export default {
    start(ctx) {},           // once, on the entity's first frame
    update(ctx) {},          // every frame, after player input, before physics
    touch(ctx, other) {},    // when this entity starts touching another body (after physics)
    draw(ctx) {},            // paint this entity in world space (browser only, every rendered frame)
    drawUI(ctx) {},          // paint screen-space UI; replaces the default HUD and win screen
    sound(ctx) {},           // make sound with the real Web Audio API (browser only, every rendered frame)
  } satisfies Script;

ctx.self      the entity: id, x, y, vx, vy, rotation, angularVelocity (read/write); grounded, mass, width, height, exists (read);
              applyImpulse(x, y, at?)  strike it (velocity += impulse / mass)    applyForce(x, y, at?)  push every frame;
              tween({ property, to | by, duration, ease?, delay?, repeat? })  ease x, y, rotation, scale or opacity;
              state (object kept between frames, testable as "<id>.state.<key>");
              has("component"), touches(otherOrId)
ctx.world     time, frame, width, height, deaths, won, lost, exit (read); score, lives (read/write)
              get(id), all(component?), player()
              spawn({ id?, prefab?, components? }) -> entity    destroy(entityOrId)
              kill(entityOrId)  players respawn, others are destroyed
              win()             completes the level        lose()   game over
              goto(scenePath)   moves on to another scene (title -> level 1, a door to the next room)
              emit(name, data?) custom event: counted by "events.<name>" in tests, usable as an effects key
              random()          deterministic, seeded by world.seed. Never use Math.random or Date
              raycast(from, to, { ignore?, sensors? }) -> { entity, x, y, distance, normal } | undefined
              physics.name      "arcade" or "rapier"
              physics.raw       rapier only: { RAPIER, world, body(e), collider(e), toRapier(p), fromRapier(p) }:
                                the whole Rapier API (Rapier is y-up: convert points). Not in draw hooks.
ctx.input     held(action), pressed(action)   actions: left right up down jump action
ctx.params    the "params" object from the script component
ctx.dt        seconds per frame (1/60)

Drawing: draw and drawUI get the real Canvas 2D context, so there are no limits on looks.
ctx.g         CanvasRenderingContext2D: gradients, shadowBlur glow, globalCompositeOperation ("lighter" for
              additive light), paths, text with any loaded font, ctx.g.filter, drawImage...
              draw: origin is the world (use self.x/self.y); drawUI: origin is the screen top-left
ctx.time      simulation seconds; animate with it so screenshots are reproducible
ctx.local     per-entity presentation memory (trails, tweens); not game state
ctx.view      width, height, cameraX, cameraY, zoom
ctx.recent(name?, seconds = 0.5)   recent events [{ name, time, x, y, entity, data }]: flash on hit, pop scores
ctx.image(path)   a loaded image (sprite images and string params ending in .svg/.png/... are preloaded)
ctx.burst(x, y, particles?)  ctx.shake(px)  ctx.random()   presentation-only helpers
self/world/params as in update, but read-only: changing the game in a draw hook is an error.

Sound: the sound hook gets the real Web Audio API, so there are no limits on sound either.
ctx.audio     the AudioContext (createOscillator, createBiquadFilter, createConvolver, currentTime...)
ctx.out       connect your nodes here (the scene's bus; mute and scene changes are handled)
ctx.events    game events since the last call: answer them with sound
ctx.play(name, { volume?, pitch? })   a preset, one of the scene's "sounds", or an audio file
ctx.local, ctx.time, ctx.random(), self/world/params read-only, as in draw hooks
Run "ludra components sounds" for scene "sounds" (your own synthesized sounds) and "music" (tracks of notes).

Scene-level presentation (all optional):
  "fonts": { "Orbitron": "google", "Pixel": "assets/pixel.woff2" }   load fonts for ctx.g.font
  "postfx": { "shader": "shaders/crt.frag", "uniforms": { "strength": 0.6 } }
     a GLSL ES 1.0 fragment shader over the whole frame. It gets: uniform sampler2D u_image;
     uniform vec2 u_resolution; uniform float u_time; varying vec2 v_uv; plus each uniform as a float.

Scripts in scripts/ are loaded even if no entity uses them, so world.spawn can attach them.
Errors name the file, entity, hook and frame.`;

export type ScriptModules = ReadonlyMap<string, Script> | Readonly<Record<string, Script>>;

export function getScript(modules: ScriptModules | undefined, src: string): Script | undefined {
  if (!modules) return undefined;
  return modules instanceof Map ? modules.get(src) : (modules as Record<string, Script>)[src];
}

/** A script threw, or was used wrongly. Names the file, entity, hook and frame. */
export class ScriptError extends Error {
  readonly src: string;
  readonly entity: string;
  readonly hook: string;
  readonly frame: number;

  constructor(details: { src: string; entity: string; hook: string; frame: number }, message: string, options?: ErrorOptions) {
    super(`${details.src} (${details.hook} on entity "${details.entity}", frame ${details.frame}): ${message}`, options);
    this.src = details.src;
    this.entity = details.entity;
    this.hook = details.hook;
    this.frame = details.frame;
  }
}

/** Checks that a loaded module looks like a script. */
export function validateScriptModule(module: unknown, src: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const script = (module as { default?: unknown } | null)?.default;
  if (typeof script !== "object" || script === null) {
    diagnostics.push({
      severity: "error",
      code: "E_SCRIPT_NO_DEFAULT_EXPORT",
      path: src,
      message: `${src} must default-export an object with script hooks.`,
      fix: "Use: export default { update({ self, world }) { ... } } satisfies Script;",
    });
    return diagnostics;
  }
  for (const [key, value] of Object.entries(script)) {
    if (!(SCRIPT_HOOKS as readonly string[]).includes(key)) {
      const suggestion = closestName(key, SCRIPT_HOOKS);
      diagnostics.push({
        severity: "warning",
        code: "W_SCRIPT_UNKNOWN_HOOK",
        path: `${src} → ${key}`,
        message: `"${key}" is not a script hook, so it is never called.`,
        fix: `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Hooks are ${SCRIPT_HOOKS.join(", ")}. Put helpers outside the exported object.`,
      });
    } else if (typeof value !== "function") {
      diagnostics.push({ severity: "error", code: "E_SCRIPT_HOOK_NOT_FUNCTION", path: `${src} → ${key}`, message: `"${key}" must be a function.` });
    }
  }
  return diagnostics;
}

/** Scripts run in the engine without a bundler, so they cannot import runtime code. */
export function findRuntimeImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?!type\b)([^;\n]*?)\s+from\s+["']([^"']+)["']/gm)) imports.push(match[2]!);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) imports.push(match[1]!);
  return imports;
}
