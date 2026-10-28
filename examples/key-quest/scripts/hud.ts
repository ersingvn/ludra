import type { DrawContext, Script } from "@ludra/core";

const FONT = "MedievalSharp, Georgia, serif";

/** Gold text with a dark violet outline, like lettering on a castle banner. */
function label(g: DrawContext["g"], text: string, x: number, y: number, size: number, color = "#ffe6a8"): void {
  g.font = `${size}px ${FONT}`;
  g.lineJoin = "round";
  g.lineWidth = size * 0.2;
  g.strokeStyle = "rgba(18, 10, 34, 0.9)";
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** An old key: a ring, a shaft and two teeth. Solid gold once taken, a faint outline before. */
function key(g: DrawContext["g"], x: number, y: number, s: number, held: boolean): void {
  g.lineWidth = 3.5 * s;
  g.strokeStyle = held ? "#ffd166" : "rgba(255, 230, 168, 0.3)";
  if (held) {
    g.shadowColor = "#ffb347";
    g.shadowBlur = 12;
  }
  g.beginPath();
  g.arc(x - 10 * s, y, 7 * s, 0, Math.PI * 2);
  g.moveTo(x - 3 * s, y);
  g.lineTo(x + 16 * s, y);
  g.moveTo(x + 10 * s, y);
  g.lineTo(x + 10 * s, y + 6 * s);
  g.moveTo(x + 15 * s, y);
  g.lineTo(x + 15 * s, y + 8 * s);
  g.stroke();
  g.shadowBlur = 0;
}

/**
 * The clock is the whole game, so it gets the top of the screen: an hourglass and a bar that
 * drains, burning red in the last five seconds (it reads the clock's state.left). A key slot
 * fills when the key is taken. Then a title card, and the end screens.
 */
export default {
  drawUI({ g, world, view, time, recent, params }) {
    const total = params.seconds as number;
    const left = (world.get("clock")?.state.left as number | undefined) ?? total;
    const urgent = left < 5;
    const pulse = urgent ? 1 + 0.06 * Math.sin(time * 14) : 1;

    // The hourglass.
    const hx = 34;
    const hy = 34;
    g.save();
    g.translate(hx, hy);
    g.scale(pulse, pulse);
    g.strokeStyle = "#ffe6a8";
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(-10, -14);
    g.lineTo(10, -14);
    g.lineTo(-10, 14);
    g.lineTo(10, 14);
    g.closePath();
    g.stroke();
    g.fillStyle = urgent ? "#ff6b5d" : "#ffd166";
    const sand = left / total;
    g.beginPath();
    g.moveTo(-8 * sand, -12 + 12 * (1 - sand));
    g.lineTo(8 * sand, -12 + 12 * (1 - sand));
    g.lineTo(0, 0);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(0, 12 - 10 * (1 - sand));
    g.lineTo(-8 * (1 - sand), 12);
    g.lineTo(8 * (1 - sand), 12);
    g.closePath();
    g.fill();
    g.restore();

    // The bar, and the seconds left.
    const barX = 56;
    const barW = 220;
    g.fillStyle = "rgba(18, 10, 34, 0.7)";
    g.fillRect(barX, 26, barW, 16);
    g.fillStyle = urgent ? "#ff6b5d" : "#ffd166";
    g.fillRect(barX + 2, 28, (barW - 4) * (left / total), 12);
    g.textAlign = "left";
    label(g, `${Math.ceil(left)}s`, barX + barW + 10, 42, 22, urgent ? "#ff8f80" : "#ffe6a8");

    const held = world.player()?.state.hasKey === true;
    const taken = recent("key", 0.4).at(-1);
    key(g, 30 + barX + barW + 60, 34, taken ? 1 + 0.4 * Math.sin(((time - taken.time) / 0.4) * Math.PI) : 1, held);

    // A flash when the clock runs out.
    const out = recent("timeout", 0.8).at(-1);
    if (out) {
      g.fillStyle = `rgba(255, 80, 60, ${0.35 * (1 - (time - out.time) / 0.8)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.textAlign = "center";
      label(g, "Time's up!", view.width / 2, view.height / 2, 48, "#ff8f80");
    }

    if (time < 2.6 && !world.won) {
      g.globalAlpha = Math.min(1, (2.6 - time) / 0.8);
      g.textAlign = "center";
      label(g, "Key Quest", view.width / 2, view.height / 2 - 24, 64);
      label(g, `Take the key, open the door, reach the flag: ${total} seconds`, view.width / 2, view.height / 2 + 20, 22, "#f2e9ff");
      g.globalAlpha = 1;
    }

    g.textAlign = "right";
    label(g, "M sound  ·  R restart", view.width - 18, view.height - 14, 14, "rgba(242, 233, 255, 0.7)");

    if (world.won) {
      const end = recent("win", 1e9).at(-1);
      const since = end ? time - end.time : 0;
      g.fillStyle = `rgba(13, 10, 36, ${Math.min(0.6, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 2);
      const rise = Math.max(0, 1 - since * 2.5) * 20;
      g.textAlign = "center";
      label(g, "The quest is done!", view.width / 2, view.height / 2 - 10 + rise, 60);
      const spare = Math.ceil(left);
      label(g, `with ${spare} second${spare === 1 ? "" : "s"} to spare${world.deaths ? `, after ${world.deaths} ${world.deaths === 1 ? "try" : "tries"}` : ""}`, view.width / 2, view.height / 2 + 34 + rise, 24, "#f2e9ff");
      label(g, "Press R to try for a faster run", view.width / 2, view.height / 2 + 68 + rise, 16, "rgba(242, 233, 255, 0.75)");
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
