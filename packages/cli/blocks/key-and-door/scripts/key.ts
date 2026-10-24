import type { Script } from "@ludra/core";

/** Picked up by a player; unlocks the door named by params.door. */
export default {
  touch({ self, world, params }, other) {
    if (!other.has("platformer") && !other.has("topdown")) return;
    const door = world.get(params.door as string);
    if (door) door.state.unlocked = true;
    world.emit("key");
    world.destroy(self);
  },
} satisfies Script;
