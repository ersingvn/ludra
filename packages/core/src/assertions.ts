import { InputScript } from "./input.ts";
import { defaultDuration, simulate } from "./simulate.ts";
import { FIXED_DT, parseDuration, secondsToFrames } from "./time.ts";
import type { SceneDef } from "./types.ts";
import { EVENT_TYPES, World, type GameEvent, type GameEventType, type WorldSnapshot } from "./world.ts";

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">"] as const;
type Operator = (typeof OPERATORS)[number];

const ENTITY_FIELDS = ["x", "y", "vx", "vy", "grounded", "exists"] as const;
type EntityField = (typeof ENTITY_FIELDS)[number];

type Subject =
  | { kind: "score" }
  | { kind: "events"; type: GameEventType }
  | { kind: "entity"; id: string; field: EntityField };

export interface Assertion {
  source: string;
  subject: Subject;
  operator: Operator;
  expected: number | boolean;
  /** Frame to check at, or "end" for the last frame of the run. */
  at: number | "end";
}

export class AssertionSyntaxError extends Error {}

const EXAMPLES = 'Examples: "player.x > 400", "player.grounded == true at 1s", "score >= 3", "events.jump == 1 at end", "coin1.exists == false".';

/** Parses `<subject> <op> <value> [at <time|end>]`. */
export function parseAssertion(source: string): Assertion {
  const match = /^\s*([\w.-]+)\s*(<=|>=|==|!=|<|>)\s*(\S+?)(?:\s+at\s+(\S+))?\s*$/.exec(source);
  if (!match) throw new AssertionSyntaxError(`Cannot parse assertion "${source}". ${EXAMPLES}`);
  const [, lhs = "", operator, rhs = "", at] = match;

  let subject: Subject;
  if (lhs === "score") {
    subject = { kind: "score" };
  } else if (lhs.startsWith("events.")) {
    const type = lhs.slice("events.".length);
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AssertionSyntaxError(`Unknown event "${type}" in "${source}". Events: ${EVENT_TYPES.join(", ")}.`);
    }
    subject = { kind: "events", type: type as GameEventType };
  } else {
    const dot = lhs.lastIndexOf(".");
    const field = lhs.slice(dot + 1);
    if (dot <= 0 || !(ENTITY_FIELDS as readonly string[]).includes(field)) {
      throw new AssertionSyntaxError(
        `"${lhs}" is not something Ludra can check. Use score, events.<${EVENT_TYPES.join("|")}> or <entityId>.<${ENTITY_FIELDS.join("|")}>.`,
      );
    }
    subject = { kind: "entity", id: lhs.slice(0, dot), field: field as EntityField };
  }

  let expected: number | boolean;
  if (rhs === "true" || rhs === "false") expected = rhs === "true";
  else if (Number.isFinite(Number(rhs))) expected = Number(rhs);
  else throw new AssertionSyntaxError(`Expected a number or true/false after "${operator}" in "${source}", got "${rhs}".`);

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
  actual: number | boolean | undefined;
  time: number;
  message: string;
}

export function evaluateAssertion(assertion: Assertion, snapshot: WorldSnapshot, events: readonly GameEvent[]): AssertionResult {
  const { subject, operator, expected, source } = assertion;
  const time = snapshot.time;
  let actual: number | boolean | undefined;
  let label: string;

  switch (subject.kind) {
    case "score":
      actual = snapshot.score;
      label = "score";
      break;
    case "events":
      actual = events.filter((e) => e.type === subject.type && e.frame <= snapshot.frame).length;
      label = `events.${subject.type}`;
      break;
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
    return { source, pass: false, actual, time, message: `${label} is a ${typeof actual}, but it is compared with ${JSON.stringify(expected)}.` };
  }
  if (typeof actual === "boolean" && operator !== "==" && operator !== "!=") {
    return { source, pass: false, actual, time, message: `${label} is true/false, so only == and != can be used.` };
  }

  const pass = compare(actual as number, operator, expected as number);
  const shown = typeof actual === "number" ? round(actual) : actual;
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
}

export function runTest(scene: SceneDef, test: TestCase): TestResult {
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
    return { name: test.name, pass: false, duration: 0, results: [], error: (err as Error).message };
  }

  const wanted = new Set(assertions.map((a) => (a.at === "end" ? frames : Math.min(a.at, frames))));
  const snapshots = new Map<number, WorldSnapshot>();
  const world = new World(scene);
  simulate(world, script, frames, (w) => {
    if (wanted.has(w.frame)) snapshots.set(w.frame, w.snapshot());
  });

  const results = assertions.map((a) => {
    const frame = a.at === "end" ? frames : Math.min(a.at, frames);
    return evaluateAssertion(a, snapshots.get(frame)!, world.events);
  });
  return { name: test.name, pass: results.every((r) => r.pass), duration: frames * FIXED_DT, results };
}
