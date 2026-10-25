import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTest, type TestCase, type TestResult } from "@ludra/core";
import { paint } from "../format.ts";
import { loadProject, requireGame, type Game } from "../project.ts";

interface FileResult {
  file: string;
  error?: string;
  tests: TestResult[];
}

/** Runs every tests/*.test.json case against its scene (the entry scene unless the case names one). */
export async function test(dir: string, options: { json?: boolean }): Promise<number> {
  const project = loadProject(dir);
  // Each test runs its own scene ("scene" in the test case), loaded once.
  const games = new Map<string, Game>([[project.entryLabel, await requireGame(project)]]);
  const gameFor = async (scene: string | undefined) => {
    const key = scene ?? project.entryLabel;
    if (!games.has(key)) games.set(key, await requireGame(project, key));
    return games.get(key)!;
  };
  const testsDir = join(project.dir, "tests");
  const files = existsSync(testsDir) ? readdirSync(testsDir).filter((f) => f.endsWith(".test.json")).sort() : [];

  if (files.length === 0) {
    const message = 'No tests found. Add tests/<name>.test.json with { "tests": [{ "name": "...", "inputs": "right:1s", "assert": ["player.x > 300"] }] }.';
    if (options.json) console.log(JSON.stringify({ ok: false, error: message, files: [] }, null, 2));
    else console.log(paint("yellow", message));
    return 1;
  }

  const results: FileResult[] = [];
  for (const file of files) {
    let cases: TestCase[];
    try {
      const parsed = JSON.parse(readFileSync(join(testsDir, file), "utf8"));
      cases = parsed.tests;
      if (!Array.isArray(cases)) throw new Error('expected { "tests": [...] }');
    } catch (err) {
      results.push({ file, error: (err as Error).message, tests: [] });
      continue;
    }
    const tests: TestResult[] = [];
    for (const c of cases) {
      const { scene, scripts } = await gameFor(c.scene);
      tests.push(runTest(scene, c, { scripts }));
    }
    results.push({ file, tests });
  }

  const all = results.flatMap((r) => r.tests);
  const failed = all.filter((t) => !t.pass).length + results.filter((r) => r.error).length;

  if (options.json) {
    console.log(JSON.stringify({ ok: failed === 0, passed: all.length - failed, failed, files: results }, null, 2));
    return failed > 0 ? 1 : 0;
  }

  for (const result of results) {
    console.log(paint("bold", result.file));
    if (result.error) console.log(paint("red", `  ✗ could not read file: ${result.error}`));
    for (const t of result.tests) {
      console.log(t.pass ? paint("green", `  ✓ ${t.name}`) : paint("red", `  ✗ ${t.name}`));
      if (t.error) console.log(`      ${t.error}`);
      for (const r of t.results) {
        if (!r.pass) console.log(`      ${paint("red", "✗")} ${r.source}  ${paint("dim", "→")} ${r.message}`);
      }
    }
  }
  const summary = `\n${all.length - failed} passed, ${failed} failed`;
  console.log(failed > 0 ? paint("red", summary) : paint("green", summary));
  return failed > 0 ? 1 : 0;
}
