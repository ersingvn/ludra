/** The simulation always advances in fixed steps, so runs are deterministic. */
export const FPS = 60;
export const FIXED_DT = 1 / FPS;

export class DurationError extends Error {}

/**
 * Parses `"2s"`, `"250ms"`, `"30f"` (frames) or a bare number of seconds.
 * Returns seconds.
 */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|f)?$/.exec(text.trim());
  if (!match) {
    throw new DurationError(`Invalid duration "${text}". Use seconds ("1.5s"), milliseconds ("200ms") or frames ("30f").`);
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return value / 1000;
    case "f":
      return value / FPS;
    default:
      return value;
  }
}

export function secondsToFrames(seconds: number): number {
  return Math.round(seconds * FPS);
}
