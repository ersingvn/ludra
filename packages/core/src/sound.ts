import { AUDIO_EXTENSIONS, isSoundPreset, SOUND_PRESETS } from "./effects.ts";

export const WAVES = ["sine", "square", "sawtooth", "triangle"] as const;
export type Wave = (typeof WAVES)[number];
export const NOISE_FILTERS = ["lowpass", "highpass", "bandpass"] as const;

/** One oscillator layer of a sound: a pitch sweep with a quick attack and a fade out. */
export interface ToneDef {
  wave?: Wave;
  /** Start pitch in Hz. */
  from: number;
  /** End pitch in Hz (a sweep). Defaults to `from`. */
  to?: number;
  /** Delay in seconds before this layer starts. */
  start?: number;
  duration: number;
  volume?: number;
  /** Seconds to fade in. A little attack (0.005) softens clicks; more makes swells. */
  attack?: number;
}

/** A layer of filtered white noise: hits, whooshes, wind, rumble, steps. */
export interface NoiseDef {
  /** Filter frequency in Hz at the start and the end (a sweep). */
  from?: number;
  to?: number;
  filter?: (typeof NOISE_FILTERS)[number];
  start?: number;
  duration: number;
  volume?: number;
  attack?: number;
}

/** A sound of the game's own, synthesized at runtime from layers. */
export interface SoundDef {
  tones?: ToneDef[];
  noise?: NoiseDef[];
  /** Random pitch variation per play, 0..1 (0.1 = ±10%), so repeated sounds don't sound copied. */
  vary?: number;
  /** Overall volume multiplier. */
  volume?: number;
}

/** One voice of the music: a looping line of notes. */
export interface MusicTrack {
  /** An oscillator wave, or "noise" for percussion. */
  wave?: Wave | "noise";
  /**
   * One token per step, separated by spaces (`|` bar lines are ignored): a note like
   * "C4", "F#3" or "Bb2", a chord "C4+E4+G4", "-" for a rest, "~" to hold the previous
   * note one more step. Noise tracks use "x" (hit) and "X" (accent).
   */
  notes: string;
  volume?: number;
  /** How much of its length a note sounds before fading, 0..1. Low = staccato, 1 = legato. */
  decay?: number;
  /** Noise tracks: filter frequency in Hz (low = kick and rumble, high = hats). Tones: a low-pass cutoff to soften them. */
  filter?: number;
  /** Seconds to fade each note in. */
  attack?: number;
}

/** Music: an audio file to loop, or tracks of notes the engine plays in a loop. */
export interface MusicDef {
  /** An audio file to loop instead of tracks. */
  src?: string;
  /** Beats per minute. */
  tempo?: number;
  /** Steps (note tokens) per beat: 2 = eighth notes, 4 = sixteenths. */
  steps?: number;
  volume?: number;
  tracks?: MusicTrack[];
}

export const MUSIC_DEFAULTS = { tempo: 110, steps: 2, volume: 0.6 } as const;
export const TRACK_DEFAULTS = { wave: "triangle", volume: 0.15, decay: 0.8, attack: 0.005 } as const;

/** One step of a track: the pitches it starts (Hz; none for a rest), and how many steps it lasts. */
export interface MusicStep {
  /** Frequencies in Hz, or [] for a rest. Noise tracks use 1 (hit) or 2 (accent). */
  pitches: number[];
  /** Steps until the next note starts (a note plus its holds). */
  length: number;
}

const NOTE_OFFSETS: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** "A4" → 440. Returns undefined for anything that isn't a note. */
export function noteFrequency(note: string): number | undefined {
  const match = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note);
  if (!match) return undefined;
  const semitone = NOTE_OFFSETS[match[1]!.toUpperCase()]! + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  const octave = Number(match[3]);
  return 440 * 2 ** ((semitone + (octave - 4) * 12) / 12);
}

/** Splits a track's notes into steps. Throws an Error naming the bad token. */
export function parseNotes(notes: string, noise: boolean): MusicStep[] {
  const tokens = notes.split(/[\s|]+/).filter((t) => t !== "");
  const steps: MusicStep[] = [];
  tokens.forEach((token, i) => {
    if (token === "~") {
      if (steps.length === 0) throw new Error(`token 1 is "~", but there is no note before it to hold.`);
      steps.at(-1)!.length += 1;
      return;
    }
    if (token === "-") return void steps.push({ pitches: [], length: 1 });
    if (noise) {
      if (token !== "x" && token !== "X") throw new Error(`token ${i + 1} is "${token}". Noise tracks use "x" (hit), "X" (accent), "-" (rest) and "~" (hold).`);
      return void steps.push({ pitches: [token === "X" ? 2 : 1], length: 1 });
    }
    const pitches = token.split("+").map((note) => {
      const frequency = noteFrequency(note);
      if (frequency === undefined) throw new Error(`token ${i + 1} is "${token}": "${note}" is not a note. Use a letter, an optional # or b, and an octave: "C4", "F#3", "Bb2".`);
      return frequency;
    });
    steps.push({ pitches, length: 1 });
  });
  return steps;
}

/** How a scene names a sound in effects and ctx.play: a preset, one of its own `sounds`, or a file. */
export function isKnownSound(name: string, sounds: Record<string, unknown> | undefined): boolean {
  return isSoundPreset(name) || (sounds !== undefined && Object.hasOwn(sounds, name)) || AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

type Report = (code: string, path: string, message: string, fix?: string) => void;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value: unknown) => (typeof value === "string" ? `"${value}"` : JSON.stringify(value));

const SOUND_EXAMPLE =
  'Use "sounds": { "creak": { "tones": [{ "wave": "sawtooth", "from": 90, "to": 70, "duration": 0.3, "volume": 0.08 }], "noise": [{ "filter": "bandpass", "from": 900, "duration": 0.2, "volume": 0.1 }], "vary": 0.15 } }.';

function checkNumber(value: unknown, path: string, error: Report, min: number, max = Infinity, required = false): void {
  if (value === undefined) {
    if (required) error("E_INVALID_SOUND_DEF", path, `${path} is required.`);
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    error("E_INVALID_SOUND_DEF", path, `${path} must be a number${max === Infinity ? ` ≥ ${min}` : ` from ${min} to ${max}`}, got ${show(value)}.`);
  }
}

function checkKeys(layer: Record<string, unknown>, allowed: readonly string[], path: string, error: Report): void {
  for (const key of Object.keys(layer)) {
    if (!allowed.includes(key)) error("E_INVALID_SOUND_DEF", `${path}.${key}`, `"${key}" is not a field here. Fields: ${allowed.join(", ")}.`);
  }
}

/** Validates scene `sounds`: each a SoundDef or an audio file path. */
export function validateSounds(sounds: unknown, error: Report): void {
  if (!isObject(sounds)) return void error("E_SOUNDS_NOT_OBJECT", "sounds", '"sounds" must map sound names to sound definitions or audio files.', SOUND_EXAMPLE);
  for (const [name, def] of Object.entries(sounds)) {
    const path = `sounds.${name}`;
    if (isSoundPreset(name)) {
      error("E_INVALID_SOUND_DEF", path, `"${name}" is a built-in preset name. Give your own sound its own name.`, `Presets are ${SOUND_PRESETS.join(", ")}.`);
      continue;
    }
    if (typeof def === "string") {
      if (!AUDIO_EXTENSIONS.some((ext) => def.toLowerCase().endsWith(ext))) error("E_INVALID_SOUND_DEF", path, `${path} must be an audio file (${AUDIO_EXTENSIONS.join(", ")}) or a sound definition, got ${show(def)}.`, SOUND_EXAMPLE);
      continue;
    }
    if (!isObject(def)) {
      error("E_INVALID_SOUND_DEF", path, `${path} must be a sound definition or an audio file.`, SOUND_EXAMPLE);
      continue;
    }
    checkKeys(def, ["tones", "noise", "vary", "volume"], path, error);
    checkNumber(def.vary, `${path}.vary`, error, 0, 1);
    checkNumber(def.volume, `${path}.volume`, error, 0);
    const tones = def.tones ?? [];
    const noise = def.noise ?? [];
    if (!Array.isArray(tones)) error("E_INVALID_SOUND_DEF", `${path}.tones`, `${path}.tones must be a list of tone layers.`, SOUND_EXAMPLE);
    if (!Array.isArray(noise)) error("E_INVALID_SOUND_DEF", `${path}.noise`, `${path}.noise must be a list of noise layers.`, SOUND_EXAMPLE);
    if (Array.isArray(tones) && Array.isArray(noise) && tones.length + noise.length === 0) {
      error("E_INVALID_SOUND_DEF", path, `${path} has no layers, so it is silent.`, SOUND_EXAMPLE);
    }
    if (Array.isArray(tones)) {
      tones.forEach((tone, i) => {
        const at = `${path}.tones[${i}]`;
        if (!isObject(tone)) return void error("E_INVALID_SOUND_DEF", at, `${at} must be an object.`, SOUND_EXAMPLE);
        checkKeys(tone, ["wave", "from", "to", "start", "duration", "volume", "attack"], at, error);
        if (tone.wave !== undefined && !(WAVES as readonly unknown[]).includes(tone.wave)) error("E_INVALID_SOUND_DEF", `${at}.wave`, `${at}.wave must be one of ${WAVES.join(", ")}, got ${show(tone.wave)}.`);
        checkNumber(tone.from, `${at}.from`, error, 1, 24000, true);
        checkNumber(tone.to, `${at}.to`, error, 1, 24000);
        checkNumber(tone.start, `${at}.start`, error, 0);
        checkNumber(tone.duration, `${at}.duration`, error, 0.001, 30, true);
        checkNumber(tone.volume, `${at}.volume`, error, 0, 1);
        checkNumber(tone.attack, `${at}.attack`, error, 0);
      });
    }
    if (Array.isArray(noise)) {
      noise.forEach((layer, i) => {
        const at = `${path}.noise[${i}]`;
        if (!isObject(layer)) return void error("E_INVALID_SOUND_DEF", at, `${at} must be an object.`, SOUND_EXAMPLE);
        checkKeys(layer, ["from", "to", "filter", "start", "duration", "volume", "attack"], at, error);
        if (layer.filter !== undefined && !(NOISE_FILTERS as readonly unknown[]).includes(layer.filter)) error("E_INVALID_SOUND_DEF", `${at}.filter`, `${at}.filter must be one of ${NOISE_FILTERS.join(", ")}, got ${show(layer.filter)}.`);
        checkNumber(layer.from, `${at}.from`, error, 1, 24000);
        checkNumber(layer.to, `${at}.to`, error, 1, 24000);
        checkNumber(layer.start, `${at}.start`, error, 0);
        checkNumber(layer.duration, `${at}.duration`, error, 0.001, 30, true);
        checkNumber(layer.volume, `${at}.volume`, error, 0, 1);
        checkNumber(layer.attack, `${at}.attack`, error, 0);
      });
    }
  }
}

const MUSIC_EXAMPLE =
  'Use "music": { "tempo": 96, "tracks": [{ "wave": "triangle", "notes": "C4 E4 G4 E4 | A3 C4 E4 ~" }, { "wave": "noise", "filter": 120, "notes": "x - - - x - - -" }] }, or "music": "assets/theme.ogg".';

/** Validates scene `music`: an audio file path or a MusicDef. */
export function validateMusic(music: unknown, error: Report): void {
  if (typeof music === "string") {
    if (!AUDIO_EXTENSIONS.some((ext) => music.toLowerCase().endsWith(ext))) error("E_INVALID_MUSIC", "music", `"music" must be an audio file (${AUDIO_EXTENSIONS.join(", ")}) or a music definition, got ${show(music)}.`, MUSIC_EXAMPLE);
    return;
  }
  if (!isObject(music)) return void error("E_INVALID_MUSIC", "music", '"music" must be an audio file or a music definition.', MUSIC_EXAMPLE);
  checkKeys(music, ["src", "tempo", "steps", "volume", "tracks"], "music", error);
  const report: Report = (_code, path, message, fix) => error("E_INVALID_MUSIC", path, message, fix);
  checkNumber(music.tempo, "music.tempo", report, 20, 400);
  checkNumber(music.steps, "music.steps", report, 1, 16);
  checkNumber(music.volume, "music.volume", report, 0, 2);
  if (music.src !== undefined && (typeof music.src !== "string" || !AUDIO_EXTENSIONS.some((ext) => music.src!.toString().toLowerCase().endsWith(ext)))) {
    error("E_INVALID_MUSIC", "music.src", `music.src must be an audio file (${AUDIO_EXTENSIONS.join(", ")}), got ${show(music.src)}.`);
  }
  if (music.src === undefined && music.tracks === undefined) return void error("E_INVALID_MUSIC", "music", '"music" needs "tracks" (or "src", an audio file).', MUSIC_EXAMPLE);
  if (music.tracks === undefined) return;
  if (!Array.isArray(music.tracks) || music.tracks.length === 0) return void error("E_INVALID_MUSIC", "music.tracks", "music.tracks must be a non-empty list of tracks.", MUSIC_EXAMPLE);
  music.tracks.forEach((track, i) => {
    const at = `music.tracks[${i}]`;
    if (!isObject(track)) return void error("E_INVALID_MUSIC", at, `${at} must be an object.`, MUSIC_EXAMPLE);
    checkKeys(track, ["wave", "notes", "volume", "decay", "filter", "attack"], at, report);
    if (track.wave !== undefined && track.wave !== "noise" && !(WAVES as readonly unknown[]).includes(track.wave)) {
      error("E_INVALID_MUSIC", `${at}.wave`, `${at}.wave must be one of ${[...WAVES, "noise"].join(", ")}, got ${show(track.wave)}.`);
    }
    checkNumber(track.volume, `${at}.volume`, report, 0, 1);
    checkNumber(track.decay, `${at}.decay`, report, 0.01, 1);
    checkNumber(track.filter, `${at}.filter`, report, 1, 24000);
    checkNumber(track.attack, `${at}.attack`, report, 0);
    if (typeof track.notes !== "string") return void error("E_INVALID_MUSIC", `${at}.notes`, `${at}.notes must be a string of notes.`, MUSIC_EXAMPLE);
    try {
      if (parseNotes(track.notes, track.wave === "noise").length === 0) error("E_INVALID_MUSIC", `${at}.notes`, `${at}.notes has no notes.`, MUSIC_EXAMPLE);
    } catch (err) {
      error("E_INVALID_MUSIC", `${at}.notes`, `${at}.notes: ${(err as Error).message}`);
    }
  });
}

/** Printed by `ludra components sounds`. */
export const SOUND_REFERENCE = `Sound has no limits: presets are a starting point, not the palette.

"sounds" (scene level): the game's own sounds, synthesized at runtime from layers. Use their names in
"effects" ("sound": "creak") and in scripts (ctx.play("creak")). A value can also be an audio file path.
  "sounds": {
    "creak": {
      "tones": [{ "wave": "sawtooth", "from": 95, "to": 70, "duration": 0.35, "volume": 0.07, "attack": 0.03 }],
      "noise": [{ "filter": "bandpass", "from": 1200, "to": 700, "duration": 0.3, "volume": 0.05 }],
      "vary": 0.15
    },
    "door": "assets/door.ogg"
  }
  tone layer   wave (sine square sawtooth triangle), from/to Hz (a sweep), start s, duration s, volume 0..1, attack s
  noise layer  filter (lowpass highpass bandpass), from/to filter Hz, start s, duration s, volume 0..1, attack s
  vary         random pitch per play, 0..1 (0.1 = ±10%): repeated sounds stop sounding copied
  volume       overall multiplier
Built-in presets (${SOUND_PRESETS.join(", ")}) are generic and the same in every Ludra game.

"music" (scene level): loops while the scene plays. An audio file ("music": "assets/theme.ogg"), or tracks:
  "music": {
    "tempo": 92, "steps": 2, "volume": 0.6,
    "tracks": [
      { "wave": "triangle", "volume": 0.12, "notes": "E4 G4 B4 G4 | C5 B4 G4 ~ | A4 ~ F#4 ~ | G4 ~ ~ -" },
      { "wave": "sine", "volume": 0.18, "decay": 1, "notes": "E2 ~ ~ ~ | C2 ~ ~ ~ | D2 ~ ~ ~ | G2 ~ ~ ~" },
      { "wave": "square", "volume": 0.04, "filter": 1800, "notes": "E4+G4+B4 - - - | C4+E4+G4 - - -" },
      { "wave": "noise", "filter": 140, "volume": 0.3, "notes": "X - - - x - - -" },
      { "wave": "noise", "filter": 7000, "volume": 0.05, "decay": 0.2, "notes": "- x - x - x - x" }
    ]
  }
  tempo        beats per minute (110)          steps   tokens per beat (2 = eighths, 4 = sixteenths)
  notes        one token per step: "C4" "F#3" "Bb2", a chord "C4+E4+G4", "-" rest, "~" hold one more step,
               "|" bar lines are ignored. Noise tracks: "x" hit, "X" accent. Each track loops on its own.
  decay        how much of its length a note sounds, 0..1 (0.8)    filter  noise: filter Hz; tones: low-pass Hz
  attack       seconds to fade each note in                        volume  per track (0.15)
Write music for the mood: a key, a tempo, a bass line, a melody that returns. Different scenes can have
different music; the same music carries on across a scene change.

Scripts: the sound hook gets the real Web Audio API, so anything is possible (engines that rise with
speed, wind that follows the player's height, layered adaptive music, granular textures).
  sound(ctx) {}  runs every rendered frame in the browser, once the player has pressed a key
  ctx.audio      the AudioContext: oscillators, filters, convolvers, buffers, ctx.audio.currentTime
  ctx.out        connect your nodes here (the scene's bus: muting and scene changes are handled)
  ctx.events     game events since the last call [{ name, time, x, y, entity, data }]
  ctx.play(name, { volume?, pitch? })   a preset, a scene sound or a file (pitch 2 = an octave up)
  ctx.self, ctx.world, ctx.params, ctx.time, ctx.random()   read-only, as in draw hooks
  ctx.local      memory for your nodes (keep long-lived oscillators here and update them each frame)
Sound never changes the game, so tests stay valid.`;
