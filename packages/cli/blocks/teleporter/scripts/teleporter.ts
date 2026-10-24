import type { Script } from "@ludra/core";

/** Moves a player who steps on this pad onto the pad named by params.target. */
export default {
  touch({ self, world, params }, other) {
    if (!other.has("platformer") && !other.has("topdown")) return;
    // Arriving on the other pad touches it too; a short cooldown stops an instant trip back.
    if (world.time < ((self.state.cooldownUntil as number) ?? 0)) return;
    const target = world.get(params.target as string);
    if (!target) return;
    other.x = target.x;
    other.y = target.y - target.height / 2 - other.height / 2 - 2;
    other.vy = 0;
    target.state.cooldownUntil = world.time + 0.5;
    world.emit("teleport");
  },
} satisfies Script;
