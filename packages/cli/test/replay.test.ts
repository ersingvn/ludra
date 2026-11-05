import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Recorder, World, type Action, type Recording, type SceneDef } from "@ludra/core";
import { loadProject, requireGame, type Project } from "../src/project.ts";
import { gameHash, recordingPath, saveTake, type TakeUpload } from "../src/recordings.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };
const hero = { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {} } };
const spike = { id: "spike", components: { transform: { x: 300, y: 490 }, body: { type: "static", width: 40, height: 20, sensor: true }, hazard: {} } };
const goal = { id: "goal", components: { transform: { x: 600, y: 470 }, body: { type: "static", width: 30, height: 60, sensor: true }, goal: {} } };

function makeGame(entities: unknown[] = [ground, hero, spike, goal]): string {
  const dir = mkdtempSync(join(tmpdir(), "ludra-replay-"));
  writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Replay Test", entry: "main.scene.json" }));
  writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ entities }));
  return dir;
}

/** Records a session in Node exactly the way a page does, through the same saving code. */
async function record(project: Project, session: string, takes: { inputs: [number, Action[]][]; marks?: [number, Parameters<Recorder["mark"]>[1], string?][] }[]): Promise<string> {
  const { scene, scripts } = await requireGame(project);
  const recorder = new Recorder({
    session,
    game: project.config.name,
    entry: project.entryLabel,
    version: (path) => gameHash(project, path),
    now: () => "2026-11-01T12:00:00.000Z",
    save: (recording, index, take) => saveTake(project, structuredClone({ recording, index, take }) as TakeUpload),
  });
  for (const take of takes) {
    const world = new World(scene as SceneDef, { scripts });
    recorder.begin(world, undefined);
    let frame = 0;
    for (const [frames, held] of take.inputs) {
      for (let i = 0; i < frames; i++) {
        const input = new Set(held);
        world.step(input);
        recorder.step(world, input);
        frame++;
        for (const [at, kind, text] of take.marks ?? []) if (at === frame) recorder.mark(world, kind, text);
      }
    }
    recorder.stop();
  }
  return recordingPath(project, session);
}

const RIGHT: Action[] = ["right"];

describe("ludra replay", () => {
  it("plays a recording again, frame for frame", async () => {
    const dir = makeGame();
    const file = await record(loadProject(dir), "20261101-120000-aaaaaa", [{ inputs: [[60, RIGHT], [12, ["right", "jump"]], [40, RIGHT]] }]);
    const result = run("replay", file, "--json");
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.takes[0].replay.status, "same");
    assert.equal(report.takes[0].replay.otherVersion, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a folder means its newest recording", async () => {
    const dir = makeGame();
    await record(loadProject(dir), "20261101-120000-bbbbbb", [{ inputs: [[30, RIGHT]] }]);
    const result = run("replay", dir);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /plays out the same/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says when the game changed and the run with it, and when", async () => {
    const dir = makeGame();
    const file = await record(loadProject(dir), "20261101-120000-cccccc", [{ inputs: [[400, RIGHT]] }]);
    const before = JSON.parse(readFileSync(file, "utf8")) as Recording;
    assert.equal(before.takes[0]!.deathCount > 0, true, "the spike killed the player");
    writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ entities: [ground, hero, goal] }));

    const result = run("replay", file);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /the game changed/);
    assert.match(result.out, /left the original between 0\.00s and 5\.00s/);
    assert.match(result.out, /it was not finished, now won/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls a different run on the same game what it is", async () => {
    const dir = makeGame();
    const file = await record(loadProject(dir), "20261101-120000-dddddd", [{ inputs: [[120, RIGHT]] }]);
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
    recording.takes[0]!.inputs = "wait:120f";
    writeFileSync(file, JSON.stringify(recording));
    const result = run("replay", file);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /same game played differently/);
    assert.match(result.out, /Math\.random/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--test keeps a win as a test that passes, and a scene change fails it", async () => {
    const dir = makeGame([ground, hero, goal]);
    const file = await record(loadProject(dir), "20261101-120000-eeeeee", [{ inputs: [[20, []], [400, RIGHT]] }]);
    const result = run("replay", file, "--test");
    assert.equal(result.code, 0, result.out);
    const tests = JSON.parse(readFileSync(join(dir, "tests", "recordings.test.json"), "utf8")).tests;
    assert.equal(tests.length, 1);
    assert.ok(tests[0].assert.includes("won == true"));
    assert.equal(tests[0].recording, "20261101-120000-eeeeee");
    assert.equal(run("test", dir).code, 0);

    run("replay", file, "--test");
    assert.equal(JSON.parse(readFileSync(join(dir, "tests", "recordings.test.json"), "utf8")).tests.length, 1, "the same take replaces its test");

    writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ entities: [ground, hero, spike, goal] }));
    assert.equal(run("test", dir).code, 1, "the spike now stops this run");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--take picks a take, and an unfinished take becomes a test of where it stopped", async () => {
    const dir = makeGame();
    const file = await record(loadProject(dir), "20261101-120000-ffffff", [{ inputs: [[10, RIGHT]] }, { inputs: [[50, RIGHT]] }]);
    assert.match(run("replay", file, "--take", "3").out, /has 2 takes/);
    const result = run("replay", file, "--take", "2", "--test");
    assert.equal(result.code, 0, result.out);
    const [test, ...rest] = JSON.parse(readFileSync(join(dir, "tests", "recordings.test.json"), "utf8")).tests;
    assert.equal(rest.length, 0);
    assert.ok(test.assert.some((a: string) => a.startsWith("player.x >=")));
    assert.equal(run("test", dir).code, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a test of a carried take starts with what was carried", async () => {
    const dir = makeGame();
    const project = loadProject(dir);
    await record(project, "20261101-120000-gggggg", [{ inputs: [[30, RIGHT]] }]);
    const file = recordingPath(project, "20261101-120000-gggggg");
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
    recording.takes[0]!.carry = { score: 5, deaths: 2 };
    recording.takes[0]!.score = 5;
    recording.takes[0]!.deathCount = 2;
    recording.takes[0]!.checks = [];
    writeFileSync(file, JSON.stringify(recording));
    assert.equal(run("replay", file, "--test").code, 0);
    assert.equal(run("test", dir).code, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a take whose page died counts as stopped, and still plays out the same", async () => {
    const dir = makeGame();
    const file = await record(loadProject(dir), "20261101-120000-oooooo", [{ inputs: [[90, RIGHT]] }]);
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
    delete recording.takes[0]!.end;
    recording.takes[0]!.checks = [];
    writeFileSync(file, JSON.stringify(recording));
    const result = run("replay", file, "--json");
    assert.equal(result.code, 0, result.out);
    assert.equal(JSON.parse(result.out).takes[0].end, "stopped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("explains a recording that isn't one, and a folder without any", () => {
    const dir = makeGame();
    assert.match(run("replay", dir).out, /no recordings yet/);
    writeFileSync(join(dir, "broken.rec.json"), "{ nope");
    assert.match(run("replay", join(dir, "broken.rec.json")).out, /is not a recording/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("saveTake", () => {
  const dir = makeGame();
  const project = loadProject(dir);
  const recording = { version: 1 as const, session: "20261101-120000-hhhhhh", game: "x", started: "2026-11-01T12:00:00.000Z" };
  const take = { scene: "main.scene.json", version: "v", inputs: "right:10f", frames: 10, checks: [], score: 0, deathCount: 0, deaths: [], marks: [] };
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a session id that could leave the folder, and malformed takes", () => {
    assert.throws(() => saveTake(project, { recording: { ...recording, session: "../../evil-file" }, index: 0, take }), /bad session id/);
    assert.throws(() => saveTake(project, { recording, index: -1, take }), /bad take index/);
    assert.throws(() => saveTake(project, { recording, index: 0, take: { ...take, frames: -1 } }), /inputs and frames/);
    assert.throws(() => saveTake(project, { recording, index: 0, take: { ...take, marks: [{ frame: 1, kind: "nope" as "hard" }] } }), /marks are malformed/);
    assert.equal(existsSync(join(dir, "recordings")), false);
  });

  it("a late request can't take a take back to an earlier state", () => {
    saveTake(project, { recording, index: 0, take: { ...take, frames: 20, inputs: "right:20f", end: "stopped" } });
    saveTake(project, { recording, index: 0, take });
    const saved = JSON.parse(readFileSync(recordingPath(project, recording.session), "utf8")) as Recording;
    assert.equal(saved.takes[0]!.frames, 20);
  });
});

describe("ludra feedback", () => {
  it("groups marks, deaths and where people left by scene, each with its command", async () => {
    const dir = makeGame();
    const project = loadProject(dir);
    await record(project, "20261101-120000-iiiiii", [
      { inputs: [[120, RIGHT]], marks: [[30, "hard"]] },
      { inputs: [[120, RIGHT]], marks: [[35, "hard"], [40, "note", "I can't see the spike"]] },
    ]);
    await record(project, "20261101-130000-jjjjjj", [{ inputs: [[30, RIGHT]], marks: [[20, "great"]] }]);

    const json = JSON.parse(run("feedback", dir, "--json").out);
    assert.equal(json.sessions, 2);
    assert.equal(json.takes, 3);
    const scene = json.scenes[0];
    assert.equal(scene.scene, "main.scene.json");
    const hard = scene.marks.find((m: { kind: string }) => m.kind === "hard");
    assert.equal(hard.count, 2, "two presses in the same place are one group");
    assert.match(hard.replay, /--take 1 --mark 1$/);
    assert.equal(scene.marks.find((m: { kind: string }) => m.kind === "note").notes[0], "I can't see the spike");
    assert.equal(scene.deaths[0].cause, "spike");
    assert.equal(scene.stopped.reduce((sum: number, g: { count: number }) => sum + g.count, 0), 2, "each session's last take shows where it stopped");

    const text = run("feedback", dir).out;
    assert.match(text, /too hard/);
    assert.match(text, /love this/);
    assert.match(text, /ludra replay .* --take/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps marks on older versions apart from the game as it is", async () => {
    const dir = makeGame();
    const project = loadProject(dir);
    await record(project, "20261101-120000-kkkkkk", [{ inputs: [[60, RIGHT]], marks: [[30, "boring"]] }]);
    writeFileSync(join(dir, "main.scene.json"), JSON.stringify({ entities: [ground, hero, goal] }));
    const json = JSON.parse(run("feedback", dir, "--json").out);
    assert.equal(json.scenes[0].current, 0);
    assert.equal(json.scenes[0].marks[0].older, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says so when nobody has played", () => {
    const dir = makeGame();
    assert.match(run("feedback", dir).out, /Nobody has played/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the dev server's recording endpoint", () => {
  let dir: string;
  let server: ChildProcess;
  const port = 5200 + Math.floor(Math.random() * 500);
  const url = `http://127.0.0.1:${port}/__ludra/recording`;
  const body = JSON.stringify({
    recording: { version: 1, session: "20261101-120000-llllll", game: "x", started: "t" },
    index: 0,
    take: { scene: "main.scene.json", version: "v", inputs: "right:1f", frames: 1, checks: [], score: 0, deathCount: 0, deaths: [], marks: [] },
  });

  before(async () => {
    dir = makeGame();
    server = spawn(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "dev", dir, "--port", String(port)], { stdio: "pipe" });
    await new Promise<void>((resolve) => server.stdout!.once("data", () => resolve()));
  });
  after(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("takes a take from its own page and nothing from anywhere else", async () => {
    const json = { "content-type": "application/json" };
    const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers, body }).then((r) => r.status);
    assert.equal(await post({ ...json, origin: "https://evil.example" }), 403);
    assert.equal(await post({ ...json, origin: `http://evil.example:${port}` }), 403);
    assert.equal(await post({ "content-type": "text/plain" }), 415);
    assert.equal(await fetch(url).then((r) => r.status), 405);
    assert.equal(existsSync(join(dir, "recordings")), false);
    assert.equal(await post({ ...json, origin: `http://127.0.0.1:${port}` }), 204);
    assert.equal(readdirSync(join(dir, "recordings")).length, 1);
  });
});

describe("the review", () => {
  it("hears what players said on this version, and a crash a player found is an issue", async () => {
    const dir = makeGame();
    const project = loadProject(dir);
    await record(project, "20261101-120000-mmmmmm", [{ inputs: [[60, RIGHT]], marks: [[30, "confusing"]] }]);
    const file = recordingPath(project, "20261101-120000-mmmmmm");
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
    recording.takes[0]!.end = "crashed";
    recording.takes[0]!.error = "boom in spike.ts";
    writeFileSync(file, JSON.stringify(recording));
    const { findings } = JSON.parse(run("review", dir, "--json", "--fast").out);
    const code = (c: string) => findings.find((f: { code: string }) => f.code === c);
    assert.equal(code("R_PLAYER_MARKS").level, "idea");
    assert.match(code("R_PLAYER_MARKS").message, /confusing/);
    assert.equal(code("R_PLAYER_CRASH").level, "issue");
    assert.equal(code("R_NO_PLAYTEST"), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a person's winning run isn't taken for the level's route", async () => {
    const dir = makeGame([ground, hero, goal]);
    const file = await record(loadProject(dir), "20261101-120000-nnnnnn", [{ inputs: [[400, RIGHT]] }]);
    run("replay", file, "--test");
    const test = JSON.parse(readFileSync(join(dir, "tests", "recordings.test.json"), "utf8")).tests[0];
    assert.ok(test.recording);
    assert.equal(run("review", dir, "--fast").code, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks for a playtest when there has been none", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludra-replay-"));
    cpSync(makeGame(), dir, { recursive: true });
    const { findings } = JSON.parse(run("review", dir, "--json", "--fast").out);
    assert.ok(findings.some((f: { code: string }) => f.code === "R_NO_PLAYTEST"));
    rmSync(dir, { recursive: true, force: true });
  });
});
