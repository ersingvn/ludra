import { parseDuration, secondsToFrames } from "./time.ts";
import { ACTIONS, type Action } from "./types.ts";

export class InputScriptError extends Error {}

export interface InputSegment {
  actions: ReadonlySet<Action>;
  frames: number;
}

/** A tap without a duration holds the action for 0.1s. */
const TAP_FRAMES = 6;
const NOTHING: ReadonlySet<Action> = new Set();

/**
 * Scripted input for headless runs, e.g. `"right:1s, jump:0.4s, wait:0.5s, left+jump:0.3s"`.
 *
 * Segments run back to back. A jump only triggers when it is newly pressed,
 * so two consecutive jump segments need a `wait` between them.
 */
export class InputScript {
  readonly segments: readonly InputSegment[];
  readonly totalFrames: number;
  private readonly starts: number[];

  constructor(segments: readonly InputSegment[]) {
    this.segments = segments;
    this.starts = [];
    let frame = 0;
    for (const segment of segments) {
      this.starts.push(frame);
      frame += segment.frames;
    }
    this.totalFrames = frame;
  }

  static parse(text: string): InputScript {
    const segments: InputSegment[] = [];
    for (const token of text.split(",").map((t) => t.trim()).filter(Boolean)) {
      const [actionPart = "", durationPart, ...rest] = token.split(":").map((t) => t.trim());
      if (rest.length > 0) throw new InputScriptError(`Invalid input "${token}". Use "action:duration", e.g. "right:1s".`);

      const actions = new Set<Action>();
      for (const name of actionPart.split("+").map((n) => n.trim())) {
        if (name === "wait") continue;
        if (!(ACTIONS as readonly string[]).includes(name)) {
          throw new InputScriptError(`Unknown action "${name}" in "${token}". Valid actions: ${ACTIONS.join(", ")}, wait.`);
        }
        actions.add(name as Action);
      }

      let frames = TAP_FRAMES;
      if (durationPart !== undefined) {
        try {
          frames = secondsToFrames(parseDuration(durationPart));
        } catch (err) {
          throw new InputScriptError(`${(err as Error).message} (in "${token}")`);
        }
      }
      if (frames < 1) throw new InputScriptError(`Duration in "${token}" is shorter than one frame (1/60s).`);
      segments.push({ actions, frames });
    }
    return new InputScript(segments);
  }

  /** Actions held during the step that advances from `frame` to `frame + 1`. */
  at(frame: number): ReadonlySet<Action> {
    // Binary search: a recorded session has thousands of segments, and this runs every frame.
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.starts[middle]! <= frame) low = middle;
      else high = middle - 1;
    }
    const start = this.starts[low];
    if (start === undefined || frame < start) return NOTHING;
    return frame < start + this.segments[low]!.frames ? this.segments[low]!.actions : NOTHING;
  }
}
