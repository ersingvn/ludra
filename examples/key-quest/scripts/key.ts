import type { Script } from "@ludra/core";

/** Gives the key to the player that touches it. Doors check player.state.hasKey. */
export default {
  touch({ self, world }, other) {
    if (!other.has("platformer")) return;
    other.state.hasKey = true;
    world.emit("key");
    world.destroy(self);
  },
} satisfies Script;
