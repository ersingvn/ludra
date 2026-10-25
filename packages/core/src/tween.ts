/** Tweens: a value eased from where it is to a target, inside the deterministic simulation. */

export const EASES = ["linear", "sineInOut", "quadIn", "quadOut", "quadInOut", "cubicInOut", "backOut", "elasticOut", "bounceOut"] as const;
export type Ease = (typeof EASES)[number];
export type TweenProperty = "x" | "y" | "rotation" | "scale" | "opacity";

export interface Tween {
  property: TweenProperty;
  to: number;
  by: number;
  duration: number;
  delay: number;
  ease: Ease;
  repeat: "once" | "loop" | "pingpong";
  on: string;
}

export interface TweenState extends Tween {
  /** Running (or waiting out its delay). False before its event fires and after a "once" tween ends. */
  active: boolean;
  /** Ran to the end ("once"). */
  done: boolean;
  /** This pass goes from `from` to `target`. */
  from: number;
  target: number;
  /** Seconds into this pass, delay included. */
  elapsed: number;
  /** Just finished: a moving body stops on the next step. */
  settle?: boolean;
}

function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** Progress 0..1 through a curve. */
export function ease(name: Ease, t: number): number {
  switch (name) {
    case "linear":
      return t;
    case "sineInOut":
      return -(Math.cos(Math.PI * t) - 1) / 2;
    case "quadIn":
      return t * t;
    case "quadOut":
      return 1 - (1 - t) * (1 - t);
    case "quadInOut":
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    case "cubicInOut":
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    case "backOut": {
      const c = 1.70158;
      return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
    }
    case "elasticOut":
      return t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
    case "bounceOut":
      return bounceOut(t);
  }
}

/** A tween as declared, not started yet unless it has no `on` event. */
export function createTween(spec: Tween, current: number): TweenState {
  const state: TweenState = { ...spec, active: false, done: false, from: current, target: current, elapsed: 0 };
  if (spec.on === "") startTween(state, current);
  return state;
}

/** Starts (or restarts) a tween from the value the property has now. */
export function startTween(state: TweenState, current: number): void {
  state.active = true;
  state.done = false;
  state.elapsed = 0;
  state.from = current;
  state.target = state.by !== 0 ? current + state.by : state.to;
}

/** Advances by dt and returns the value for this step, or undefined while it isn't moving. */
export function advanceTween(state: TweenState, dt: number): number | undefined {
  if (!state.active) return undefined;
  state.elapsed += dt;
  const local = state.elapsed - state.delay;
  if (local < 0) return state.from;
  const progress = Math.min(1, local / state.duration);
  const value = state.from + (state.target - state.from) * ease(state.ease, progress);
  if (progress >= 1) {
    if (state.repeat === "once") {
      state.active = false;
      state.done = true;
      return state.target;
    }
    if (state.repeat === "pingpong") [state.from, state.target] = [state.target, state.from];
    // A new pass starts: it waits out the delay again, keeping the time that overshot this one.
    state.elapsed = local - state.duration;
    return state.repeat === "pingpong" ? state.from : state.target;
  }
  return value;
}
