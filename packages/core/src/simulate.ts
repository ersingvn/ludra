import type { InputScript } from "./input.ts";
import { FIXED_DT } from "./time.ts";
import type { World } from "./world.ts";

/**
 * Runs `world` headlessly for `frames` steps, feeding it `script`.
 * `onFrame` sees the world at frame 0 and after every step.
 */
export function simulate(world: World, script: InputScript, frames: number, onFrame?: (world: World) => void): void {
  onFrame?.(world);
  for (let i = 0; i < frames; i++) {
    world.step(script.at(world.frame));
    onFrame?.(world);
  }
}

/** Default run length in seconds: the whole script plus a second to see the outcome. */
export function defaultDuration(script: InputScript): number {
  return Math.max(2, script.totalFrames * FIXED_DT + 1);
}
