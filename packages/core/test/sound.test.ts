import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkDrawHooks, collectAssetPaths, noteFrequency, parseNotes, ScriptError, validateScene, validateScriptModule, World, type SceneDef, type Script } from "../src/index.ts";

const codes = (scene: unknown) =>
  validateScene(scene)
    .diagnostics.filter((d) => d.code !== "W_NO_PLAYER")
    .map((d) => `${d.code} ${d.path}`);

const creak = {
  tones: [{ wave: "sawtooth", from: 95, to: 70, duration: 0.35, volume: 0.07, attack: 0.03 }],
  noise: [{ filter: "bandpass", from: 1200, to: 700, duration: 0.3, volume: 0.05 }],
  vary: 0.15,
};

describe("notes", () => {
  test("note names become frequencies", () => {
    assert.equal(noteFrequency("A4"), 440);
    assert.equal(noteFrequency("A5"), 880);
    assert.ok(Math.abs(noteFrequency("C4")! - 261.63) < 0.01);
    assert.equal(noteFrequency("F#3"), noteFrequency("Gb3"));
    assert.equal(noteFrequency("H4"), undefined);
  });

  test("tokens are notes, chords, rests and holds; bar lines are ignored", () => {
    const steps = parseNotes("C4 ~ - | E4+G4 ~ ~", false);
    assert.deepEqual(
      steps.map((s) => [s.pitches.length, s.length]),
      [
        [1, 2],
        [0, 1],
        [2, 3],
      ],
    );
    assert.deepEqual(
      parseNotes("X - x x", true).map((s) => s.pitches),
      [[2], [], [1], [1]],
    );
  });

  test("a bad token is named with where it is and what to write", () => {
    assert.throws(() => parseNotes("C4 E4 Q9", false), /token 3 is "Q9".*"C4", "F#3", "Bb2"/);
    assert.throws(() => parseNotes("~ C4", false), /no note before it/);
    assert.throws(() => parseNotes("x o", true), /token 2 is "o"/);
  });
});

describe("scene sounds and music", () => {
  test("the game's own sounds and music validate, and effects can use them", () => {
    const scene = {
      sounds: { creak, door: "assets/door.ogg" },
      music: { tempo: 92, tracks: [{ wave: "triangle", notes: "E4 G4 B4 ~" }, { wave: "noise", filter: 140, notes: "X - x -" }] },
      effects: { land: { sound: "creak" }, collect: { sound: "door" }, jump: { sound: "jump" } },
      entities: [],
    };
    assert.deepEqual(codes(scene), []);
  });

  test("mistakes in a sound definition point at the field", () => {
    const scene = {
      sounds: {
        jump: creak,
        silent: {},
        bad: { tones: [{ wave: "saw", from: 0, duration: 0.2 }], noise: [{ filter: "notch", duration: 0.1, pitch: 2 }] },
        file: "assets/door.txt",
      },
      entities: [],
    };
    assert.deepEqual(codes(scene), [
      "E_INVALID_SOUND_DEF sounds.jump",
      "E_INVALID_SOUND_DEF sounds.silent",
      "E_INVALID_SOUND_DEF sounds.bad.tones[0].wave",
      "E_INVALID_SOUND_DEF sounds.bad.tones[0].from",
      "E_INVALID_SOUND_DEF sounds.bad.noise[0].pitch",
      "E_INVALID_SOUND_DEF sounds.bad.noise[0].filter",
      "E_INVALID_SOUND_DEF sounds.file",
    ]);
  });

  test("an effect naming an unknown sound suggests the scene's own", () => {
    const result = validateScene({ sounds: { creak }, effects: { land: { sound: "creek" } }, entities: [] });
    const d = result.diagnostics.find((x) => x.code === "E_INVALID_SOUND")!;
    assert.equal(d.path, "effects.land.sound");
    assert.match(d.fix!, /Did you mean "creak"\?.*Scene sounds: creak/);
  });

  test("bad music names the track and token", () => {
    assert.deepEqual(codes({ music: { tempo: 900, tracks: [{ wave: "organ", notes: "C4 Z4" }] }, entities: [] }), [
      "E_INVALID_MUSIC music.tempo",
      "E_INVALID_MUSIC music.tracks[0].wave",
      "E_INVALID_MUSIC music.tracks[0].notes",
    ]);
    assert.deepEqual(codes({ music: "assets/theme.txt", entities: [] }), ["E_INVALID_MUSIC music"]);
    assert.deepEqual(codes({ music: {}, entities: [] }), ["E_INVALID_MUSIC music"]);
  });

  test("audio files in sounds and music are listed as assets", () => {
    const scene: SceneDef = { sounds: { creak: creak as never, door: "assets/door.ogg" }, music: "assets/theme.ogg", effects: { land: { sound: "creak" } }, entities: [] };
    assert.deepEqual(
      collectAssetPaths(scene).map((r) => `${r.kind} ${r.path} ${r.at}`),
      ["audio assets/door.ogg sounds.door", "audio assets/theme.ogg music"],
    );
  });
});

describe("the sound hook", () => {
  const scripts = (script: Script) => new Map([["scripts/engine.ts", script]]);
  const scene: SceneDef = { entities: [{ id: "car", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/engine.ts" } } }] };

  test("is a known hook", () => {
    assert.deepEqual(validateScriptModule({ default: { sound() {} } }, "scripts/engine.ts"), []);
  });

  test("gets the audio context and the events since its last call, and can't change the game", () => {
    let heard: string[] = [];
    const world = new World(scene, {
      scripts: scripts({
        sound: ({ audio, out, events, self }) => {
          heard = events.map((e) => e.name);
          assert.equal((audio as unknown as { tag: string }).tag, "audio");
          assert.equal((out as unknown as { tag: string }).tag, "bus");
          self.x = 5;
        },
      }),
    });
    const fake = (tag: string) => ({ tag }) as never;
    const extras = { audio: fake("audio"), out: fake("bus"), time: 0, events: [{ name: "boom", time: 0, x: 0, y: 0, entity: "car" }], play: () => {}, local: {}, random: () => 0.5 };
    assert.throws(
      () => world.callSoundHook(world.get("car")!, extras),
      (err: unknown) => err instanceof ScriptError && /Setting x changes the game, which a sound hook can't do/.test(err.message),
    );
    assert.deepEqual(heard, ["boom"]);
  });

  test("ludra check runs it against a stand-in AudioContext and reports errors", () => {
    const fine = checkDrawHooks(scene, scripts({
      sound: ({ audio, out, local }) => {
        if (!local.osc) {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.frequency.value = 110;
          osc.connect(gain).connect(out);
          osc.start();
          local.osc = osc;
        }
        (local.osc as OscillatorNode).frequency.setTargetAtTime(220, audio.currentTime, 0.1);
      },
    }));
    assert.deepEqual(fine, []);
    const broken = checkDrawHooks(scene, scripts({ sound: ({ local }) => (local.osc as OscillatorNode).stop() }));
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.code, "E_SOUND_HOOK");
    assert.equal(broken[0]!.path, "scripts/engine.ts → sound");
  });

  test("never runs in the simulation, so tests stay the same", () => {
    let calls = 0;
    const world = new World(scene, { scripts: scripts({ sound: () => void calls++ }) });
    for (let i = 0; i < 30; i++) world.step(new Set());
    assert.equal(calls, 0);
  });
});
