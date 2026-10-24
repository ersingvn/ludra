import { COMPONENT_NAMES, COMPONENTS, isComponentName, type ComponentName, type FieldSpec } from "./components.ts";
import type { Diagnostic, SceneDef } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Present only when there are no errors. */
  scene?: SceneDef;
}

const REQUIRED_EXAMPLES: Partial<Record<ComponentName, string>> = {
  transform: '{ "x": 0, "y": 0 }',
  body: '{ "type": "dynamic", "width": 32, "height": 32 }',
};

/**
 * Checks a parsed scene file. Every diagnostic names the exact JSON path and,
 * where possible, a fix an agent can apply without guessing.
 */
export function validateScene(raw: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string, fix?: string) =>
    diagnostics.push({ severity: "error", code, path, message, fix });
  const warn = (code: string, path: string, message: string, fix?: string) =>
    diagnostics.push({ severity: "warning", code, path, message, fix });
  const result = (): ValidationResult => {
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, scene: ok ? (raw as SceneDef) : undefined };
  };

  if (!isObject(raw)) {
    error("E_SCENE_NOT_OBJECT", "$", "A scene must be a JSON object.", 'Start from { "entities": [] }.');
    return result();
  }

  if (raw.world !== undefined) {
    if (!isObject(raw.world)) {
      error("E_WORLD_NOT_OBJECT", "world", '"world" must be an object.', 'Use "world": { "width": 960, "height": 540 }.');
    } else {
      for (const key of ["width", "height", "gravity"] as const) {
        const value = raw.world[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          error("E_INVALID_WORLD", `world.${key}`, `world.${key} must be a non-negative number, got ${describe(value)}.`);
        }
      }
      if (raw.world.background !== undefined && typeof raw.world.background !== "string") {
        error("E_INVALID_WORLD", "world.background", `world.background must be a CSS color string, got ${describe(raw.world.background)}.`);
      }
    }
  }

  if (!Array.isArray(raw.entities)) {
    error("E_NO_ENTITIES", "entities", 'A scene needs an "entities" array.', 'Add "entities": [].');
    return result();
  }

  const ids = new Map<string, number>();
  let hasPlayer = false;
  let hasDynamic = false;
  let hasSolid = false;

  raw.entities.forEach((entity: unknown, i: number) => {
    const path = `entities[${i}]`;
    if (!isObject(entity)) {
      error("E_ENTITY_NOT_OBJECT", path, "Each entity must be an object with an id and components.");
      return;
    }

    if (typeof entity.id !== "string" || entity.id === "") {
      error("E_ENTITY_ID", `${path}.id`, "Every entity needs a non-empty string id.", `Add "id": "entity${i}".`);
    } else if (ids.has(entity.id)) {
      error(
        "E_DUPLICATE_ID",
        `${path}.id`,
        `Entity id "${entity.id}" is already used by entities[${ids.get(entity.id)}].`,
        `Rename it, e.g. "${entity.id}-${i}".`,
      );
    } else {
      ids.set(entity.id, i);
    }
    const label = typeof entity.id === "string" && entity.id !== "" ? `"${entity.id}"` : path;

    const components = entity.components;
    if (!isObject(components)) {
      error("E_NO_COMPONENTS", `${path}.components`, `Entity ${label} needs a "components" object.`, `Add "components": { "transform": ${REQUIRED_EXAMPLES.transform} }.`);
      return;
    }

    for (const [name, value] of Object.entries(components)) {
      const componentPath = `${path}.components.${name}`;
      if (!isComponentName(name)) {
        const suggestion = closest(name, COMPONENT_NAMES);
        error(
          "E_UNKNOWN_COMPONENT",
          componentPath,
          `Unknown component "${name}" on entity ${label}.`,
          `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Run \`ludra components\` to list every component.`,
        );
        continue;
      }
      if (!isObject(value)) {
        error("E_COMPONENT_NOT_OBJECT", componentPath, `Component "${name}" on entity ${label} must be an object.`, `Use "${name}": {}.`);
        continue;
      }
      validateFields(name, value, componentPath, label, error, warn);
    }

    for (const name of Object.keys(components)) {
      if (!isComponentName(name)) continue;
      for (const required of COMPONENTS[name].requires ?? []) {
        if (!(required in components)) {
          const example = REQUIRED_EXAMPLES[required as ComponentName] ?? "{}";
          error(
            "E_MISSING_REQUIRED_COMPONENT",
            `${path}.components`,
            `"${name}" on entity ${label} requires a "${required}" component.`,
            `Add "${required}": ${example}.`,
          );
        }
      }
    }

    const body = isObject(components.body) ? components.body : undefined;
    const bodyType = body?.type ?? "static";
    if ("platformer" in components && body && bodyType !== "dynamic") {
      error(
        "E_PLATFORMER_NEEDS_DYNAMIC_BODY",
        `${path}.components.body.type`,
        `Entity ${label} has "platformer" but its body is "${String(bodyType)}", so it can never move.`,
        'Set "type": "dynamic" on its body.',
      );
    }
    if ("collectible" in components && body && body.sensor !== true) {
      error(
        "E_COLLECTIBLE_NEEDS_SENSOR",
        `${path}.components.body.sensor`,
        `Collectible ${label} has a solid body, so players would bump into it instead of picking it up.`,
        'Set "sensor": true on its body.',
      );
    }

    if ("platformer" in components) hasPlayer = true;
    if (body && bodyType === "dynamic") hasDynamic = true;
    if (body && bodyType !== "dynamic" && body.sensor !== true) hasSolid = true;
  });

  if (hasDynamic && !hasSolid) {
    warn(
      "W_NOTHING_TO_STAND_ON",
      "entities",
      "There are dynamic bodies but no solid static or kinematic bodies, so everything will fall forever.",
      'Add a ground entity with "body": { "type": "static", "width": 960, "height": 40 }.',
    );
  }
  if (!hasPlayer) {
    warn("W_NO_PLAYER", "entities", 'No entity has a "platformer" component, so nothing responds to input.');
  }

  return result();
}

type Report = (code: string, path: string, message: string, fix?: string) => void;

function validateFields(
  name: ComponentName,
  value: Record<string, unknown>,
  path: string,
  label: string,
  error: Report,
  warn: Report,
): void {
  const fields = COMPONENTS[name].fields;
  for (const [field, fieldValue] of Object.entries(value)) {
    const spec = fields[field];
    if (!spec) {
      const suggestion = closest(field, Object.keys(fields));
      warn(
        "W_UNKNOWN_FIELD",
        `${path}.${field}`,
        `"${name}" has no field "${field}", so it is ignored.`,
        suggestion ? `Did you mean "${suggestion}"?` : `Valid fields: ${Object.keys(fields).join(", ")}.`,
      );
      continue;
    }
    const problem = checkField(spec, fieldValue);
    if (problem) {
      error("E_INVALID_FIELD", `${path}.${field}`, `${name}.${field} on entity ${label} ${problem}`, fixFor(spec));
    }
  }
  for (const [field, spec] of Object.entries(fields)) {
    if (spec.default === undefined && !(field in value)) {
      error("E_MISSING_FIELD", `${path}.${field}`, `${name}.${field} is required on entity ${label}.`, `Add "${field}": <${spec.type}>. ${spec.description}`);
    }
  }
}

function checkField(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `must be a number, got ${describe(value)}.`;
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}, got ${value}.`;
      return undefined;
    case "string":
      return typeof value === "string" ? undefined : `must be a string, got ${describe(value)}.`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `must be true or false, got ${describe(value)}.`;
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? undefined
        : `must be one of ${spec.values.map((v) => `"${v}"`).join(", ")}, got ${describe(value)}.`;
  }
}

function fixFor(spec: FieldSpec): string | undefined {
  if (spec.type === "enum") return `Use one of: ${spec.values.map((v) => `"${v}"`).join(", ")}.`;
  if (spec.default !== undefined) return `The default is ${JSON.stringify(spec.default)}. ${spec.description}`;
  return spec.description;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

/** Returns the candidate within a small edit distance of `input`, if any. */
function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(input.length / 3)) + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}
