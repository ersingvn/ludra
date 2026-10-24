import {
  COMPONENT_NAMES,
  COMPONENTS,
  EFFECT_FIELDS,
  EFFECTS_DESCRIPTION,
  EVENT_TYPES,
  isComponentName,
  PARTICLE_FIELDS,
  SCRIPT_API_REFERENCE,
  SOUND_PRESETS,
  type FieldSpec,
} from "@ludra/core";
import { pad, paint } from "../format.ts";
import { CliError } from "../project.ts";

const EFFECTS_EXAMPLE = `"effects": {
    "collect": { "sound": "coin", "particles": { "count": 12, "color": "#ffd166", "speed": 140 } },
    "die": { "sound": "explosion", "shake": 8, "particles": { "count": 24, "color": "#ff5d73" } }
  }`;

export function components(name: string | undefined, options: { json?: boolean }): number {
  if (name !== undefined && name !== "effects" && !isComponentName(name)) {
    throw new CliError(`Unknown component "${name}". Components: ${COMPONENT_NAMES.join(", ")}, plus "effects" for scene effects.`);
  }
  const names = name === undefined ? COMPONENT_NAMES : isComponentName(name) ? [name] : [];
  const showEffects = name === undefined || name === "effects";

  if (options.json) {
    const effects = { description: EFFECTS_DESCRIPTION, events: EVENT_TYPES, soundPresets: SOUND_PRESETS, fields: EFFECT_FIELDS, particles: PARTICLE_FIELDS };
    const output = Object.fromEntries(names.map((n) => [n, COMPONENTS[n]]));
    console.log(JSON.stringify(showEffects ? { ...output, effects } : output, null, 2));
    return 0;
  }

  for (const n of names) {
    const spec = COMPONENTS[n];
    console.log(`${paint("bold", n)} — ${spec.description}`);
    if (spec.requires?.length) console.log(paint("dim", `  requires: ${spec.requires.join(", ")}`));
    printFields(spec.fields);
    if (n === "script" && name === "script") console.log(`\n${SCRIPT_API_REFERENCE.replace(/^/gm, "  ")}`);
    else if (n === "script") console.log(paint("dim", "  Run `ludra components script` for the script API."));
    console.log();
  }

  if (showEffects) {
    console.log(`${paint("bold", "effects")} (scene level, not a component) — ${EFFECTS_DESCRIPTION}`);
    console.log(paint("dim", `  events: ${EVENT_TYPES.join(", ")}`));
    console.log(paint("dim", `  sound presets: ${SOUND_PRESETS.join(", ")}`));
    printFields(EFFECT_FIELDS);
    console.log(`  ${pad("particles", 13)} ${pad("object", 34)} ${pad("optional", 18)} ${paint("dim", "A burst at the event position, with these fields:")}`);
    printFields(PARTICLE_FIELDS, "    ");
    console.log(paint("dim", `  example:\n  ${EFFECTS_EXAMPLE}`));
    console.log();
  }
  return 0;
}

function printFields(fields: Record<string, FieldSpec>, indent = "  "): void {
  for (const [field, fieldSpec] of Object.entries(fields)) {
    // Pad before coloring so escape codes don't break the alignment.
    const required =
      fieldSpec.default === undefined ? paint("yellow", pad("required", 18)) : pad(`default ${JSON.stringify(fieldSpec.default)}`, 18);
    console.log(`${indent}${pad(field, 15 - indent.length)} ${pad(typeLabel(fieldSpec), 34)} ${required} ${paint("dim", fieldSpec.description)}`);
  }
}

function typeLabel(spec: FieldSpec): string {
  if (spec.type === "enum") return spec.values.map((v) => `"${v}"`).join(" | ");
  if (spec.type === "number" && spec.min !== undefined) return `number ≥ ${spec.min}`;
  if (spec.type === "frames") return 'frames ("0", "1-4", "0,2")';
  return spec.type;
}
