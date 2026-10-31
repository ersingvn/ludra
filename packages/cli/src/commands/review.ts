import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findPlayer, fuzz, InputScript, isSoundPreset, measureWindows, runTest, World, type SceneDef, type Script, type TestCase, type TestResult } from "@ludra/core";
import { paint } from "../format.ts";
import { captureScreenshots, findBrowser } from "../headless.ts";
import { decodePng } from "../png.ts";
import { closeEnough, isClear, measurePresence, TINY_SHARE, type Presence } from "../readability.ts";
import { listScenes, loadGame, loadProject, type Game, type Project } from "../project.ts";

/**
 * `ludra review`: the signs of a slop game, found automatically. Where `check`
 * asks "is it valid?" and `test` asks "does it work?", review asks "is it
 * finished?": proven, felt, styled and named. Issues should be fixed before a
 * game is called done; ideas are worth considering.
 */

type Area = "proof" | "fair" | "feel" | "looks" | "readable" | "identity";
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
  fair: "Fair: can a person beat it, and can it never trap them?",
  feel: "Feel: does every moment answer the player?",
  looks: "Looks: does it have a style of its own?",
  readable: "Readable: can a player see what matters?",
  identity: "Identity: is it a game, or a project folder?",
};

/** Events players cause or feel directly: silence on these reads as unfinished. */
const IMPORTANT_EVENTS = new Set(["collect", "die", "stomp", "win", "gameover", "checkpoint", "jump"]);
const LISTED = 5;

interface SceneInfo {
  label: string;
  game: Game;
  results: TestResult[];
  /** The test case behind each result. */
  cases: TestCase[];
}

export async function review(dir: string, options: { json?: boolean; strict?: boolean; fast?: boolean }): Promise<number> {
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
    scenes.push({ label, game, results: [], cases: [] });
  }

  const tests = readTests(project);
  for (const problem of tests.problems) add("issue", "proof", "R_TESTS_UNREADABLE", problem.file, problem.message, "Fix the JSON in that test file.");
  for (const c of tests.cases) {
    const scene = scenes.find((s) => s.label === (c.scene ?? project.entryLabel));
    if (!scene) continue;
    scene.results.push(runTest(scene.game.scene, c, { scripts: scene.game.scripts }));
    scene.cases.push(c);
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
    reviewFairness(scene, add, !options.fast);
  }
  if (!options.fast) await reviewReadability(project, scenes, add);

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
    add("idea", "feel", "R_NO_SOUND", label, `These effects have no sound: ${list(mute)}.`, 'Give each a sound of the game\'s own ("sounds") or play one from a sound hook.');
  }
  const ownSounds = Object.keys(scene.sounds ?? {}).length > 0 || uses("sound");
  const effectSounds = Object.values(scene.effects ?? {}).map((effect) => effect?.sound).filter((sound): sound is string => typeof sound === "string" && sound !== "");
  if (!ownSounds && effectSounds.length > 0 && effectSounds.every((sound) => isSoundPreset(sound))) {
    add("issue", "feel", "R_STOCK_SOUNDS", label, "Every sound is a built-in preset, the same beeps as every other Ludra game.", 'Design the game\'s own sounds in "sounds" (tone and noise layers, "vary" so repeats differ) to fit its world: wood, metal, magic, slime. Run `ludra components sounds`.');
  }
  if (!scene.music && !uses("sound")) {
    add("issue", "feel", "R_NO_MUSIC", label, "The game has no music.", 'Write music that fits the mood: "music" with tracks of notes (a bass line, a melody, drums), an audio file, or adaptive music in a sound hook. Run `ludra components sounds`.');
  }

  // ---------------------------------------------------------------- looks
  if (!uses("drawUI")) {
    add("issue", "looks", "R_DEFAULT_HUD", label, "It uses the engine's default HUD and end screens.", "Write a drawUI hook: show what matters in this game (lives as hearts, crystals as icons, a meter), a title card and a win screen, in a font that fits the mood.");
  } else if (!scene.fonts || Object.keys(scene.fonts).length === 0) {
    add("idea", "looks", "R_SYSTEM_FONT", label, "The interface uses the system font.", 'Load a display font that fits the mood: "fonts": { "<Family>": "google" }.');
  }
  if (scene.world?.dimensions === 3) {
    review3DLooks(scene, uses("render"), hooksOf, label, add);
  } else {
    review2DLooks(scene, hooksOf, label, add);
  }
  if (!scene.postfx && !uses("render")) {
    add("idea", "looks", "R_NO_POSTFX", label, "No post-processing.", 'A finishing shader ("postfx") ties a look together: bloom for anything that glows, a grade for mood, scanlines for arcade. In 3D, a render hook can run three.js post-processing (ctx.addon, ctx.setRender).');
  }
  if (!scene.name) {
    add("idea", "identity", "R_UNNAMED_SCENE", label, "The scene has no name.", 'Add "name" (e.g. "Crystal Grove") to the scene.');
  }
}

/** Seconds of random play per scene, looking for crashes and softlocks. */
const FUZZ_SECONDS = 4;

/**
 * Fair: the win test's route, press by press, must leave a person room to be a little early or
 * late; random play must never crash a script or trap the player where it can neither win nor die.
 */
function reviewFairness(info: SceneInfo, add: Add, play: boolean): void {
  const { label, game, results, cases } = info;
  const make = () => new World(game.scene, { scripts: game.scripts });
  const route = winRoute(results);
  const inputs = route >= 0 ? cases[route]?.inputs : undefined;
  if (inputs) {
    const script = InputScript.parse(inputs);
    const frames = Array.from({ length: script.totalFrames }, (_, f) => script.at(f));
    const windows = measureWindows(make, frames, (w) => w.won);
    const at = (frame: number) => `${(frame / 60).toFixed(2)}s`;
    const exact = windows.filter((w) => w.width <= 2);
    if (exact.length > 0) {
      add("issue", "fair", "R_FRAME_PERFECT", label, `In "${results[route]!.name}", ${list(exact.map((w) => `the ${w.action} at ${at(w.frame)} (${w.width} frame${w.width === 1 ? "" : "s"})`))} must be pressed on the exact frame: no person can.`, "Give the move room: a shorter gap, a wider ledge, coyote time, a slower hazard. Run `ludra solve` to see whether another route is easier.");
    }
    const tight = windows.filter((w) => w.width > 2 && w.width <= 6);
    if (tight.length > 0) {
      add("idea", "fair", "R_TIGHT_TIMING", label, `In "${results[route]!.name}", ${list(tight.map((w) => `the ${w.action} at ${at(w.frame)} (${w.width} frames)`))} only work${tight.length === 1 ? "s" : ""} within 0.1 s.`, "Fine for a hard moment, unfair early on. Widen it where the level is meant to be easy.");
    }
  }
  if (!play) return;
  let result;
  try {
    const until = Date.now() + FUZZ_SECONDS * 1000;
    result = fuzz(make, { sessions: 200, seconds: 30, deadline: () => Date.now() > until });
  } catch {
    return; // no player: nothing to play
  }
  for (const crash of result.crashes) {
    add("issue", "proof", "R_CRASH", label, `Random play crashes a script: ${crash.message}`, `Reproduce it with ludra play --inputs "${crash.inputs}" and fix the script.`);
  }
  for (const trap of result.softlocks) {
    const where = `(${trap.x}, ${trap.y}${trap.z !== undefined ? `, ${trap.z}` : ""})`;
    add("issue", "fair", "R_SOFTLOCK", label, `The player can get stuck at ${where}: from there the game can't be won, and nothing kills them.`, `See it with ludra play --inputs "${trap.inputs}" --screenshot end. Give a way out (a ladder, a spring, a lower ledge) or make it cost a life (a hazard, a fall limit).`);
  }
}

/** The first passing test that wins, whose inputs are a real way through the scene. */
function winRoute(results: TestResult[]): number {
  return results.findIndex((r) => r.pass && r.results.some((a) => /^won == true\b/.test(a.source.replace(/\s+/g, " "))));
}

interface Subject {
  name: string;
  ids: string[];
  level: Level;
  fix: string;
}

/** What a player has to pick out of a frame, and how much it matters when they can't. */
function subjectsOf({ game }: SceneInfo): Subject[] {
  const withComponent = (name: "hazard" | "goal" | "collectible") => game.scene.entities.filter((e) => e.components[name]).map((e) => e.id);
  const player = findPlayer(new World(game.scene, { scripts: game.scripts }))?.id;
  const subjects: Subject[] = [
    { name: "The player", ids: player ? [player] : [], level: "issue", fix: "Give the player a color or outline that stands out from every background it crosses, or a light of its own." },
    { name: "The hazards", ids: withComponent("hazard"), level: "issue", fix: "What hurts must be seen in time: a warning color no safe thing uses, a glow, a dark outline." },
    { name: "The goal", ids: withComponent("goal"), level: "idea", fix: "Make the place to reach stand out: a brighter color, a glow, a beacon." },
    { name: "The collectibles", ids: withComponent("collectible"), level: "idea", fix: "Make them catch the eye: a brighter color, a glow, a sparkle." },
  ];
  return subjects.filter((s) => s.ids.length > 0);
}

/**
 * Readable: draws moments along the route with and without each thing that matters, so the
 * difference is exactly where it is on screen and what is behind it. A thing is only called
 * unclear if it is unclear at half the moments it's on screen or more; passing a dark corner is fine.
 */
async function reviewReadability(project: Project, scenes: SceneInfo[], add: Add): Promise<void> {
  if (scenes.length === 0) return;
  if (!findBrowser()) {
    add("idea", "readable", "R_NOT_LOOKED", "frames", "Nobody looked at the frames: no Chrome, Edge or Chromium was found.", "Install one, or set LUDRA_BROWSER, to have review measure what a player can see.");
    return;
  }
  for (const info of scenes) {
    const subjects = subjectsOf(info);
    if (subjects.length === 0) continue;
    const route = winRoute(info.results);
    const inputs = (route >= 0 ? info.cases[route]?.inputs : undefined) ?? "";
    const length = InputScript.parse(inputs).totalFrames;
    const frames = [...new Set([MOMENT, ...[1, 2].map((n) => Math.max(MOMENT, Math.floor((length * n) / 3)))])];
    let captured;
    try {
      captured = await captureScreenshots(project, { scene: info.label, inputs, frames, hide: subjects.map((s) => s.ids) });
    } catch (err) {
      add("idea", "readable", "R_NOT_LOOKED", info.label, `Could not draw the scene to measure it: ${(err as Error).message}`, "Run `ludra play --screenshot end` to see what goes wrong.");
      continue;
    }
    const decoded = (png: string) => decodePng(Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
    const seen: Presence[][] = subjects.map(() => []);
    for (const frame of captured.frames) {
      let before = decoded(frame.png);
      frame.without!.forEach(({ png, after }, i) => {
        const whole = decoded(after);
        seen[i]!.push(measurePresence(before, decoded(png), whole));
        before = whole;
      });
    }
    subjects.forEach((subject, i) => {
      const moments = seen[i]!.filter((p) => p.pixels > 0);
      if (subject.name === "The player" && moments.length === 0) {
        add("issue", "readable", "R_PLAYER_NOT_DRAWN", info.label, "The player can't be seen in the frames measured: it is off screen, or the same color as what's behind it.", "Keep the player in view with a camera that follows it, and draw it in a color that stands out.");
      }
      if (moments.length === 0) return;
      // A player missing from a moment is as hard to find as one that blends in.
      const measured = subject.name === "The player" ? seen[i]! : closeEnough(moments);
      const unclear = measured.filter((p) => !isClear(p));
      if (unclear.length * 2 >= measured.length) {
        const best = unclear.reduce((a, b) => (b.contrast > a.contrast ? b : a));
        add(subject.level, "readable", "R_LOW_CONTRAST", info.label, `${subject.name} ${subject.name.endsWith("s") ? "blend into what's behind them" : "blends into what's behind it"} (contrast ${best.contrast.toFixed(2)}:1).`, subject.fix);
      }
      if (subject.name === "The player" && moments.every((p) => p.share < TINY_SHARE)) {
        add("idea", "readable", "R_TINY_PLAYER", info.label, `The player covers only ${(moments[0]!.share * 100).toFixed(2)}% of the screen.`, "Move the camera closer or make the character bigger: it should be easy to find at a glance.");
      }
    });
  }
}

/** The first moment measured: late enough for a title card to have started fading. */
const MOMENT = 60;
type Add = (severity: "issue" | "idea", area: Area, code: string, where: string, message: string, fix: string) => void;

/** 2D: a painted backdrop, and art instead of flat colored shapes. */
function review2DLooks(scene: SceneDef, hooksOf: (src: string) => (keyof Script)[], label: string, add: Add): void {
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
}

/** 3D: its own light and sky, things you can see, and materials chosen for them. */
function review3DLooks(scene: SceneDef, rendersItself: boolean, hooksOf: (src: string) => (keyof Script)[], label: string, add: Add): void {
  if (!scene.entities.some((e) => e.components.light)) {
    add("issue", "looks", "R_DEFAULT_LIGHTING", label, "The scene has no lights of its own, so it gets the engine's default sky and sun.", 'Light it for its mood: a "directional" sun (warm at dusk, cold at night), a "hemisphere" fill in the sky\'s colors, "point" lights on torches and crystals.');
  }
  if (!scene.environment?.sky && !rendersItself) {
    add("issue", "looks", "R_DEFAULT_SKY", label, "Behind the world is the engine's default sky.", 'Give it a sky that fits: "environment": { "sky": ["<top>", "<horizon>"], "fog": { ... } }, or paint one in a render hook.');
  }
  const visible = (e: SceneDef["entities"][number]) => e.components.mesh || (e.components.script && hooksOf(String(e.components.script.src)).includes("render"));
  const invisible = scene.entities.filter((e) => e.components.body && !e.components.body.sensor && !visible(e)).map((e) => e.id);
  if (invisible.length > 0) {
    add("idea", "looks", "R_INVISIBLE_BODIES", label, `${invisible.length} solid bod${invisible.length === 1 ? "y has" : "ies have"} no mesh, so players can't see them: ${list(invisible)}.`, 'Give each a "mesh" (or draw it in a render hook), unless it is meant to be an invisible wall.');
  }
  const DEFAULT_COLOR = "#c8ccd6";
  const meshes = scene.entities.filter((e) => e.components.mesh);
  const plain = meshes.filter((e) => (e.components.mesh!.color ?? DEFAULT_COLOR) === DEFAULT_COLOR && !e.components.mesh!.texture).map((e) => e.id);
  if (plain.length > 0) {
    add("issue", "looks", "R_DEFAULT_MATERIALS", label, `${plain.length} mesh${plain.length === 1 ? " uses" : "es use"} the default grey material: ${list(plain)}.`, "Choose a material for each: color, roughness and metalness (stone, grass, metal, crystal), emissive for what glows, or a texture.");
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
