import type { DrawContext, Script } from "@ludra/core";

const FONT = "Cinzel, Georgia, serif";

/** Carved-looking text: warm cream with a deep plum outline, readable on the sunset. */
function label(g: DrawContext["g"], text: string, x: number, y: number, size: number, color = "#fff1d6", weight = 700): void {
  g.font = `${weight} ${size}px ${FONT}`;
  g.lineJoin = "round";
  g.lineWidth = size * 0.2;
  g.strokeStyle = "rgba(45, 22, 80, 0.9)";
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** A coin slot: a sun-stamped gold disc once found, a dim ring before. */
function slot(g: DrawContext["g"], x: number, y: number, r: number, found: boolean): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  if (found) {
    g.fillStyle = "#ffcf4a";
    g.shadowColor = "#ffb347";
    g.shadowBlur = 12;
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2.5;
    g.strokeStyle = "#c9871f";
    g.stroke();
    g.fillStyle = "#e89b25";
    g.beginPath();
    g.arc(x, y, r * 0.38, 0, Math.PI * 2);
    g.fill();
  } else {
    g.lineWidth = 2.5;
    g.strokeStyle = "rgba(255, 241, 214, 0.45)";
    g.stroke();
  }
}

/**
 * Three coin slots (params.coins) that fill as the climb goes on, a note when the shrine wakes,
 * a title card and the end screen.
 */
export default {
  drawUI({ g, world, view, time, recent, params }) {
    const total = params.coins as number;
    const got = recent("collect", 0.35).at(-1);
    for (let i = 0; i < total; i++) {
      const pop = got && i === world.score - 1 ? 1 + 0.5 * Math.sin(((time - got.time) / 0.35) * Math.PI) : 1;
      slot(g, 34 + i * 36, 34, 12 * pop, i < world.score);
    }

    // The last coin wakes the shrine at the top.
    const last = recent("collect", 2).at(-1);
    if (last && world.score === total && !world.won) {
      g.globalAlpha = Math.min(1, (2 - (time - last.time)) / 0.5);
      g.textAlign = "left";
      label(g, "The shrine awakens!", 26 + total * 36, 42, 20, "#ffe39a");
      g.globalAlpha = 1;
    }

    if (time < 2.6 && !world.won) {
      g.globalAlpha = Math.min(1, (2.6 - time) / 0.8);
      g.textAlign = "center";
      label(g, "Coin Climb", view.width / 2, view.height / 2 - 30, 60);
      label(g, `Take the ${total} sun coins up the steps to wake the shrine`, view.width / 2, view.height / 2 + 14, 20, "#ffe39a", 400);
      g.globalAlpha = 1;
    }

    g.textAlign = "right";
    label(g, "M sound  ·  R restart", view.width - 18, view.height - 14, 13, "rgba(255, 241, 214, 0.75)", 400);

    if (world.won) {
      const end = recent("win", 1e9).at(-1);
      const since = end ? time - end.time : 0;
      g.fillStyle = `rgba(45, 22, 80, ${Math.min(0.55, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 2);
      const rise = Math.max(0, 1 - since * 2.5) * 20;
      g.textAlign = "center";
      label(g, "The summit is yours", view.width / 2, view.height / 2 - 10 + rise, 56, "#ffe39a");
      label(g, `${total} sun coins, climbed in ${(end?.time ?? time).toFixed(1)} seconds`, view.width / 2, view.height / 2 + 32 + rise, 22, "#fff1d6", 400);
      label(g, "Press R to climb again", view.width / 2, view.height / 2 + 66 + rise, 16, "rgba(255, 241, 214, 0.8)", 400);
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
