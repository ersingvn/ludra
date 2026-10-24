import type { DrawContext, Script } from "@ludra/core";

const TITLE = "Cinzel, Georgia, serif";

/** Centered text with a soft colored glow behind it. */
function glowText(g: DrawContext["g"], text: string, x: number, y: number, size: number, color: string, weight = 700): void {
  g.font = `${weight} ${size}px ${TITLE}`;
  g.textAlign = "center";
  g.shadowColor = color;
  g.shadowBlur = size * 0.5;
  g.fillStyle = "#fff7e6";
  g.fillText(text, x, y);
  g.shadowBlur = 0;
}

/**
 * The grove's interface: a title card, crystal slots that fill as they are
 * found (params.crystals), a message when the portal wakes, a flash on death
 * and the victory screen.
 */
export default {
  drawUI({ g, world, view, time, recent, image, params }) {
    const total = params.crystals as number;

    // Crystal slots, top left, on a dark leaf-shaped plate.
    g.fillStyle = "rgba(8, 14, 30, 0.55)";
    g.beginPath();
    g.roundRect(24, 18, 40 + total * 30, 44, 22);
    g.fill();
    const gem = image("assets/gem.svg");
    for (let i = 0; i < total; i++) {
      const x = 44 + i * 30;
      const found = i < world.score;
      const justFound = found && recent("collect", 0.5).length > 0 && i === world.score - 1;
      const pop = justFound ? 1 + 0.5 * (1 - (time - recent("collect", 0.5).at(-1)!.time) / 0.5) : 1;
      g.globalAlpha = found ? 1 : 0.25;
      g.shadowColor = "#2fb8ff";
      g.shadowBlur = found ? 14 : 0;
      if (gem) g.drawImage(gem, 0, 0, 20, 20, x - 10 * pop, 40 - 10 * pop, 20 * pop, 20 * pop);
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;

    // Title card that fades out as the hero sets off.
    if (time < 3 && !world.won) {
      g.globalAlpha = Math.min(1, (3 - time) / 1.2);
      glowText(g, "CRYSTAL GROVE", view.width / 2, view.height / 2 - 20, 54, "#7fd6ff");
      g.font = `400 16px ${TITLE}`;
      g.fillStyle = "rgba(255, 247, 230, 0.85)";
      g.fillText(`Gather the ${total} crystals and wake the portal`, view.width / 2, view.height / 2 + 18);
      g.globalAlpha = 1;
    }

    // The last crystal wakes the portal.
    const last = recent("collect", 2.5).find(() => world.score === total);
    if (last && !world.won) {
      g.globalAlpha = Math.min(1, (2.5 - (time - last.time)) / 0.8);
      glowText(g, "The portal awakens", view.width / 2, 90, 26, "#c77dff");
      g.globalAlpha = 1;
    }

    // Thorns and slimes hurt: a red pulse from the edges.
    const hurt = recent("die", 0.6).at(-1);
    if (hurt) {
      const edge = g.createRadialGradient(view.width / 2, view.height / 2, view.height * 0.25, view.width / 2, view.height / 2, view.width * 0.7);
      edge.addColorStop(0, "rgba(160, 0, 30, 0)");
      edge.addColorStop(1, `rgba(160, 0, 30, ${0.65 * (1 - (time - hurt.time) / 0.6)})`);
      g.fillStyle = edge;
      g.fillRect(0, 0, view.width, view.height);
    }

    g.font = `400 11px ${TITLE}`;
    g.textAlign = "right";
    g.fillStyle = "rgba(255, 247, 230, 0.4)";
    g.fillText("M sound  ·  R restart", view.width - 24, view.height - 16);

    if (world.won) {
      const win = recent("win", 1e9).at(-1);
      const since = win ? time - win.time : 0;
      g.fillStyle = `rgba(4, 6, 20, ${Math.min(0.65, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 1.5);
      glowText(g, "THE GROVE IS AT PEACE", view.width / 2, view.height / 2 - 8, 44, "#b25cff");
      g.font = `400 18px ${TITLE}`;
      g.fillStyle = "rgba(255, 247, 230, 0.9)";
      const falls = world.deaths === 0 ? "without a scratch" : `after ${world.deaths} fall${world.deaths === 1 ? "" : "s"}`;
      g.fillText(`${total} crystals in ${(win?.time ?? time).toFixed(1)}s, ${falls}`, view.width / 2, view.height / 2 + 32);
      g.font = `400 13px ${TITLE}`;
      g.fillStyle = "rgba(255, 247, 230, 0.55)";
      g.fillText("Press R to wander again", view.width / 2, view.height / 2 + 66);
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
