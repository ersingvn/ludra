import type { Action, Diagnostic } from "./types.ts";
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

export interface SpawnDef {
  /** Generated when left out. */
  id?: string;
  components: Record<string, Record<string, unknown>>;
}

export interface ScriptWorld {
  readonly time: number;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  score: number;
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
  /** Fires a custom event that tests can count (`events.<name>`) and `effects` can react to. */
  emit(name: string, data?: unknown): void;
  /** A number in [0, 1). Seeded by `world.seed`, so runs stay deterministic. Never use Math.random. */
  random(): number;
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
}

export const SCRIPT_HOOKS = ["start", "update", "touch"] as const;

/** Printed by `ludra components script`. Keep in sync with the interfaces above. */
export const SCRIPT_API_REFERENCE = `A script file default-exports hooks. Only "import type" is allowed: scripts run without a bundler.

  import type { Script } from "@ludra/core";
  export default {
    start(ctx) {},           // once, on the entity's first frame
    update(ctx) {},          // every frame, after player input, before physics
    touch(ctx, other) {},    // when this entity starts touching another body (after physics)
  } satisfies Script;

ctx.self      the entity: id, x, y, vx, vy (read/write); grounded, width, height, exists (read);
              state (object kept between frames, testable as "<id>.state.<key>");
              has("component"), touches(otherOrId)
ctx.world     time, frame, width, height, score (read/write)
              get(id), all(component?), player()
              spawn({ id?, components }) -> entity    destroy(entityOrId)
              kill(entityOrId)  players respawn, others are destroyed
              win()             completes the level
              emit(name, data?) custom event: counted by "events.<name>" in tests, usable as an effects key
              random()          deterministic, seeded by world.seed. Never use Math.random or Date
ctx.input     held(action), pressed(action)   actions: left right up down jump action
ctx.params    the "params" object from the script component
ctx.dt        seconds per frame (1/60)

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
