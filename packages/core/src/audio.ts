import { isSoundPreset, type SoundPreset } from "./effects.ts";
import { MUSIC_DEFAULTS, parseNotes, TRACK_DEFAULTS, type MusicDef, type MusicStep, type MusicTrack, type NoiseDef, type SoundDef, type ToneDef } from "./sound.ts";

const MASTER_VOLUME = 0.8;
/** How far ahead music notes are scheduled, in seconds. Covers a dropped frame or two. */
const LOOKAHEAD = 0.25;
/** Fade when a scene's sounds or music stop, in seconds. */
const FADE = 0.25;
/** Noise tracks at or below this filter frequency are kicks: they also get a falling sine thump. */
const KICK_FILTER = 250;
/** Noise tracks at or above this filter frequency are hats: high-passed instead of low-passed. */
const HAT_FILTER = 3000;

/** Each preset is a few short oscillator or noise layers, in the spirit of sfxr. */
const PRESETS: Record<SoundPreset, SoundDef> = {
  jump: { tones: [{ wave: "square", from: 280, to: 560, duration: 0.14, volume: 0.12 }] },
  coin: {
    tones: [
      { wave: "square", from: 988, duration: 0.07, volume: 0.1 },
      { wave: "square", from: 1319, start: 0.07, duration: 0.2, volume: 0.1 },
    ],
  },
  hit: {
    tones: [{ wave: "sawtooth", from: 220, to: 60, duration: 0.14, volume: 0.15 }],
    noise: [{ duration: 0.12, volume: 0.25, from: 3000, to: 300 }],
  },
  explosion: { noise: [{ duration: 0.55, volume: 0.45, from: 1600, to: 60 }] },
  powerup: {
    tones: [523, 659, 784, 1047].map((from, i) => ({ wave: "triangle" as const, from, start: i * 0.08, duration: 0.14, volume: 0.16 })),
  },
  blip: { tones: [{ wave: "sine", from: 880, duration: 0.06, volume: 0.15 }] },
  thud: { tones: [{ wave: "sine", from: 150, to: 50, duration: 0.1, volume: 0.3 }] },
};

interface PlayingMusic {
  key: string;
  gain: GainNode;
  stop(): void;
  /** Schedules what is due; called every frame. */
  tick(): void;
}

/**
 * Plays sounds (presets, a scene's own `sounds`, audio files) and music, and gives
 * `sound` hooks a bus to connect to. Browsers only allow audio after a user gesture,
 * so the context is created by `unlock()` on the first key press.
 *
 * master ← bus (this scene's sounds and script nodes; replaced on restart and scene change)
 *        ← music (kept across scenes that play the same music)
 */
export class SoundPlayer {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private bus: GainNode | undefined;
  private music: PlayingMusic | undefined;
  private muteFlag = false;
  private sounds: Record<string, SoundDef | string> = {};
  private musicDef: string | MusicDef | undefined;
  private noiseBuffer: AudioBuffer | undefined;
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly assetBase: string;

  constructor(assetBase: string) {
    this.assetBase = assetBase;
  }

  get muted(): boolean {
    return this.muteFlag;
  }

  set muted(value: boolean) {
    this.muteFlag = value;
    if (this.context && this.master) this.master.gain.setTargetAtTime(value ? 0 : MASTER_VOLUME, this.context.currentTime, 0.02);
  }

  /** The AudioContext, once the player has pressed a key. */
  get audio(): AudioContext | undefined {
    return this.context;
  }

  /** Where this scene's sounds and script nodes connect. */
  get out(): AudioNode | undefined {
    return this.bus;
  }

  unlock(): void {
    if (this.context) return;
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = this.muteFlag ? 0 : MASTER_VOLUME;
    // A gentle compressor glues music and effects together and keeps big moments from clipping.
    const glue = this.context.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 12;
    glue.ratio.value = 4;
    glue.attack.value = 0.005;
    glue.release.value = 0.2;
    this.master.connect(glue).connect(this.context.destination);
    this.bus = this.newBus();
    this.startMusic();
  }

  /**
   * A scene starts (or restarts): its own sounds and music. Sounds still ringing from the
   * last run fade out; the same music carries on, different music crossfades.
   */
  setScene(sounds: Record<string, SoundDef | string> | undefined, music: string | MusicDef | undefined): void {
    this.sounds = sounds ?? {};
    this.musicDef = music;
    if (!this.context) return;
    const old = this.bus;
    this.bus = this.newBus();
    if (old) this.fadeOut(old);
    this.startMusic();
  }

  /** Plays a preset, one of the scene's sounds or an audio file. `pitch` 2 is an octave up. */
  play(name: string, options: { volume?: number; pitch?: number } = {}): void {
    const ac = this.context;
    const out = this.bus;
    if (!ac || !out || name === "") return;
    const volume = options.volume ?? 1;
    const pitch = options.pitch ?? 1;
    const own = Object.hasOwn(this.sounds, name) ? this.sounds[name] : undefined;
    if (typeof own === "string") void this.playFile(ac, out, own, volume, pitch);
    else if (own) this.playDef(ac, out, own, ac.currentTime, volume, pitch);
    else if (isSoundPreset(name)) this.playDef(ac, out, PRESETS[name], ac.currentTime, volume, pitch);
    else void this.playFile(ac, out, name, volume, pitch);
  }

  /** Called every rendered frame: keeps the music scheduled ahead. */
  tick(): void {
    this.music?.tick();
  }

  private newBus(): GainNode {
    const bus = this.context!.createGain();
    bus.connect(this.master!);
    return bus;
  }

  private fadeOut(node: GainNode): void {
    const t = this.context!.currentTime;
    node.gain.setValueAtTime(node.gain.value, t);
    node.gain.linearRampToValueAtTime(0, t + FADE);
    setTimeout(() => node.disconnect(), (FADE + 0.1) * 1000);
  }

  private startMusic(): void {
    const ac = this.context;
    if (!ac) return;
    const key = this.musicDef === undefined ? "" : JSON.stringify(this.musicDef);
    if (this.music?.key === key) return;
    if (this.music) {
      this.music.stop();
      this.fadeOut(this.music.gain);
      this.music = undefined;
    }
    const def = this.musicDef;
    if (def === undefined) return;
    const gain = ac.createGain();
    gain.connect(this.master!);
    const file = typeof def === "string" ? def : def.src;
    if (file !== undefined) {
      gain.gain.value = typeof def === "string" ? MUSIC_DEFAULTS.volume : (def.volume ?? MUSIC_DEFAULTS.volume);
      let source: AudioBufferSourceNode | undefined;
      let stopped = false;
      void this.load(file).then((buffer) => {
        if (!buffer || stopped) return;
        source = ac.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
      });
      this.music = {
        key,
        gain,
        stop: () => {
          stopped = true;
          source?.stop(ac.currentTime + FADE);
        },
        tick: () => {},
      };
      return;
    }
    const tracks = def as MusicDef;
    gain.gain.value = tracks.volume ?? MUSIC_DEFAULTS.volume;
    this.music = this.sequence(ac, gain, tracks, key);
  }

  /** Plays tracks of notes in a loop, each track on its own, scheduled a little ahead. */
  private sequence(ac: AudioContext, gain: GainNode, def: MusicDef, key: string): PlayingMusic {
    const stepTime = 60 / (def.tempo ?? MUSIC_DEFAULTS.tempo) / (def.steps ?? MUSIC_DEFAULTS.steps);
    const start = ac.currentTime + 0.05;
    const voices = (def.tracks ?? []).map((track) => {
      let steps: MusicStep[] = [];
      try {
        steps = parseNotes(track.notes, track.wave === "noise");
      } catch {
        // `ludra check` reports bad notes; a bad track stays silent here.
      }
      return { track, steps, index: 0, next: start };
    });
    let stopped = false;
    return {
      key,
      gain,
      stop: () => {
        stopped = true;
      },
      tick: () => {
        if (stopped) return;
        const horizon = ac.currentTime + LOOKAHEAD;
        for (const voice of voices) {
          if (voice.steps.length === 0) continue;
          // After the tab was hidden, skip ahead instead of playing every missed note at once.
          if (voice.next < ac.currentTime - LOOKAHEAD) voice.next = ac.currentTime;
          while (voice.next < horizon) {
            const step = voice.steps[voice.index]!;
            const duration = step.length * stepTime;
            if (step.pitches.length > 0) this.playNote(ac, gain, voice.track, step.pitches, voice.next, duration);
            voice.next += duration;
            voice.index = (voice.index + 1) % voice.steps.length;
          }
        }
      },
    };
  }

  private playNote(ac: AudioContext, out: AudioNode, track: MusicTrack, pitches: number[], t: number, duration: number): void {
    const volume = track.volume ?? TRACK_DEFAULTS.volume;
    const length = Math.max(0.02, duration * (track.decay ?? TRACK_DEFAULTS.decay));
    const attack = track.attack ?? TRACK_DEFAULTS.attack;
    if (track.wave === "noise") {
      const accent = pitches[0] === 2 ? 1.6 : 1;
      const filter = track.filter ?? 1200;
      this.playNoise(ac, out, { filter: filter >= HAT_FILTER ? "highpass" : "lowpass", from: filter, duration: length, volume: volume * accent, attack: 0 }, t, 1);
      if (filter <= KICK_FILTER) this.playTone(ac, out, { wave: "sine", from: 150, to: 45, duration: Math.min(length, 0.3), volume: Math.min(1, volume * accent * 1.2) }, t, 1);
      return;
    }
    for (const frequency of pitches) {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      osc.type = track.wave ?? TRACK_DEFAULTS.wave;
      osc.frequency.setValueAtTime(frequency, t);
      envelope(env.gain, t, attack, length, volume / Math.sqrt(pitches.length));
      if (track.filter !== undefined) {
        const lowpass = ac.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = track.filter;
        osc.connect(lowpass).connect(env).connect(out);
      } else osc.connect(env).connect(out);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  }

  private playDef(ac: AudioContext, out: AudioNode, def: SoundDef, t: number, volume: number, pitch: number): void {
    // A little variety per play: footsteps and hits that never repeat exactly.
    const vary = def.vary ? 1 + (Math.random() * 2 - 1) * def.vary : 1;
    const gain = volume * (def.volume ?? 1);
    for (const tone of def.tones ?? []) this.playTone(ac, out, { ...tone, volume: (tone.volume ?? 0.15) * gain }, t, pitch * vary);
    for (const noise of def.noise ?? []) this.playNoise(ac, out, { ...noise, volume: (noise.volume ?? 0.2) * gain }, t, pitch * vary);
  }

  private playTone(ac: AudioContext, out: AudioNode, tone: ToneDef, at: number, pitch: number): void {
    const t = at + (tone.start ?? 0);
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = tone.wave ?? "sine";
    osc.frequency.setValueAtTime(tone.from * pitch, t);
    if (tone.to !== undefined && tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to * pitch, t + tone.duration);
    envelope(env.gain, t, tone.attack ?? 0.003, tone.duration, tone.volume ?? 0.15);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + tone.duration + 0.05);
  }

  private playNoise(ac: AudioContext, out: AudioNode, noise: NoiseDef, at: number, pitch: number): void {
    const t = at + (noise.start ?? 0);
    const buffer = this.noise(ac);
    const source = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const env = ac.createGain();
    source.buffer = buffer;
    source.loop = true;
    filter.type = noise.filter ?? "lowpass";
    const from = (noise.from ?? 3000) * pitch;
    filter.frequency.setValueAtTime(from, t);
    if (noise.to !== undefined && noise.to !== noise.from) filter.frequency.exponentialRampToValueAtTime(noise.to * pitch, t + noise.duration);
    envelope(env.gain, t, noise.attack ?? 0.002, noise.duration, noise.volume ?? 0.2);
    source.connect(filter).connect(env).connect(out);
    // A random point in the shared buffer, so two hits never sound identical.
    source.start(t, Math.random() * buffer.duration);
    source.stop(t + noise.duration + 0.05);
  }

  private noise(ac: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      this.noiseBuffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  private load(path: string): Promise<AudioBuffer | undefined> {
    let pending = this.buffers.get(path);
    if (!pending) {
      const ac = this.context!;
      pending = fetch(this.assetBase + path)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${res.status}`))))
        .then((data) => ac.decodeAudioData(data))
        .catch((err: unknown) => {
          console.warn(`[ludra] could not load sound "${path}":`, err);
          return undefined;
        });
      this.buffers.set(path, pending);
    }
    return pending;
  }

  private async playFile(ac: AudioContext, out: AudioNode, path: string, volume: number, pitch: number): Promise<void> {
    const buffer = await this.load(path);
    if (!buffer) return;
    const source = ac.createBufferSource();
    const gain = ac.createGain();
    source.buffer = buffer;
    source.playbackRate.value = pitch;
    gain.gain.value = volume;
    source.connect(gain).connect(out);
    source.start();
  }
}

/** Fade in over `attack`, then fall away to silence by `duration`. */
function envelope(param: AudioParam, t: number, attack: number, duration: number, volume: number): void {
  const peak = Math.max(0.0002, volume);
  const rise = Math.min(attack, duration * 0.9);
  param.setValueAtTime(0.0001, t);
  if (rise > 0) param.linearRampToValueAtTime(peak, t + rise);
  else param.setValueAtTime(peak, t);
  param.exponentialRampToValueAtTime(0.0001, t + duration);
}
