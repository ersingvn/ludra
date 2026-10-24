import type { Script } from "@ludra/core";

/** Launches whatever lands on it straight up. params.power: launch speed in px/s. */
export default {
  touch({ world, params }, other) {
    if (!other.has("platformer")) return;
    other.vy = -(params.power as number);
    world.emit("boing");
  },
} satisfies Script;
