import { COMPONENT_NAMES, COMPONENTS, isComponentName, isFrameList, PARTICLE_FIELDS, type ComponentName, type FieldSpec } from "./components.ts";
import { AUDIO_EXTENSIONS, EFFECT_FIELDS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, isSoundPreset, SOUND_PRESETS } from "./effects.ts";
import { EVENT_TYPES, type Diagnostic, type SceneDef } from "./types.ts";

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
export function validateScene(input: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string, fix?: string) =>
    diagnostics.push({ severity: "error", code, path, message, fix });
  const warn = (code: string, path: string, message: string, fix?: string) =>
    diagnostics.push({ severity: "warning", code, path, message, fix });
  const result = (): ValidationResult => {
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, scene: ok ? (scene as SceneDef) : undefined };
  };

  let scene: unknown = input;
  if (!isObject(input)) {
    error("E_SCENE_NOT_OBJECT", "$", "A scene must be a JSON object.", 'Start from { "entities": [] }.');
    return result();
  }
  // Prefabs become plain entities first, so everything below sees the final components.
  const raw = expandPrefabs(input, error);
  scene = raw;

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
      if (raw.world.seed !== undefined && (typeof raw.world.seed !== "number" || !Number.isFinite(raw.world.seed))) {
        error("E_INVALID_WORLD", "world.seed", `world.seed must be a number, got ${describe(raw.world.seed)}.`);
      }
      if (raw.world.background !== undefined && typeof raw.world.background !== "string") {
        error("E_INVALID_WORLD", "world.background", `world.background must be a CSS color string, got ${describe(raw.world.background)}.`);
      }
      const physics = raw.world.physics;
      if (physics !== undefined && physics !== "arcade" && physics !== "rapier") {
        error("E_INVALID_WORLD", "world.physics", `world.physics must be "arcade" or "rapier", got ${describe(physics)}.`, '"arcade" (default) for tight box physics, "rapier" for rotation, round shapes and real collisions.');
      }
      const lives = raw.world.lives;
      if (lives !== undefined && (typeof lives !== "number" || !Number.isInteger(lives) || lives < 1)) {
        error("E_INVALID_WORLD", "world.lives", `world.lives must be a whole number of at least 1, got ${describe(lives)}.`, "Leave it out for unlimited retries.");
      }
    }
  }

  if (raw.effects !== undefined) validateEffects(raw.effects, error, warn);
  if (raw.fonts !== undefined) validateFonts(raw.fonts, error);
  if (raw.postfx !== undefined) validatePostFx(raw.postfx, error);

  if (!Array.isArray(raw.entities)) {
    error("E_NO_ENTITIES", "entities", 'A scene needs an "entities" array.', 'Add "entities": [].');
    return result();
  }

  const ids = new Map<string, number>();
  let hasPlayer = false;
  const usesRapier = isObject(raw.world) && raw.world.physics === "rapier";
  let hasDynamic = false;
  const worldGravity = isObject(raw.world) && typeof raw.world.gravity === "number" ? raw.world.gravity : 1800;
  let hasSolid = false;
  let availableScore = 0;
  const goals: { path: string; label: string; requireScore: number }[] = [];

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
        const suggestion = closestName(name, COMPONENT_NAMES);
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
      validateFields(COMPONENTS[name].fields, value, componentPath, name, ` on entity ${label}`, error, warn);
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

    const sprite = isObject(components.sprite) ? components.sprite : undefined;
    if (sprite && typeof sprite.image === "string" && sprite.image !== "" && !hasExtension(sprite.image, IMAGE_EXTENSIONS)) {
      error(
        "E_INVALID_IMAGE",
        `${path}.components.sprite.image`,
        `"${sprite.image}" on entity ${label} is not an image file.`,
        `Use a path ending in ${IMAGE_EXTENSIONS.join(", ")}. SVG is easiest: you can write it as text.`,
      );
    }

    const script = isObject(components.script) ? components.script : undefined;
    if (script && typeof script.src === "string" && !hasExtension(script.src, SCRIPT_EXTENSIONS)) {
      error(
        "E_INVALID_SCRIPT_PATH",
        `${path}.components.script.src`,
        `"${script.src}" on entity ${label} is not a script file.`,
        'Use a path ending in .ts or .js, e.g. "scripts/chase.ts".',
      );
    }

    const body = isObject(components.body) ? components.body : undefined;
    const bodyType = body?.type ?? "static";
    // Fields only rapier understands do nothing under arcade physics: say so instead of silently ignoring them.
    if (!usesRapier) {
      const transform = isObject(components.transform) ? components.transform : undefined;
      const rapierOnly = [
        ...(transform && transform.rotation !== undefined && transform.rotation !== 0 ? ["transform.rotation"] : []),
        ...RAPIER_BODY_FIELDS.filter((field) => body && body[field] !== undefined && !(field === "shape" && body.shape === "box")).map((field) => `body.${field}`),
      ];
      if (rapierOnly.length > 0) {
        warn(
          "W_RAPIER_ONLY",
          `${path}.components`,
          `Entity ${label} sets ${rapierOnly.join(", ")}, which only rapier physics uses. Under arcade physics it is a box that never rotates.`,
          'Add "physics": "rapier" to "world", or remove the field.',
        );
      }
    }
    if ("topdown" in components && body && bodyType === "static") {
      error(
        "E_TOPDOWN_NEEDS_MOVING_BODY",
        `${path}.components.body.type`,
        `Entity ${label} has "topdown" but a static body, so it can never move.`,
        'Use "type": "dynamic" to collide with walls, or "kinematic" to pass through them (a paddle or a ship).',
      );
    }
    if ("topdown" in components && "platformer" in components) {
      error(
        "E_TWO_CONTROLLERS",
        `${path}.components`,
        `Entity ${label} has both "platformer" and "topdown", which would fight over its movement.`,
        "Keep one: platformer for side-view games with gravity, topdown for top-down games, paddles and ships.",
      );
    }
    if ("platformer" in components && body && bodyType !== "dynamic") {
      error(
        "E_PLATFORMER_NEEDS_DYNAMIC_BODY",
        `${path}.components.body.type`,
        `Entity ${label} has "platformer" but its body is "${String(bodyType)}", so it can never move.`,
        'Set "type": "dynamic" on its body.',
      );
    }
    for (const [name, consequence] of SENSOR_COMPONENTS) {
      if (name in components && body && body.sensor !== true) {
        error(
          `E_${name.toUpperCase()}_NEEDS_SENSOR`,
          `${path}.components.body.sensor`,
          `Entity ${label} has "${name}" but a solid body, so ${consequence}.`,
          'Set "sensor": true on its body.',
        );
      }
    }
    if ("patrol" in components && body && bodyType !== "kinematic") {
      error(
        "E_PATROL_NEEDS_KINEMATIC_BODY",
        `${path}.components.body.type`,
        `Entity ${label} has "patrol" but its body is "${String(bodyType)}". Only kinematic bodies follow a patrol.`,
        'Set "type": "kinematic" on its body.',
      );
    }

    if (isObject(components.collectible)) availableScore += numberOr(components.collectible.score, 1);
    if (isObject(components.hazard) && components.hazard.stompable === true) availableScore += numberOr(components.hazard.score, 0);
    if (isObject(components.goal)) goals.push({ path: `${path}.components.goal.requireScore`, label, requireScore: numberOr(components.goal.requireScore, 0) });

    if ("platformer" in components || "topdown" in components) hasPlayer = true;
    // Only bodies that gravity actually pulls down need something to stand on.
    const falls = body && bodyType === "dynamic" && !("topdown" in components) && body.gravityScale !== 0;
    if (falls && worldGravity !== 0) hasDynamic = true;
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
  for (const goal of goals) {
    if (goal.requireScore > availableScore) {
      error(
        "E_GOAL_UNREACHABLE",
        goal.path,
        `Goal ${goal.label} needs a score of ${goal.requireScore}, but the scene only offers ${availableScore} points, so the level cannot be completed.`,
        `Lower requireScore to at most ${availableScore}, or add more collectibles.`,
      );
    }
  }
  if (!hasPlayer) {
    warn("W_NO_PLAYER", "entities", 'No entity has a "platformer" or "topdown" component, so nothing responds to input (fine if scripts read input).');
  }

  return result();
}

/** Body fields that only rapier physics reads. */
const RAPIER_BODY_FIELDS = ["shape", "friction", "density", "fixedRotation", "bullet"] as const;

/** Components that only work on sensor bodies, and what goes wrong otherwise. */
const SENSOR_COMPONENTS: [ComponentName, string][] = [
  ["collectible", "players would bump into it instead of picking it up"],
  ["hazard", "players would stand on it instead of being hurt"],
  ["goal", "players would bump into it instead of reaching it"],
  ["checkpoint", "players would bump into it instead of passing through"],
];

/**
 * Replaces `"prefab": "<name>"` entities with the prefab's components, with the
 * entity's own components merged over them (field by field; `null` removes a
 * component). Returns a new scene object; reports unknown prefabs.
 */
function expandPrefabs(raw: Record<string, unknown>, error: Report): Record<string, unknown> {
  const prefabs = raw.prefabs;
  if (prefabs !== undefined) {
    if (!isObject(prefabs)) {
      error("E_PREFABS_NOT_OBJECT", "prefabs", '"prefabs" must map names to { "components": { ... } }.');
      return raw;
    }
    for (const [name, prefab] of Object.entries(prefabs)) {
      if (!isObject(prefab) || !isObject(prefab.components)) {
        error("E_INVALID_PREFAB", `prefabs.${name}`, `Prefab "${name}" needs a "components" object.`, 'Use { "components": { "body": { ... }, "sprite": { ... } } }.');
        continue;
      }
      for (const component of Object.keys(prefab.components)) {
        if (!isComponentName(component)) {
          const suggestion = closestName(component, COMPONENT_NAMES);
          error("E_UNKNOWN_COMPONENT", `prefabs.${name}.components.${component}`, `Unknown component "${component}" in prefab "${name}".`, suggestion ? `Did you mean "${suggestion}"?` : undefined);
        }
      }
    }
  }
  if (!Array.isArray(raw.entities)) return raw;
  const known = isObject(prefabs) ? prefabs : {};
  const entities = raw.entities.map((entity: unknown, i: number) => {
    if (!isObject(entity) || entity.prefab === undefined) return entity;
    const name = entity.prefab;
    const prefab = typeof name === "string" ? known[name] : undefined;
    if (!isObject(prefab) || !isObject(prefab.components)) {
      const names = Object.keys(known);
      const suggestion = typeof name === "string" ? closestName(name, names) : undefined;
      error(
        "E_UNKNOWN_PREFAB",
        `entities[${i}].prefab`,
        `Prefab ${describe(name)} does not exist.`,
        suggestion ? `Did you mean "${suggestion}"?` : names.length > 0 ? `Prefabs: ${names.join(", ")}.` : "Create prefabs/<name>.prefab.json with { \"components\": { ... } }.",
      );
      return entity;
    }
    const { prefab: _, ...rest } = entity;
    return { ...rest, components: mergeComponents(prefab.components, isObject(entity.components) ? entity.components : {}) };
  });
  return { ...raw, entities };
}

/** A prefab's components with overrides merged in, one level deep. `null` drops a component. */
export function mergeComponents(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(base)) if (isObject(value)) merged[name] = structuredClone(value);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete merged[name];
    else if (isObject(value) && isObject(merged[name])) merged[name] = { ...merged[name], ...structuredClone(value) };
    else merged[name] = structuredClone(value) as Record<string, unknown>;
  }
  return merged;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Report = (code: string, path: string, message: string, fix?: string) => void;

/**
 * Checks an object against a field table.
 * `owner` names it in messages (e.g. `sprite`), `where` says whose it is (e.g. ` on entity "player"`).
 */
function validateFields(
  fields: Record<string, FieldSpec>,
  value: Record<string, unknown>,
  path: string,
  owner: string,
  where: string,
  error: Report,
  warn: Report,
  ignore: readonly string[] = [],
): void {
  for (const [field, fieldValue] of Object.entries(value)) {
    if (ignore.includes(field)) continue;
    const spec = fields[field];
    if (!spec) {
      const suggestion = closestName(field, Object.keys(fields));
      warn(
        "W_UNKNOWN_FIELD",
        `${path}.${field}`,
        `"${owner}" has no field "${field}", so it is ignored.`,
        suggestion ? `Did you mean "${suggestion}"?` : `Valid fields: ${Object.keys(fields).join(", ")}.`,
      );
      continue;
    }
    const problem = checkField(spec, fieldValue);
    if (problem) {
      error("E_INVALID_FIELD", `${path}.${field}`, `${owner}.${field}${where} ${problem}`, fixFor(spec));
    }
  }
  for (const [field, spec] of Object.entries(fields)) {
    if (spec.default === undefined && !(field in value)) {
      error("E_MISSING_FIELD", `${path}.${field}`, `${owner}.${field} is required${where}.`, `Add "${field}": <${spec.type}>. ${spec.description}`);
    }
  }
}

function validateFonts(fonts: unknown, error: Report): void {
  const example = 'Use "fonts": { "Orbitron": "google", "Pixel": "assets/pixel.woff2" }.';
  if (!isObject(fonts)) return void error("E_FONTS_NOT_OBJECT", "fonts", '"fonts" must map font family names to "google" or a font file.', example);
  for (const [family, src] of Object.entries(fonts)) {
    const ok = typeof src === "string" && (src === "google" || FONT_EXTENSIONS.some((ext) => src.toLowerCase().endsWith(ext)));
    if (!ok) {
      error("E_INVALID_FONT", `fonts.${family}`, `fonts.${family} must be "google" or a font file (${FONT_EXTENSIONS.join(", ")}), got ${describe(src)}.`, example);
    }
  }
}

function validatePostFx(postfx: unknown, error: Report): void {
  const example = 'Use "postfx": { "shader": "shaders/crt.frag", "uniforms": { "strength": 0.5 } }.';
  if (!isObject(postfx)) return void error("E_POSTFX_NOT_OBJECT", "postfx", '"postfx" must be an object.', example);
  if (typeof postfx.shader !== "string" || postfx.shader === "") {
    error("E_POSTFX_SHADER", "postfx.shader", "postfx.shader must be the path of a GLSL fragment shader.", example);
  }
  if (postfx.uniforms !== undefined) {
    if (!isObject(postfx.uniforms)) return void error("E_POSTFX_UNIFORMS", "postfx.uniforms", "postfx.uniforms must map names to numbers.", example);
    for (const [name, value] of Object.entries(postfx.uniforms)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("u_")) {
        error("E_POSTFX_UNIFORMS", `postfx.uniforms.${name}`, `"${name}" is not a usable uniform name. Use a GLSL identifier that doesn't start with "u_" (reserved for the engine).`);
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        error("E_POSTFX_UNIFORMS", `postfx.uniforms.${name}`, `postfx.uniforms.${name} must be a number, got ${describe(value)}.`);
      }
    }
  }
}

function validateEffects(effects: unknown, error: Report, warn: Report): void {
  if (!isObject(effects)) {
    error("E_EFFECTS_NOT_OBJECT", "effects", '"effects" must map event names to effects.', 'Use "effects": { "collect": { "sound": "coin" } }.');
    return;
  }
  for (const [event, effect] of Object.entries(effects)) {
    const path = `effects.${event}`;
    if (!(EVENT_TYPES as readonly string[]).includes(event)) {
      // Any other name is a custom event that scripts fire with world.emit(). Flag likely typos of built-in ones.
      const suggestion = closestName(event, EVENT_TYPES);
      if (suggestion) {
        warn(
          "W_EVENT_LOOKS_LIKE_TYPO",
          path,
          `"${event}" is not a built-in event, so it only fires if a script calls world.emit("${event}").`,
          `Did you mean "${suggestion}"? Built-in events: ${EVENT_TYPES.join(", ")}.`,
        );
      }
    }
    if (!isObject(effect)) {
      error("E_EFFECT_NOT_OBJECT", path, `effects.${event} must be an object.`, `Use { "sound": "blip", "particles": { "count": 8 } }.`);
      continue;
    }
    validateFields(EFFECT_FIELDS, effect, path, `effects.${event}`, "", error, warn, ["particles"]);
    if (typeof effect.sound === "string" && effect.sound !== "" && !isSoundPreset(effect.sound) && !hasExtension(effect.sound, AUDIO_EXTENSIONS)) {
      const suggestion = closestName(effect.sound, SOUND_PRESETS);
      error(
        "E_INVALID_SOUND",
        `${path}.sound`,
        `"${effect.sound}" is neither a sound preset nor an audio file.`,
        `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Presets: ${SOUND_PRESETS.join(", ")}. Files must end in ${AUDIO_EXTENSIONS.join(", ")}.`,
      );
    }
    if (effect.particles !== undefined) {
      if (!isObject(effect.particles)) {
        error("E_INVALID_FIELD", `${path}.particles`, `effects.${event}.particles must be an object.`, 'Use "particles": { "count": 10, "color": "#ffd166" }.');
      } else {
        validateFields(PARTICLE_FIELDS, effect.particles, `${path}.particles`, `effects.${event}.particles`, "", error, warn);
      }
    }
  }
}

const SCRIPT_EXTENSIONS = [".ts", ".js"] as const;

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
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
    case "frames":
      return typeof value === "string" && isFrameList(value) ? undefined : `must be a frame list like "0", "1-4" or "0,2-3", got ${describe(value)}.`;
    case "object":
      return isObject(value) ? undefined : `must be an object like { "speed": 80 }, got ${describe(value)}.`;
  }
}

function fixFor(spec: FieldSpec): string | undefined {
  if (spec.type === "enum") return `Use one of: ${spec.values.map((v) => `"${v}"`).join(", ")}.`;
  if (spec.type === "frames") return 'Frames are zero-based indices into the spritesheet, left to right: "0", "1-4" or "0,2-3".';
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
export function closestName(input: string, candidates: readonly string[]): string | undefined {
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
