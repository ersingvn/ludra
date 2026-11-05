import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { collectAssetPaths, InputScript, parseDuration, secondsToFrames, World, type SceneDef, type Script, type TestCase } from "@ludra/core";
import { megabytes, packGame } from "./commands/build.ts";
import { imageSize } from "./commands/inspect.ts";
import { readModel } from "./gltf.ts";
import type { Project } from "./project.ts";

/**
 * Budgets for a game that ships to phones as well as desktops. Everything that can make
 * `review --strict` fail is counted, not timed, so a busy machine reviews a game the same as an
 * idle one; how long a step takes is only ever an idea.
 */
export const BUDGETS = {
  /** The zip players download: a page this big takes a while on a phone's connection. */
  zipIdea: 10 * 1024 * 1024,
  zipIssue: 50 * 1024 * 1024,
  /** Many phones' WebGL can't hold a texture wider or taller than this. */
  imageSide: 4096,
  /** One file this big is usually audio that hasn't been compressed. */
  assetBytes: 8 * 1024 * 1024,
  /** Triangles drawn by a 3D scene's models, counted once per entity that shows one. */
  trianglesIdea: 1_000_000,
  trianglesIssue: 4_000_000,
  /** Entities alive at once. */
  entitiesIdea: 2000,
  entitiesIssue: 6000,
  /**
   * Milliseconds a simulation step takes here, on average. A frame has 16.7 ms for stepping and
   * drawing, and a phone is several times slower than the machine an agent works on.
   */
  stepMs: 3,
} as const;

export interface ShippingScene {
  label: string;
  scene: SceneDef;
  scripts: Map<string, Script>;
  /** Its tests, whose inputs make runs to measure. */
  cases: TestCase[];
}

type Add = (level: "issue" | "idea", area: "shipping", code: string, where: string, message: string, fix: string) => void;

export async function reviewShipping(project: Project, scenes: readonly ShippingScene[], add: Add): Promise<void> {
  // The download.
  try {
    const { zip } = await packGame(project);
    if (zip.length > BUDGETS.zipIdea) {
      add(zip.length > BUDGETS.zipIssue ? "issue" : "idea", "shipping", "R_BIG_BUILD", "build/", `ludra build makes a ${megabytes(zip.length)} zip, which players download before the game starts.`, "Make big images smaller, use .ogg or .mp3 instead of .wav, and leave out what no scene uses. Physics and 3D add about 3 MB each.");
    }
  } catch {
    // A game that can't be built gets R_CHECK_FAILS elsewhere.
  }

  // Assets, each counted once.
  const seen = new Set<string>();
  for (const { label, scene } of scenes) {
    for (const ref of collectAssetPaths(scene)) {
      if (ref.kind === "script" || ref.kind === "scene" || seen.has(ref.path)) continue;
      seen.add(ref.path);
      const file = resolve(project.dir, ref.path);
      if (!existsSync(file)) continue;
      const bytes = statSync(file).size;
      if (bytes > BUDGETS.assetBytes) {
        add("idea", "shipping", "R_HEAVY_ASSET", ref.path, `${ref.path} is ${megabytes(bytes)}, more than the rest of most games.`, extname(file).toLowerCase() === ".wav" ? "Save it as .ogg or .mp3: a tenth of the size, and it sounds the same." : "Make it smaller: fewer pixels, a lighter format, or a shorter clip.");
      }
      if (ref.kind === "image") {
        const size = imageSize(readFileSync(file));
        if (size && Math.max(size.width, size.height) > BUDGETS.imageSide) {
          const texture = ref.at.includes("mesh.texture");
          add(texture ? "issue" : "idea", "shipping", "R_HUGE_IMAGE", ref.path, `${ref.path} is ${size.width} × ${size.height} px. ${texture ? "Many phones can't load a 3D texture over 4096 px, and draw the mesh without it." : "Over 4096 px it takes a lot of a phone's memory."} (${label})`, `Scale it to at most ${BUDGETS.imageSide} px on its longest side.`);
        }
      }
    }
  }

  for (const info of scenes) {
    // Triangles: every entity that shows a model draws all of it.
    if (info.scene.world?.dimensions === 3) {
      const triangles = new Map<string, number>();
      let total = 0;
      for (const entity of info.scene.entities) {
        const model = (entity.components as { mesh?: { model?: unknown } }).mesh?.model;
        if (typeof model !== "string" || model === "") continue;
        if (!triangles.has(model)) {
          let count = 0;
          try {
            count = readModel(resolve(project.dir, model)).triangles;
          } catch {
            // An unreadable model is check's to report.
          }
          triangles.set(model, count);
        }
        total += triangles.get(model)!;
      }
      if (total > BUDGETS.trianglesIdea) {
        const heaviest = [...triangles].sort((a, b) => b[1] - a[1])[0]!;
        add(total > BUDGETS.trianglesIssue ? "issue" : "idea", "shipping", "R_HEAVY_MODEL", info.label, `The scene's models draw ${total.toLocaleString("en")} triangles a frame; the heaviest is ${heaviest[0]} (${heaviest[1].toLocaleString("en")}).`, "Use lighter versions of the models (decimate them), most of all for those shown many times or far away.");
      }
    }

    // A run of each test, or of 10 s with nobody playing: how many entities, and how long a step takes.
    const runs = info.cases.length > 0 ? info.cases : [{ name: "idle", assert: [], duration: "10s" } as TestCase];
    let most = 0;
    let steps = 0;
    let time = 0;
    for (const test of runs) {
      const script = InputScript.parse(test.inputs ?? "");
      const frames = test.duration !== undefined ? secondsToFrames(typeof test.duration === "number" ? test.duration : parseDuration(test.duration)) : script.totalFrames + 60;
      let world: World;
      try {
        world = new World(info.scene, { scripts: info.scripts, ...(test.carry ? { carry: test.carry } : {}) });
      } catch {
        continue;
      }
      try {
        for (let frame = 0; frame < frames && !world.over; frame++) {
          const start = performance.now();
          world.step(script.at(frame));
          time += performance.now() - start;
          steps++;
          most = Math.max(most, world.entities.length);
        }
      } catch {
        // A crash is a failing test's to report.
      }
    }
    if (most > BUDGETS.entitiesIdea) {
      add(most > BUDGETS.entitiesIssue ? "issue" : "idea", "shipping", "R_MANY_ENTITIES", info.label, `Up to ${most} entities are alive at once in its tests.`, "Remove what has left the screen for good (bullets, particles made of entities), and draw a crowd or a field of tiles in one draw hook instead of one entity each.");
    }
    const mean = steps > 0 ? time / steps : 0;
    if (mean > BUDGETS.stepMs) {
      add("idea", "shipping", "R_SLOW_STEP", info.label, `A step takes ${mean.toFixed(1)} ms on this machine, on average over ${steps} steps. A phone takes several times longer, and a frame has 16.7 ms for stepping and drawing.`, "Find what costs the most (try the scene without a script, or with fewer bodies) and do less of it each step: fewer bodies awake, less work per update.");
    }
  }
}
