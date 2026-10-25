import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDrawHooks, type Diagnostic } from "@ludra/core";
import { formatDiagnostics, paint } from "../format.ts";
import { isInside, listScenes, loadGame, loadProject, scriptPaths, type Project } from "../project.ts";

interface SceneCheck {
  file: string;
  entities: number;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
}

/** Validates every scene in the project (entry scene first). */
export async function check(dir: string, options: { json?: boolean }): Promise<number> {
  const project = loadProject(dir);
  const results: SceneCheck[] = [];
  const scripts = new Set<string>();
  for (const scene of listScenes(project)) {
    const { game, diagnostics, label } = await loadGame(project, scene);
    // Draw hooks only run in the browser, so paint once here to catch their errors early.
    if (game) {
      diagnostics.push(...checkDrawHooks(game.scene, game.scripts));
      for (const path of scriptPaths(project, game.scene)) scripts.add(path);
    }
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    results.push({ file: label, entities: game?.scene.entities.length ?? 0, errors, warnings: diagnostics.length - errors, diagnostics });
  }
  // world.goto("...") in scripts must point at real scenes.
  const gotoProblems = missingGotoScenes(project, [...scripts]);
  if (gotoProblems.length > 0) {
    results.push({ file: "scripts", entities: 0, errors: gotoProblems.length, warnings: 0, diagnostics: gotoProblems });
  }

  const errors = results.reduce((n, r) => n + r.errors, 0);
  const warnings = results.reduce((n, r) => n + r.warnings, 0);
  if (options.json) {
    const diagnostics = results.flatMap((r) => r.diagnostics.map((d) => ({ file: r.file, ...d })));
    console.log(JSON.stringify({ ok: errors === 0, file: project.entryLabel, errors, warnings, diagnostics, scenes: results }, null, 2));
    return errors > 0 ? 1 : 0;
  }

  for (const r of results) {
    if (r.diagnostics.length > 0) console.log(`${formatDiagnostics(r.diagnostics, r.file)}\n`);
    if (r.errors > 0) console.log(paint("red", `✗ ${r.file}: ${r.errors} error(s), ${r.warnings} warning(s)`));
    else console.log(paint("green", `✓ ${r.file}: ${r.entities} entities, ${r.warnings === 0 ? "no problems" : `${r.warnings} warning(s)`}`));
  }
  return errors > 0 ? 1 : 0;
}

/** Scene paths written literally in world.goto("...") calls that don't exist. */
function missingGotoScenes(project: Project, scripts: string[]): Diagnostic[] {
  const problems: Diagnostic[] = [];
  for (const src of scripts) {
    const file = resolve(project.dir, src);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/\bgoto\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) {
      const target = resolve(project.dir, match[1]!);
      if (isInside(project.dir, target) && existsSync(target)) continue;
      problems.push({
        severity: "error",
        code: "E_SCENE_MISSING",
        path: `${src} → goto("${match[1]}")`,
        message: `${src} goes to "${match[1]}", which does not exist.`,
        fix: `Scenes: ${listScenes(project).join(", ")}. Paths are relative to the folder with ludra.json.`,
      });
    }
  }
  return problems;
}
