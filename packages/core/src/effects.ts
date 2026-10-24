import type { FieldSpec } from "./components.ts";
import type { SceneDef } from "./types.ts";

/** Sounds synthesized at runtime, so a game needs no audio files to have sound. */
export const SOUND_PRESETS = ["jump", "coin", "hit", "explosion", "powerup", "blip", "thud"] as const;
export type SoundPreset = (typeof SOUND_PRESETS)[number];

export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg"] as const;
export const IMAGE_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

export const EFFECT_FIELDS: Record<string, FieldSpec> = {
  sound: {
    type: "string",
    default: "",
    description: `A preset (${SOUND_PRESETS.join(", ")}) or an audio file path relative to the project (${AUDIO_EXTENSIONS.join(", ")}).`,
  },
  shake: { type: "number", min: 0, default: 0, description: "Screen shake strength in pixels." },
};

export const EFFECTS_DESCRIPTION =
  'Scene-level "effects" map a game event (jump, land, collect, die, stomp, win) to feedback: a particle burst at the event position, a sound and a screen shake. They never affect gameplay.';

export function isSoundPreset(sound: string): sound is SoundPreset {
  return (SOUND_PRESETS as readonly string[]).includes(sound);
}

export interface AssetReference {
  /** Path relative to the project, as written in the scene. */
  path: string;
  /** JSON path of the field that references it. */
  at: string;
  kind: "image" | "audio";
}

/** Every file a scene points at, so tools can check that they exist. */
export function collectAssetPaths(scene: SceneDef): AssetReference[] {
  const refs: AssetReference[] = [];
  scene.entities.forEach((entity, i) => {
    const image = entity.components.sprite?.image;
    if (typeof image === "string" && image !== "") refs.push({ path: image, at: `entities[${i}].components.sprite.image`, kind: "image" });
  });
  for (const [event, effect] of Object.entries(scene.effects ?? {})) {
    const sound = effect?.sound;
    if (typeof sound === "string" && sound !== "" && !isSoundPreset(sound)) refs.push({ path: sound, at: `effects.${event}.sound`, kind: "audio" });
  }
  return refs;
}
