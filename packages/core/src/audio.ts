import { isSoundPreset, type SoundPreset } from "./effects.ts";

const MASTER_VOLUME = 0.5;

interface Tone {
  wave: OscillatorType;
  from: number;
  to?: number;
  start?: number;
  duration: number;
  volume: number;
}

interface Noise {
  duration: number;
  volume: number;
  /** Low-pass cutoff sweep in Hz. */
  from: number;
  to: number;
}

/** Each preset is a few short oscillator or noise layers, in the spirit of sfxr. */
const PRESETS: Record<SoundPreset, { tones?: Tone[]; noise?: Noise }> = {
  jump: { tones: [{ wave: "square", from: 280, to: 560, duration: 0.14, volume: 0.12 }] },
  coin: {
    tones: [
      { wave: "square", from: 988, duration: 0.07, volume: 0.1 },
      { wave: "square", from: 1319, start: 0.07, duration: 0.2, volume: 0.1 },
    ],
  },
  hit: {
    tones: [{ wave: "sawtooth", from: 220, to: 60, duration: 0.14, volume: 0.15 }],
    noise: { duration: 0.12, volume: 0.25, from: 3000, to: 300 },
  },
  explosion: { noise: { duration: 0.55, volume: 0.45, from: 1600, to: 60 } },
  powerup: {
    tones: [523, 659, 784, 1047].map((from, i) => ({ wave: "triangle" as const, from, start: i * 0.08, duration: 0.14, volume: 0.16 })),
  },
  blip: { tones: [{ wave: "sine", from: 880, duration: 0.06, volume: 0.15 }] },
  thud: { tones: [{ wave: "sine", from: 150, to: 50, duration: 0.1, volume: 0.3 }] },
};

/**
 * Plays presets and audio files. Browsers only allow audio after a user
 * gesture, so the context is created by `unlock()` on the first key press.
 */
export class SoundPlayer {
  muted = false;
  private context: AudioContext | undefined;
  private output: GainNode | undefined;
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly assetBase: string;

  constructor(assetBase: string) {
    this.assetBase = assetBase;
  }

  unlock(): void {
    if (this.context) return;
    this.context = new AudioContext();
    this.output = this.context.createGain();
    this.output.gain.value = MASTER_VOLUME;
    this.output.connect(this.context.destination);
  }

  play(sound: string): void {
    if (this.muted || !this.context || !this.output || sound === "") return;
    if (isSoundPreset(sound)) this.playPreset(this.context, this.output, sound);
    else void this.playFile(this.context, this.output, sound);
  }

  private playPreset(ac: AudioContext, out: AudioNode, preset: SoundPreset): void {
    const { tones = [], noise } = PRESETS[preset];
    for (const tone of tones) {
      const t = ac.currentTime + (tone.start ?? 0);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = tone.wave;
      osc.frequency.setValueAtTime(tone.from, t);
      osc.frequency.exponentialRampToValueAtTime(tone.to ?? tone.from, t + tone.duration);
      gain.gain.setValueAtTime(tone.volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + tone.duration);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + tone.duration + 0.02);
    }
    if (noise) {
      const t = ac.currentTime;
      const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * noise.duration), ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = ac.createBufferSource();
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      source.buffer = buffer;
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(noise.from, t);
      filter.frequency.exponentialRampToValueAtTime(noise.to, t + noise.duration);
      gain.gain.setValueAtTime(noise.volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + noise.duration);
      source.connect(filter).connect(gain).connect(out);
      source.start(t);
    }
  }

  private async playFile(ac: AudioContext, out: AudioNode, path: string): Promise<void> {
    let pending = this.buffers.get(path);
    if (!pending) {
      pending = fetch(this.assetBase + path)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${res.status}`))))
        .then((data) => ac.decodeAudioData(data))
        .catch((err: unknown) => {
          console.warn(`[ludra] could not load sound "${path}":`, err);
          return undefined;
        });
      this.buffers.set(path, pending);
    }
    const buffer = await pending;
    if (!buffer) return;
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    source.start();
  }
}
