import { formatDiagnostics, paint } from "../format.ts";
import { loadGame, loadProject } from "../project.ts";

export async function check(dir: string, options: { json?: boolean }): Promise<number> {
  const project = loadProject(dir);
  const { game, diagnostics } = await loadGame(project);
  const scene = game?.scene;
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  if (options.json) {
    console.log(JSON.stringify({ ok: errors === 0, file: project.entryLabel, errors, warnings, diagnostics }, null, 2));
    return errors > 0 ? 1 : 0;
  }

  if (diagnostics.length > 0) console.log(`${formatDiagnostics(diagnostics, project.entryLabel)}\n`);
  if (errors > 0) {
    console.log(paint("red", `✗ ${project.entryLabel}: ${errors} error(s), ${warnings} warning(s)`));
    return 1;
  }
  const count = scene?.entities.length ?? 0;
  console.log(paint("green", `✓ ${project.entryLabel}: ${count} entities, ${warnings === 0 ? "no problems" : `${warnings} warning(s)`}`));
  return 0;
}
