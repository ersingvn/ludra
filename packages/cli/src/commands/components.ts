import { COMPONENT_NAMES, COMPONENTS, isComponentName, type FieldSpec } from "@ludra/core";
import { pad, paint } from "../format.ts";
import { CliError } from "../project.ts";

export function components(name: string | undefined, options: { json?: boolean }): number {
  if (name !== undefined && !isComponentName(name)) {
    throw new CliError(`Unknown component "${name}". Components: ${COMPONENT_NAMES.join(", ")}.`);
  }
  const names = name ? [name] : COMPONENT_NAMES;

  if (options.json) {
    console.log(JSON.stringify(Object.fromEntries(names.map((n) => [n, COMPONENTS[n]])), null, 2));
    return 0;
  }

  for (const n of names) {
    const spec = COMPONENTS[n];
    console.log(`${paint("bold", n)} — ${spec.description}`);
    if (spec.requires?.length) console.log(paint("dim", `  requires: ${spec.requires.join(", ")}`));
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      // Pad before coloring so escape codes don't break the alignment.
      const required =
        fieldSpec.default === undefined ? paint("yellow", pad("required", 18)) : pad(`default ${JSON.stringify(fieldSpec.default)}`, 18);
      console.log(`  ${pad(field, 13)} ${pad(typeLabel(fieldSpec), 34)} ${required} ${paint("dim", fieldSpec.description)}`);
    }
    console.log();
  }
  return 0;
}

function typeLabel(spec: FieldSpec): string {
  if (spec.type === "enum") return spec.values.map((v) => `"${v}"`).join(" | ");
  if (spec.type === "number" && spec.min !== undefined) return `number ≥ ${spec.min}`;
  return spec.type;
}
