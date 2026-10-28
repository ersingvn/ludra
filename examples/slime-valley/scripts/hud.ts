import type { DrawContext, Script } from "@ludra/core";

const FONT = "Chewy, system-ui, sans-serif";

/** Text with a thick leafy-green outline, so it reads on the bright sky. */
function label(g: DrawContext["g"], text: string, x: number, y: number, size: number, color = "#ffffff"): void {
  g.font = `${size}px ${FONT}`;
  g.lineJoin = "round";
  g.lineWidth = size * 0.24;
  g.strokeStyle = "#2f6b3e";
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** A coin slot: gold when collected, a dashed ring while still out there. */
function coin(g: DrawContext["g"], x: number, y: number, r: number, got: boolean): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  if (got) {
    g.fillStyle = "#ffd166";
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = "#c9871f";
    g.stroke();
    g.fillStyle = "rgba(255, 255, 255, 0.7)";
    g.fillRect(x - r * 0.15, y - r * 0.55, r * 0.3, r * 1.1);
  } else {
    g.setLineDash([4, 4]);
    g.lineWidth = 3;
    g.strokeStyle = "rgba(47, 107, 62, 0.6)";
    g.stroke();
    g.setLineDash([]);
  }
}

/** A slime slot: a little purple blob once one has been squashed, an outline before. */
function slime(g: DrawContext["g"], x: number, y: number, r: number, got: boolean): void {
  g.beginPath();
  g.moveTo(x - r, y + r * 0.7);
  g.bezierCurveTo(x - r, y - r * 1.1, x + r, y - r * 1.1, x + r, y + r * 0.7);
  g.closePath();
  if (got) {
    g.fillStyle = "#c77dff";
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillRect(x - r * 0.45, y - r * 0.2, r * 0.25, r * 0.35);
    g.fillRect(x + r * 0.2, y - r * 0.2, r * 0.25, r * 0.35);
  } else {
    g.setLineDash([4, 4]);
    g.lineWidth = 3;
    g.strokeStyle = "rgba(47, 107, 62, 0.6)";
    g.stroke();
    g.setLineDash([]);
  }
}

/**
 * What the flag asks for: a slot per coin (params.coins) and one for the slime, filled as they
 * are taken; the falls so far; a title card and the end screen.
 */
export default {
  drawUI({ g, world, view, time, recent, params }) {
    const total = params.coins as number;
    const coins = recent("collect", 1e9).length;
    const squashed = recent("stomp", 1e9).length > 0;
    // The newest find pops into its slot.
    const pop = (name: string) => {
      const e = recent(name, 0.35).at(-1);
      return e ? 1 + 0.5 * Math.sin(((time - e.time) / 0.35) * Math.PI) : 1;
    };
    for (let i = 0; i < total; i++) coin(g, 34 + i * 34, 32, 12 * (i === coins - 1 ? pop("collect") : 1), i < coins);
    slime(g, 34 + total * 34 + 4, 32, 13 * pop("stomp"), squashed);
    if (world.deaths > 0) {
      g.textAlign = "left";
      label(g, `${world.deaths} ${world.deaths === 1 ? "splat" : "splats"}`, 30 + (total + 1) * 34, 41, 22, "#ffe3e8");
    }

    if (time < 2.6 && !world.won) {
      g.globalAlpha = Math.min(1, (2.6 - time) / 0.8);
      g.textAlign = "center";
      label(g, "Slime Valley", view.width / 2, view.height / 2 - 20, 64, "#b8f5c4");
      label(g, `Find all ${total} coins and squash the slime: then the flag is yours`, view.width / 2, view.height / 2 + 24, 24);
      g.globalAlpha = 1;
    }

    g.textAlign = "right";
    label(g, "M sound  ·  R restart", view.width - 18, view.height - 14, 15, "rgba(255, 255, 255, 0.8)");

    if (world.won) {
      const end = recent("win", 1e9).at(-1);
      const since = end ? time - end.time : 0;
      g.fillStyle = `rgba(28, 72, 40, ${Math.min(0.55, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 2);
      const rise = Math.max(0, 1 - since * 2.5) * 20;
      g.textAlign = "center";
      label(g, "Valley crossed!", view.width / 2, view.height / 2 - 10 + rise, 66, "#ffe27a");
      const splats = world.deaths === 0 ? "without a single splat" : `with ${world.deaths} ${world.deaths === 1 ? "splat" : "splats"}`;
      label(g, `Every coin and the slime, ${splats}`, view.width / 2, view.height / 2 + 36 + rise, 26);
      label(g, "Press R to play again", view.width / 2, view.height / 2 + 72 + rise, 18, "rgba(255, 255, 255, 0.85)");
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
