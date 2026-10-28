import type { Script } from "@ludra/core";

/** A solid door. Once a key has unlocked it, it opens (disappears) when a player walks into it. */
export default {
  start({ self }) {
    self.state.unlocked ??= false;
  },
  update({ self, world }) {
    const player = world.player();
    if (self.state.unlocked && player && self.touches(player)) {
      world.emit("door-open");
      world.destroy(self);
    }
  },
} satisfies Script;
