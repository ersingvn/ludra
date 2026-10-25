import { ScriptError, type ScriptModules } from "./script.ts";
import type { Diagnostic, SceneDef } from "./types.ts";
import { World } from "./world.ts";

/** Simulation frames at which `checkDrawHooks` paints: the start, and after things have moved. */
const CHECK_FRAMES = [0, 30, 120];

/**
 * A stand-in for CanvasRenderingContext2D (and AudioContext) that accepts every call and property,
 * so draw and sound hooks can run outside a browser. It catches the hook's own mistakes
 * (typos, undefined values, changing the game while drawing), not what it looks like.
 */
function mockCanvas(): CanvasRenderingContext2D {
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : any),
    set: () => true,
    apply: () => any,
  };
  const any: unknown = new Proxy(() => undefined, handler);
  return any as CanvasRenderingContext2D;
}

/**
 * Runs every `draw`, `drawUI` and `sound` hook against a mock canvas or audio context at a few points of
 * an idle run, and reports hooks that throw. Used by `ludra check`.
 */
export function checkDrawHooks(scene: SceneDef, scripts: ScriptModules): Diagnostic[] {
  let world: World;
  try {
    world = new World(scene, { scripts });
  } catch {
    return []; // Load problems are reported elsewhere.
  }
  const reported = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const g = mockCanvas();
  const view = { width: world.width, height: world.height, cameraX: 0, cameraY: 0, zoom: 1 };
  const locals = new Map<string, Record<string, unknown>>();

  for (let frame = 0; frame <= CHECK_FRAMES.at(-1)!; frame++) {
    if (CHECK_FRAMES.includes(frame)) {
      for (const e of [...world.entities]) {
        for (const hook of ["draw", "drawUI", "sound"] as const) {
          if (!e.script?.module[hook]) continue;
          const key = `${e.id}:${hook === "sound" ? "sound" : "draw"}`;
          if (!locals.has(key)) locals.set(key, {});
          try {
            if (hook === "sound") {
              world.callSoundHook(e, { audio: g as unknown as AudioContext, out: g as unknown as AudioNode, time: world.time, events: [], play: () => {}, local: locals.get(key)!, random: () => 0.5 });
              continue;
            }
            world.callDrawHook(e, hook, {
              g,
              time: world.time,
              local: locals.get(key)!,
              view,
              recent: () => [],
              image: () => undefined,
              burst: () => {},
              shake: () => {},
              random: () => 0.5,
            });
          } catch (err) {
            const key = `${e.script.src}:${hook}`;
            if (reported.has(key)) continue;
            reported.add(key);
            diagnostics.push({
              severity: "error",
              code: hook === "sound" ? "E_SOUND_HOOK" : "E_DRAW_HOOK",
              path: `${e.script.src} → ${hook}`,
              message: err instanceof ScriptError ? err.message : String(err),
              fix:
                hook === "sound"
                  ? "Sound hooks run every rendered frame in the browser, with the real Web Audio API. Fix the error; keep nodes you create in ctx.local."
                  : "Draw hooks run every rendered frame in the browser. Fix the error; ctx.image() can return undefined, so check it before drawing.",
            });
          }
        }
      }
    }
    try {
      world.step(new Set());
    } catch {
      break; // Simulation errors surface in play and test.
    }
  }
  return diagnostics;
}
