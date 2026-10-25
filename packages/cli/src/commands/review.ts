import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runTest, type SceneDef, type Script, type TestCase, type TestResult } from "@ludra/core";
import { paint } from "../format.ts";
import { listScenes, loadGame, loadProject, type Game, type Project } from "../project.ts";

/**
 * `ludra review`: the signs of a slop game, found automatically. Where `check`
 * asks "is it valid?" and `test` asks "does it work?", review asks "is it
 * finished?": proven, felt, styled and named. Issues should be fixed before a
 * game is called done; ideas are worth considering.
 */

type Area = "proof" | "feel" | "looks" | "identity";
type Level = "issue" | "idea";

export interface Finding {
  level: Level;
  area: Area;
  code: string;
  /** The scene or file it is about. */
  where: string;
  message: string;
  fix: string;
}

const AREAS: Record<Area, string> = {
  proof: "Proof: is it shown to work?",
  feel: "Feel: does every moment answer the player?",
  looks: "Looks: does it have a style of its own?",
  identity: "Identity: is it a game, or a project folder?",
};

/** Events players cause or feel directly: silence on these reads as unfinished. */
const IMPORTANT_EVENTS = new Set(["collect", "die", "stomp", "win", "gameover", "checkpoint", "jump"]);
const LISTED = 5;

interface SceneInfo {
  label: string;
  game: Game;
  results: TestResult[];
}

export async function review(dir: string, options: { json?: boolean; strict?: boolean }): Promise<number> {
  const project = loadProject(dir);
  const findings: Finding[] = [];
  const add = (level: Level, area: Area, code: string, where: string, message: string, fix: string) =>
    findings.push({ level, area, code, where, message, fix });

  // Load every scene; review only makes sense for a game that passes check.
  const scenes: SceneInfo[] = [];
  for (const label of listScenes(project)) {
    const { game, diagnostics } = await loadGame(project, label);
    if (!game) {
      const errors = diagnostics.filter((d) => d.severity === "error").length;
      add("issue", "proof", "R_CHECK_FAILS", label, `The scene has ${errors} error(s), so it can't be reviewed.`, "Run `ludra check` and fix them first.");
      continue;
    }
    scenes.push({ label, game, results: [] });
  }

  const tests = readTests(project);
  for (const problem of tests.problems) add("issue", "proof", "R_TESTS_UNREADABLE", problem.file, problem.message, "Fix the JSON in that test file.");
  for (const c of tests.cases) {
    const scene = scenes.find((s) => s.label === (c.scene ?? project.entryLabel));
    if (scene) scene.results.push(runTest(scene.game.scene, c, { scripts: scene.game.scripts }));
  }

  if (tests.cases.length === 0) {
    add("issue", "proof", "R_NO_TESTS", "tests/", "There are no tests, so nothing shows the game works.", 'Add tests/gameplay.test.json, starting with one that proves a level can be won: "won == true", "deaths == 0".');
  }
  const failing = scenes.flatMap((s) => s.results.filter((r) => !r.pass).map((r) => `"${r.name}"`));
  if (failing.length > 0) {
    add("issue", "proof", "R_FAILING_TESTS", "tests/", `${failing.length} test(s) fail: ${list(failing)}.`, "Run `ludra test` and fix the game (not the test) until they pass.");
  }

  for (const scene of scenes) {
    reviewScene(project, scene, tests.cases.length > 0, add);
  }

  // Identity.
  const folder = basename(project.dir);
  if (project.config.name === "untitled" || project.config.name === folder) {
    add("idea", "identity", "R_FOLDER_NAME", "ludra.json", `The game is called "${project.config.name}", the name of its folder.`, 'Give it a real title in ludra.json ("name"), the one players will see.');
  }

  const issues = findings.filter((f) => f.level === "issue").length;
  const ideas = findings.length - issues;
  if (options.json) {
    console.log(JSON.stringify({ ok: issues === 0, issues, ideas, findings }, null, 2));
  } else {
    print(project, findings, issues, ideas);
  }
  return options.strict && issues > 0 ? 1 : 0;
}

function reviewScene(project: Project, info: SceneInfo, hasTests: boolean, add: (level: Level, area: Area, code: string, where: string, message: string, fix: string) => void): void {
  const { label, game, results } = info;
  const { scene, scripts } = game;
  const sources = scriptSources(project, scene);
  const hooksOf = (src: string) => Object.keys(scripts.get(src) ?? {}) as (keyof Script)[];
  const uses = (hook: keyof Script) => scene.entities.some((e) => e.components.script && hooksOf(String(e.components.script.src)).includes(hook));

  // ---------------------------------------------------------------- proof
  const canWin = scene.entities.some((e) => e.components.goal) || [...sources.values()].some((code) => /\bwin\(\s*\)/.test(code));
  const proves = (r: TestResult, ...needed: RegExp[]) => r.pass && needed.every((re) => r.results.some((a) => re.test(a.source.replace(/\s+/g, " "))));
  if (canWin && hasTests && !results.some((r) => proves(r, /^won == true\b/, /^deaths == 0\b/))) {
    add("issue", "proof", "R_NO_WIN_PROOF", label, "No passing test proves this scene can be won without dying.", 'Add a test with a full route and "won == true", "deaths == 0". For long routes, write a small autopilot (see the skill).');
  }

  // A mechanic is tested when an assertion names one of its entities or the events it emits.
  const asserted = results.flatMap((r) => r.results.map((a) => a.source)).join("\n");
  for (const [src, code] of sources) {
    const hooks = hooksOf(src);
    if (!hooks.some((h) => h === "start" || h === "update" || h === "touch")) continue; // only draws
    const ids = scene.entities.filter((e) => e.components.script?.src === src).map((e) => e.id);
    const emitted = [...code.matchAll(/\bemit\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    const mentioned = ids.some((id) => asserted.includes(`${id}.`)) || emitted.some((name) => asserted.includes(`events.${name}`));
    if (hasTests && !mentioned) {
      add("issue", "proof", "R_UNTESTED_MECHANIC", label, `${src} (on ${list(ids)}) has no test that checks what it does.`, `Add a test that isolates it and asserts its effect: ${ids[0] ? `"${ids[0]}.state.<key> == ..."` : ""}${emitted[0] ? ` or "events.${emitted[0]} >= 1"` : ""}.`);
    }
  }

  // ---------------------------------------------------------------- feel
  const fired = new Set(results.flatMap((r) => r.events));
  const drawn = [...sources.values()].flatMap((code) => [...code.matchAll(/\brecent\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!));
  const silent = [...fired].filter((name) => name !== "goto" && !scene.effects?.[name] && !drawn.includes(name));
  const important = silent.filter((name) => IMPORTANT_EVENTS.has(name));
  if (important.length > 0) {
    add("issue", "feel", "R_SILENT_EVENT", label, `These events happen in play but nothing answers them: ${list(important)}.`, 'Give each an "effects" entry (particles in the source\'s color, a sound, shake for big moments) or react to it in a draw hook with ctx.recent("<name>").');
  }
  const minor = silent.filter((name) => !IMPORTANT_EVENTS.has(name));
  if (minor.length > 0) {
    add("idea", "feel", "R_QUIET_EVENT", label, `These events have no feedback yet: ${list(minor)}.`, "Small touches (a puff on land, a blip on bounce, a flash for custom events) make a game feel alive.");
  }
  const mute = Object.entries(scene.effects ?? {}).filter(([name, effect]) => IMPORTANT_EVENTS.has(name) && effect && !effect.sound).map(([name]) => name);
  if (mute.length > 0) {
    add("idea", "feel", "R_NO_SOUND", label, `These effects have no sound: ${list(mute)}.`, "Add a preset (jump, coin, hit, explosion, powerup, blip, thud) or an audio file.");
  }

  // ---------------------------------------------------------------- looks
  if (!uses("drawUI")) {
    add("issue", "looks", "R_DEFAULT_HUD", label, "It uses the engine's default HUD and end screens.", "Write a drawUI hook: show what matters in this game (lives as hearts, crystals as icons, a meter), a title card and a win screen, in a font that fits the mood.");
  } else if (!scene.fonts || Object.keys(scene.fonts).length === 0) {
    add("idea", "looks", "R_SYSTEM_FONT", label, "The interface uses the system font.", 'Load a display font that fits the mood: "fonts": { "<Family>": "google" }.');
  }
  const hasBackdrop =
    scene.entities.some((e) => (e.components.sprite && Number(e.components.sprite.layer ?? 0) < 0) || (!e.components.body && e.components.script && hooksOf(String(e.components.script.src)).includes("draw")));
  if (!hasBackdrop) {
    add("issue", "looks", "R_FLAT_BACKDROP", label, "Behind the game there is only a flat background color.", "Paint a backdrop: a sprite on layer -1 (sky, hills, floor tiles) or an entity with only a draw hook (gradients, a sun, stars, parallax).");
  }
  const plain = scene.entities
    .filter((e) => e.components.sprite && !e.components.sprite.image && !(e.components.script && hooksOf(String(e.components.script.src)).includes("draw")))
    .map((e) => e.id);
  if (plain.length > 0) {
    add("issue", "looks", "R_PLAIN_SHAPES", label, `${plain.length} entit${plain.length === 1 ? "y is" : "ies are"} drawn as flat colored shapes: ${list(plain)}.`, "Give them SVG art (sprite.image) or a draw hook.");
  }
  if (!scene.postfx) {
    add("idea", "looks", "R_NO_POSTFX", label, "No post-processing.", 'A finishing shader ("postfx") ties a look together: bloom for anything that glows, a grade for mood, scanlines for arcade.');
  }
  if (!scene.name) {
    add("idea", "identity", "R_UNNAMED_SCENE", label, "The scene has no name.", 'Add "name" (e.g. "Crystal Grove") to the scene.');
  }
}

/** Source code of the scripts a scene uses, by path. */
function scriptSources(project: Project, scene: SceneDef): Map<string, string> {
  const sources = new Map<string, string>();
  for (const e of scene.entities) {
    const src = e.components.script?.src;
    if (typeof src !== "string" || sources.has(src)) continue;
    const file = resolve(project.dir, src);
    if (existsSync(file)) sources.set(src, readFileSync(file, "utf8"));
  }
  return sources;
}

function readTests(project: Project): { cases: TestCase[]; problems: { file: string; message: string }[] } {
  const dir = join(project.dir, "tests");
  const cases: TestCase[] = [];
  const problems: { file: string; message: string }[] = [];
  if (!existsSync(dir)) return { cases, problems };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!Array.isArray(parsed.tests)) throw new Error('expected { "tests": [...] }');
      cases.push(...parsed.tests);
    } catch (err) {
      problems.push({ file: `tests/${file}`, message: `Could not read it: ${(err as Error).message}` });
    }
  }
  return { cases, problems };
}

function list(items: string[]): string {
  return items.length <= LISTED ? items.join(", ") : `${items.slice(0, LISTED).join(", ")} and ${items.length - LISTED} more`;
}

function print(project: Project, findings: Finding[], issues: number, ideas: number): void {
  console.log(paint("bold", `Review of ${project.config.name}`));
  for (const area of Object.keys(AREAS) as Area[]) {
    const inArea = findings.filter((f) => f.area === area).sort((a, b) => (a.level === b.level ? 0 : a.level === "issue" ? -1 : 1));
    console.log(`\n${paint("bold", AREAS[area])}`);
    if (inArea.length === 0) {
      console.log(paint("green", "  ✓ nothing to flag"));
      continue;
    }
    for (const f of inArea) {
      const mark = f.level === "issue" ? paint("red", "✗") : paint("yellow", "○");
      console.log(`  ${mark} ${paint("dim", `[${f.where}]`)} ${f.message}`);
      console.log(`    ${paint("dim", "→")} ${f.fix}`);
    }
  }
  const summary = `\n${issues} issue(s), ${ideas} idea(s).`;
  if (issues === 0) console.log(paint("green", `${summary} Nothing marks this as unfinished.${ideas > 0 ? " The ideas are worth a look." : ""}`));
  else console.log(paint("red", `${summary} Fix the issues before calling the game done.`));
}
