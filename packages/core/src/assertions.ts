import { InputScript } from "./input.ts";
import { defaultDuration, simulate } from "./simulate.ts";
import { FIXED_DT, parseDuration, secondsToFrames } from "./time.ts";
import { EVENT_TYPES, type SceneDef } from "./types.ts";
import { World, type GameEvent, type WorldOptions, type WorldSnapshot } from "./world.ts";

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">"] as const;
type Operator = (typeof OPERATORS)[number];

const ENTITY_FIELDS = ["x", "y", "vx", "vy", "grounded", "exists"] as const;
type EntityField = (typeof ENTITY_FIELDS)[number];

const WORLD_FIELDS = ["score", "deaths", "won", "lost", "lives"] as const;
type WorldField = (typeof WORLD_FIELDS)[number];

type Subject =
  | { kind: "world"; field: WorldField }
  /** Built-in event types, or custom events fired by scripts with world.emit(name). */
  | { kind: "events"; name: string; builtin: boolean }
  | { kind: "entity"; id: string; field: EntityField }
  | { kind: "state"; id: string; key: string };

type Value = number | boolean | string;

export interface Assertion {
  source: string;
  subject: Subject;
  operator: Operator;
  expected: Value;
  /** Frame to check at, or "end" for the last frame of the run. */
  at: number | "end";
}

export class AssertionSyntaxError extends Error {}

const EXAMPLES =
  'Examples: "player.x > 400", "player.grounded == true at 1s", "score >= 3", "won == true", "deaths == 0", "events.jump == 1 at end", "coin1.exists == false", "door.state.open == true", "boss.state.phase == \\"angry\\"", "events.shoot >= 3".';

/** Parses `<subject> <op> <value> [at <time|end>]`. */
export function parseAssertion(source: string): Assertion {
  const match = /^\s*([\w.-]+)\s*(<=|>=|==|!=|<|>)\s*(\S+?)(?:\s+at\s+(\S+))?\s*$/.exec(source);
  if (!match) throw new AssertionSyntaxError(`Cannot parse assertion "${source}". ${EXAMPLES}`);
  const [, lhs = "", operator, rhs = "", at] = match;

  let subject: Subject;
  const stateMatch = /^(.+)\.state\.([\w-]+)$/.exec(lhs);
  if ((WORLD_FIELDS as readonly string[]).includes(lhs)) {
    subject = { kind: "world", field: lhs as WorldField };
  } else if (lhs.startsWith("events.") && lhs.length > "events.".length) {
    const name = lhs.slice("events.".length);
    subject = { kind: "events", name, builtin: (EVENT_TYPES as readonly string[]).includes(name) };
  } else if (stateMatch) {
    subject = { kind: "state", id: stateMatch[1]!, key: stateMatch[2]! };
  } else {
    const dot = lhs.lastIndexOf(".");
    const field = lhs.slice(dot + 1);
    if (dot <= 0 || !(ENTITY_FIELDS as readonly string[]).includes(field)) {
      throw new AssertionSyntaxError(
        `"${lhs}" is not something Ludra can check. Use ${WORLD_FIELDS.join(", ")}, events.<name>, <entityId>.<${ENTITY_FIELDS.join("|")}> or <entityId>.state.<key>.`,
      );
    }
    subject = { kind: "entity", id: lhs.slice(0, dot), field: field as EntityField };
  }

  let expected: Value;
  if (rhs === "true" || rhs === "false") expected = rhs === "true";
  else if (/^".*"$/.test(rhs)) expected = rhs.slice(1, -1);
  else if (Number.isFinite(Number(rhs))) expected = Number(rhs);
  else {
    throw new AssertionSyntaxError(`Expected a number, true/false or a "quoted string" after "${operator}" in "${source}", got ${rhs}.`);
  }

  let frame: number | "end" = "end";
  if (at !== undefined && at !== "end") {
    try {
      frame = secondsToFrames(parseDuration(at));
    } catch (err) {
      throw new AssertionSyntaxError(`${(err as Error).message} (in "${source}")`);
    }
  }

  return { source, subject, operator: operator as Operator, expected, at: frame };
}

export interface AssertionResult {
  source: string;
  pass: boolean;
  actual: unknown;
  time: number;
  message: string;
}

export function evaluateAssertion(assertion: Assertion, snapshot: WorldSnapshot, events: readonly GameEvent[]): AssertionResult {
  const { subject, operator, expected, source } = assertion;
  const time = snapshot.time;
  let actual: unknown;
  let label: string;

  switch (subject.kind) {
    case "world":
      actual = snapshot[subject.field];
      label = subject.field;
      if (actual === undefined) {
        return { source, pass: false, actual, time, message: `${label} is not set: the scene has unlimited retries. Add "lives" to "world" to count them.` };
      }
      break;
    case "events": {
      const matches = (e: GameEvent) => (subject.builtin ? e.type === subject.name : e.type === "custom" && e.name === subject.name);
      actual = events.filter((e) => matches(e) && e.frame <= snapshot.frame).length;
      label = `events.${subject.name}`;
      break;
    }
    case "state": {
      const entity = snapshot.entities[subject.id];
      label = `${subject.id}.state.${subject.key}`;
      if (!entity) {
        return { source, pass: false, actual: undefined, time, message: `entity "${subject.id}" does not exist at ${time.toFixed(2)}s.` };
      }
      actual = entity.state?.[subject.key];
      if (actual === undefined) {
        return {
          source,
          pass: false,
          actual,
          time,
          message: `${label} is not set at ${time.toFixed(2)}s. Scripts set it with self.state.${subject.key} = ...`,
        };
      }
      break;
    }
    case "entity": {
      const entity = snapshot.entities[subject.id];
      label = `${subject.id}.${subject.field}`;
      if (subject.field === "exists") actual = entity !== undefined;
      else if (entity) actual = entity[subject.field];
      else {
        return {
          source,
          pass: false,
          actual: undefined,
          time,
          message: `entity "${subject.id}" does not exist at ${time.toFixed(2)}s (wrong id, or it was collected/removed).`,
        };
      }
    }
  }

  if (typeof actual !== typeof expected) {
    return {
      source,
      pass: false,
      actual,
      time,
      message: `${label} is ${JSON.stringify(actual)} (a ${typeof actual}), but it is compared with ${JSON.stringify(expected)}.`,
    };
  }
  if (typeof actual !== "number" && operator !== "==" && operator !== "!=") {
    return { source, pass: false, actual, time, message: `${label} is a ${typeof actual}, so only == and != can be used.` };
  }

  const pass = compare(actual as number, operator, expected as number);
  const shown = typeof actual === "number" ? round(actual) : JSON.stringify(actual);
  return { source, pass, actual, time, message: `${label} = ${shown} at ${time.toFixed(2)}s` };
}

function compare(a: number, operator: Operator, b: number): boolean {
  switch (operator) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One case in a `tests/*.test.json` file. */
export interface TestCase {
  name: string;
  /** Scene to run, relative to the project. Defaults to the entry scene in ludra.json. */
  scene?: string;
  /** Input script, see `InputScript`. */
  inputs?: string;
  /** Run length, e.g. "3s". Defaults to the inputs plus one second, or the latest `at`. */
  duration?: string | number;
  assert: string[];
}

export interface TestResult {
  name: string;
  pass: boolean;
  duration: number;
  results: AssertionResult[];
  error?: string;
  /** Names of the events that fired during the run (built-in types and custom names). */
  events: string[];
}

export function runTest(scene: SceneDef, test: TestCase, options: WorldOptions = {}): TestResult {
  let script: InputScript;
  let assertions: Assertion[];
  let frames: number;
  try {
    if (!Array.isArray(test.assert) || test.assert.length === 0) {
      throw new AssertionSyntaxError(`Test "${test.name}" has no "assert" list. ${EXAMPLES}`);
    }
    script = InputScript.parse(test.inputs ?? "");
    assertions = test.assert.map(parseAssertion);
    const latestAt = Math.max(0, ...assertions.map((a) => (a.at === "end" ? 0 : a.at)));
    frames =
      test.duration !== undefined
        ? secondsToFrames(typeof test.duration === "number" ? test.duration : parseDuration(test.duration))
        : Math.max(secondsToFrames(defaultDuration(script)), latestAt);
  } catch (err) {
    return { name: test.name, pass: false, duration: 0, results: [], error: (err as Error).message, events: [] };
  }

  const wanted = new Set(assertions.map((a) => (a.at === "end" ? frames : Math.min(a.at, frames))));
  const snapshots = new Map<number, WorldSnapshot>();
  let world: World;
  try {
    world = new World(scene, options);
    simulate(world, script, frames, (w) => {
      if (wanted.has(w.frame)) snapshots.set(w.frame, w.snapshot());
    });
  } catch (err) {
    // A throwing script fails this test, not the whole run.
    return { name: test.name, pass: false, duration: frames * FIXED_DT, results: [], error: (err as Error).message, events: [] };
  }

  const results = assertions.map((a) => {
    const frame = a.at === "end" ? frames : Math.min(a.at, frames);
    return evaluateAssertion(a, snapshots.get(frame)!, world.events);
  });
  const events = [...new Set(world.events.map((e) => (e.type === "custom" ? e.name : e.type)))];
  return { name: test.name, pass: results.every((r) => r.pass), duration: frames * FIXED_DT, results, events };
}
