/**
 * Story systems: inventory (`item`, `lock`, `goal.requires`), flags and dialogue.
 *
 * The rules live here; `World` owns the state (`items`, `flags`, the open conversation) and
 * calls these functions from `step`, so everything stays inside the deterministic simulation
 * and comes back through `World.save()` / `restore()`.
 */

/** A story flag's value. */
export type Flag = number | string | boolean;

/** What a line or a choice does when it is shown or picked. */
export interface StoryEffects {
  /** Flags to set. */
  set?: Record<string, Flag>;
  /** Items to add, by name. */
  give?: Record<string, number>;
  /** Items to remove, by name (only when the player has all of them). */
  take?: Record<string, number>;
}

/** Conditions on the story so far. Both must hold. */
export interface StoryCondition {
  /** Flags that must have these values. `false` also matches a flag never set. */
  when?: Record<string, Flag>;
  /** Items the player must have at least this many of. */
  has?: Record<string, number>;
}

export interface DialogueChoice extends StoryEffects, StoryCondition {
  text: string;
  /** The line to go to: its index, or its `id`. Without `next` or `end`, the line after. */
  next?: number | string;
  end?: boolean;
}

export interface DialogueLine extends StoryEffects {
  /** A name for `next` to point at. */
  id?: string;
  speaker?: string;
  text: string;
  choices?: DialogueChoice[];
  /** Where to go after this line (no choices): an index or an `id`. */
  next?: number | string;
  /** Ends the conversation after this line. */
  end?: boolean;
}

export interface Dialogue extends StoryCondition {
  /** How close (gap between the two bodies) the player must be to start talking. 0 = 48 px in 2D, 1.5 m in 3D. */
  range: number;
  lines: DialogueLine[];
}

/** An open conversation, as the world keeps it. */
export interface Conversation {
  /** Who the player is talking to. */
  entity: string;
  /** Which of the entity's dialogues (the first whose condition held when it opened). */
  dialogue: number;
  line: number;
  /** The highlighted choice, an index into the choices shown. */
  choice: number;
}

/** What `world.talking` shows scripts and draw hooks. */
export interface Talking {
  entity: string;
  line: number;
  choice: number;
  text: string;
  speaker: string;
  /** The texts of the choices shown on this line (those whose condition holds); empty when there are none. */
  choices: string[];
}

export interface StoryState {
  items: Record<string, number>;
  flags: Record<string, Flag>;
}

export const DEFAULT_RANGE_2D = 48;
export const DEFAULT_RANGE_3D = 1.5;

/** True when every flag in `when` has its value and the player has every item in `has`. */
export function holds(condition: StoryCondition, story: StoryState): boolean {
  for (const [key, value] of Object.entries(condition.when ?? {})) {
    const actual = story.flags[key];
    if (actual === value) continue;
    if (value === false && actual === undefined) continue;
    return false;
  }
  for (const [name, count] of Object.entries(condition.has ?? {})) {
    if ((story.items[name] ?? 0) < count) return false;
  }
  return true;
}

/** Index of the first dialogue whose condition holds, or -1. */
export function pickDialogue(dialogues: readonly Dialogue[], story: StoryState): number {
  return dialogues.findIndex((d) => holds(d, story));
}

export function addItem(items: Record<string, number>, name: string, count: number): void {
  const total = (items[name] ?? 0) + count;
  if (total > 0) items[name] = total;
  else delete items[name];
}

/** Removes `count` of `name` when there are that many: false and no change otherwise. */
export function takeItem(items: Record<string, number>, name: string, count: number): boolean {
  if ((items[name] ?? 0) < count) return false;
  addItem(items, name, -count);
  return true;
}

/** Applies a line's or a choice's effects: take (all or nothing), give, set. */
export function applyEffects(effects: StoryEffects, story: StoryState): void {
  const take = Object.entries(effects.take ?? {});
  if (take.every(([name, count]) => (story.items[name] ?? 0) >= count)) {
    for (const [name, count] of take) takeItem(story.items, name, count);
  }
  for (const [name, count] of Object.entries(effects.give ?? {})) addItem(story.items, name, count);
  for (const [key, value] of Object.entries(effects.set ?? {})) story.flags[key] = value;
}

/** The choices shown on a line: those whose condition holds, with their index in the line's list. */
export function shownChoices(line: DialogueLine, story: StoryState): { choice: DialogueChoice; index: number }[] {
  return (line.choices ?? []).map((choice, index) => ({ choice, index })).filter(({ choice }) => holds(choice, story));
}

/** Where `next` points: a line index, or -1 when it ends the conversation (past the last line). */
export function resolveNext(lines: readonly DialogueLine[], next: number | string | undefined, from: number): number {
  if (next === undefined) return from + 1 < lines.length ? from + 1 : -1;
  if (typeof next === "number") return next >= 0 && next < lines.length ? next : -1;
  return lines.findIndex((l) => l.id === next);
}

export function talkingView(conversation: Conversation, dialogue: Dialogue, story: StoryState): Talking {
  const line = dialogue.lines[conversation.line]!;
  return {
    entity: conversation.entity,
    line: conversation.line,
    choice: conversation.choice,
    text: line.text,
    speaker: line.speaker ?? "",
    choices: shownChoices(line, story).map(({ choice }) => choice.text),
  };
}

/** The dialogues an entity's `dialogue` component declares (one object or a list), with defaults filled in. */
export function resolveDialogues(raw: unknown): Dialogue[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((d) => {
    const def = d as Partial<Dialogue>;
    return {
      range: def.range ?? 0,
      lines: structuredClone(def.lines ?? []),
      ...(def.when ? { when: { ...def.when } } : {}),
      ...(def.has ? { has: { ...def.has } } : {}),
    };
  });
}

// ------------------------------------------------------------------ checks

type Report = (code: string, path: string, message: string, fix?: string) => void;

const DIALOGUE_FIELDS = ["range", "lines", "when", "has"];
const LINE_FIELDS = ["id", "speaker", "text", "choices", "next", "end", "set", "give", "take"];
const CHOICE_FIELDS = ["text", "next", "end", "set", "give", "take", "when", "has"];

const DIALOGUE_EXAMPLE =
  '"dialogue": { "lines": [{ "speaker": "Smith", "text": "The bridge is out." }, { "text": "Will you help?", "choices": [{ "text": "Yes", "set": { "quest": "hammer" } }, { "text": "No", "end": true }] }] }';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlag(value: unknown): value is Flag {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** Item names given anywhere in a dialogue, for checking that required items exist. */
export function dialogueGives(raw: unknown): string[] {
  const names: string[] = [];
  for (const d of Array.isArray(raw) ? raw : [raw]) {
    if (!isObject(d) || !Array.isArray(d.lines)) continue;
    for (const line of d.lines) {
      if (!isObject(line)) continue;
      if (isObject(line.give)) names.push(...Object.keys(line.give));
      for (const choice of Array.isArray(line.choices) ? line.choices : []) if (isObject(choice) && isObject(choice.give)) names.push(...Object.keys(choice.give));
    }
  }
  return names;
}

/** Checks a `dialogue` component (one object or a list of them). */
export function validateDialogue(raw: unknown, path: string, label: string, error: Report, warn: Report): void {
  const list = Array.isArray(raw) ? raw : [raw];
  if (Array.isArray(raw) && raw.length === 0) {
    error("E_DIALOGUE_EMPTY", path, `The dialogue list on entity ${label} is empty.`, `Use ${DIALOGUE_EXAMPLE}.`);
  }
  list.forEach((d, i) => {
    const at = Array.isArray(raw) ? `${path}[${i}]` : path;
    if (!isObject(d)) {
      error("E_COMPONENT_NOT_OBJECT", at, `A dialogue on entity ${label} must be an object.`, `Use ${DIALOGUE_EXAMPLE}.`);
      return;
    }
    unknownFields(d, DIALOGUE_FIELDS, at, "dialogue", warn);
    if (d.range !== undefined && (typeof d.range !== "number" || !Number.isFinite(d.range) || d.range < 0)) {
      error("E_INVALID_FIELD", `${at}.range`, `dialogue.range on entity ${label} must be a distance ≥ 0, got ${JSON.stringify(d.range)}.`, "0 = 48 px in 2D, 1.5 m in 3D.");
    }
    validateCondition(d, at, label, error);
    if (!Array.isArray(d.lines) || d.lines.length === 0) {
      error("E_DIALOGUE_LINES", `${at}.lines`, `The dialogue on entity ${label} needs "lines": a list of at least one line.`, `Use ${DIALOGUE_EXAMPLE}.`);
      return;
    }
    const lines = d.lines as unknown[];
    const ids = lines.flatMap((l) => (isObject(l) && typeof l.id === "string" ? [l.id] : []));
    const checkNext = (next: unknown, nextPath: string) => {
      if (next === undefined) return;
      if (typeof next === "number") {
        if (!Number.isInteger(next) || next < 0 || next >= lines.length) {
          error("E_DIALOGUE_NEXT", nextPath, `"next": ${next} on entity ${label} points past the dialogue's lines (0 to ${lines.length - 1}).`, 'Use a line index from 0, or give the line an "id" and point at that. To finish, use "end": true.');
        }
      } else if (typeof next === "string") {
        if (!ids.includes(next)) {
          error("E_DIALOGUE_NEXT", nextPath, `"next": "${next}" on entity ${label} names no line.`, ids.length > 0 ? `Line ids here: ${ids.map((id) => `"${id}"`).join(", ")}.` : `Add "id": "${next}" to the line it should go to.`);
        }
      } else {
        error("E_DIALOGUE_NEXT", nextPath, `"next" on entity ${label} must be a line index or a line's "id", got ${JSON.stringify(next)}.`);
      }
    };
    lines.forEach((line, j) => {
      const linePath = `${at}.lines[${j}]`;
      if (!isObject(line)) {
        error("E_DIALOGUE_LINE", linePath, `Line ${j} of the dialogue on entity ${label} must be an object like { "speaker": "Smith", "text": "Hello." }.`);
        return;
      }
      unknownFields(line, LINE_FIELDS, linePath, "dialogue line", warn);
      if (typeof line.text !== "string" || line.text === "") {
        error("E_DIALOGUE_LINE", `${linePath}.text`, `Line ${j} of the dialogue on entity ${label} needs "text": what is said.`);
      }
      for (const key of ["speaker", "id"] as const) {
        if (line[key] !== undefined && typeof line[key] !== "string") error("E_INVALID_FIELD", `${linePath}.${key}`, `${key} on line ${j} of entity ${label} must be a string.`);
      }
      if (line.end !== undefined && typeof line.end !== "boolean") error("E_INVALID_FIELD", `${linePath}.end`, `end on line ${j} of entity ${label} must be true or false.`);
      validateEffects(line, linePath, label, error);
      checkNext(line.next, `${linePath}.next`);
      if (line.choices !== undefined) {
        if (!Array.isArray(line.choices) || line.choices.length === 0) {
          error("E_DIALOGUE_CHOICES", `${linePath}.choices`, `choices on line ${j} of entity ${label} must be a list of at least one choice.`, 'Use "choices": [{ "text": "Yes", "next": 3 }, { "text": "No", "end": true }].');
          return;
        }
        if (line.next !== undefined || line.end !== undefined) {
          warn("W_DIALOGUE_NEXT_IGNORED", linePath, `Line ${j} of entity ${label} has choices, so its own "next"/"end" is never used: each choice decides where to go.`, 'Move "next" or "end" onto the choices.');
        }
        line.choices.forEach((choice: unknown, k: number) => {
          const choicePath = `${linePath}.choices[${k}]`;
          if (!isObject(choice)) {
            error("E_DIALOGUE_CHOICES", choicePath, `Choice ${k} on line ${j} of entity ${label} must be an object like { "text": "Yes" }.`);
            return;
          }
          unknownFields(choice, CHOICE_FIELDS, choicePath, "dialogue choice", warn);
          if (typeof choice.text !== "string" || choice.text === "") error("E_DIALOGUE_CHOICES", `${choicePath}.text`, `Choice ${k} on line ${j} of entity ${label} needs "text".`);
          if (choice.end !== undefined && typeof choice.end !== "boolean") error("E_INVALID_FIELD", `${choicePath}.end`, `end on a choice of entity ${label} must be true or false.`);
          validateEffects(choice, choicePath, label, error);
          validateCondition(choice, choicePath, label, error);
          checkNext(choice.next, `${choicePath}.next`);
        });
        if (line.choices.every((c: unknown) => isObject(c) && (c.when !== undefined || c.has !== undefined))) {
          warn("W_DIALOGUE_NO_CHOICE", `${linePath}.choices`, `Every choice on line ${j} of entity ${label} has a condition, so sometimes none may show and the line acts like a plain one.`, "Leave one choice without when/has (a way out), unless that is intended.");
        }
      }
    });
  });
}

function unknownFields(value: Record<string, unknown>, known: readonly string[], path: string, owner: string, warn: Report): void {
  for (const field of Object.keys(value)) {
    if (!known.includes(field)) warn("W_UNKNOWN_FIELD", `${path}.${field}`, `"${owner}" has no field "${field}", so it is ignored.`, `Valid fields: ${known.join(", ")}.`);
  }
}

function validateEffects(value: Record<string, unknown>, path: string, label: string, error: Report): void {
  if (value.set !== undefined) {
    if (!isObject(value.set) || !Object.values(value.set).every(isFlag)) {
      error("E_STORY_SET", `${path}.set`, `"set" on entity ${label} must map flag names to numbers, strings or true/false.`, 'Use "set": { "quest": "hammer", "metSmith": true }.');
    }
  }
  for (const key of ["give", "take"] as const) validateCounts(value[key], `${path}.${key}`, key, label, error);
}

function validateCondition(value: Record<string, unknown>, path: string, label: string, error: Report): void {
  if (value.when !== undefined && (!isObject(value.when) || !Object.values(value.when).every(isFlag))) {
    error("E_STORY_WHEN", `${path}.when`, `"when" on entity ${label} must map flag names to the values they must have.`, 'Use "when": { "quest": "done" }. false also matches a flag never set.');
  }
  validateCounts(value.has, `${path}.has`, "has", label, error);
}

/** `{ "key": 1 }` maps: item names to whole numbers ≥ 1. */
export function validateCounts(value: unknown, path: string, key: string, label: string, error: Report): void {
  if (value === undefined) return;
  if (!isObject(value) || !Object.values(value).every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1)) {
    error("E_STORY_ITEMS", path, `"${key}" on entity ${label} must map item names to whole numbers ≥ 1.`, `Use "${key}": { "key": 1 }.`);
  }
}

/**
 * Scene checks for `item`, `lock` and `goal.requires` on one entity. Records the item names it
 * gives in `sources` and the ones it needs in `needs`, so the scene can say when a needed item
 * is given nowhere.
 */
export function validateStoryEntity(
  components: Record<string, unknown>,
  path: string,
  label: string,
  error: Report,
  warn: Report,
  sources: Set<string>,
  needs: { path: string; label: string; name: string; what: string }[],
): void {
  const item = components.item;
  if (isObject(item) && typeof item.name === "string") {
    if (item.name === "") error("E_INVALID_FIELD", `${path}.components.item.name`, `item.name on entity ${label} is empty.`, 'Name it, e.g. "key".');
    else sources.add(item.name);
  }
  const lock = components.lock;
  if (isObject(lock)) {
    const body = isObject(components.body) ? components.body : undefined;
    if (body && body.sensor === true) {
      warn("W_LOCK_SENSOR", `${path}.components.body.sensor`, `Entity ${label} has "lock" but a sensor body, so it never blocks anyone: the lock means nothing.`, 'Remove "sensor": true so it is a solid door.');
    }
    if (typeof lock.needs === "string" && lock.needs !== "") needs.push({ path: `${path}.components.lock.needs`, label, name: lock.needs, what: "The lock" });
  }
  const goal = components.goal;
  if (isObject(goal) && goal.requires !== undefined) {
    validateCounts(goal.requires, `${path}.components.goal.requires`, "requires", label, error);
    if (isObject(goal.requires)) {
      for (const name of Object.keys(goal.requires)) needs.push({ path: `${path}.components.goal.requires.${name}`, label, name, what: "The goal" });
    }
  }
}

/** What `ludra components dialogue` prints below the fields. */
export const DIALOGUE_REFERENCE = `A line:   { "id"?, "speaker"?, "text", "choices"?, "next"?, "end"?, "set"?, "give"?, "take"? }
A choice: { "text", "next"?, "end"?, "set"?, "give"?, "take"?, "when"?, "has"? }
  set  { "flag": value }   give / take  { "item": count }   (take is all or nothing)
  next a line index or a line's "id"; without next or end, the line after (past the last one ends it)
  when { "flag": value } (false matches a flag never set)   has { "item": count }
  Lines' effects happen when the line is shown, choices' when picked. A choice whose when/has fails is hidden.
A list of dialogues ("dialogue": [ {...}, {...} ]) uses the first whose when/has holds: put the later story first.
The player presses action within range to talk; action or jump goes on, up/down pick a choice, and the player
can't move meanwhile. Events: talk, say { line }, choose { choice }, endtalk. Scripts read world.talking.
Test it: "inputs": "action:2f, wait:0.2s, action:2f, down:2f, action:2f", "assert": ["flags.quest == \\"hammer\\""].`;
