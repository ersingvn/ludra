import type { Script } from "@ludra/core";

/** A solid door that opens (disappears) when a player carrying a key walks into it. */
export default {
  update({ self, world }) {
    const player = world.player();
    if (player?.state.hasKey && self.touches(player)) {
      world.emit("door-open");
      world.destroy(self);
    }
  },
} satisfies Script;
