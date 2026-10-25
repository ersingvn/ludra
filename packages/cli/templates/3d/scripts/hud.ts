import type { DrawContext, Script } from "@ludra/core";

const FONT = "Fredoka, system-ui, sans-serif";

/** Text with a soft dark outline, so it reads over the sky and the ground alike. */
function label(g: DrawContext["g"], text: string, x: number, y: number, size: number, color = "#fff7e6", weight = 600): void {
  g.font = `${weight} ${size}px ${FONT}`;
  g.lineJoin = "round";
  g.lineWidth = size * 0.22;
  g.strokeStyle = "rgba(14, 18, 40, 0.85)";
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/** A sky crystal: a faceted diamond with a cool glow. */
function crystal(g: DrawContext["g"], x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - r * 1.2);
  g.lineTo(x + r * 0.75, y - r * 0.2);
  g.lineTo(x, y + r * 1.2);
  g.lineTo(x - r * 0.75, y - r * 0.2);
  g.closePath();
  const fill = g.createLinearGradient(x - r, y - r, x + r, y + r);
  fill.addColorStop(0, "#b8f3ff");
  fill.addColorStop(1, "#5b8cff");
  g.fillStyle = fill;
  g.shadowColor = "#7fd4ff";
  g.shadowBlur = 12;
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = "rgba(255, 255, 255, 0.7)";
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(x - r * 0.75, y - r * 0.2);
  g.lineTo(x + r * 0.75, y - r * 0.2);
  g.stroke();
}

function heart(g: DrawContext["g"], x: number, y: number, size: number, full: boolean): void {
  g.beginPath();
  g.moveTo(x, y + size * 0.3);
  g.bezierCurveTo(x, y - size * 0.2, x - size, y - size * 0.2, x - size, y + size * 0.3);
  g.bezierCurveTo(x - size, y + size * 0.75, x, y + size, x, y + size * 1.2);
  g.bezierCurveTo(x, y + size, x + size, y + size * 0.75, x + size, y + size * 0.3);
  g.bezierCurveTo(x + size, y - size * 0.2, x, y - size * 0.2, x, y + size * 0.3);
  g.fillStyle = full ? "#ff5d73" : "rgba(255, 255, 255, 0.18)";
  g.fill();
}

/**
 * The interface: hearts for lives, crystals collected, a title card for the level
 * (params.title, params.level) and the end screens. A won level with a next
 * scene says so; the last one celebrates the whole run.
 */
export default {
  drawUI({ g, world, view, time, recent, params }) {
    // Lives: a heart pops when one is lost.
    const hurt = recent("die", 0.4).at(-1);
    const maxLives = Math.max(world.lives ?? 0, params.lives as number);
    for (let i = 0; i < maxLives; i++) {
      const full = i < (world.lives ?? 0);
      const pop = !full && hurt && i === world.lives ? 1 + 0.6 * (1 - (time - hurt.time) / 0.4) : 1;
      heart(g, 34 + i * 30, 22, 9 * pop, full);
    }

    // Points, with a hop whenever some are earned.
    const got = [...recent("collect", 0.3), ...recent("stomp", 0.3)].sort((a, b) => a.time - b.time).at(-1);
    const bounce = got ? Math.sin(((time - got.time) / 0.3) * Math.PI) * 6 : 0;
    crystal(g, 35, 61 - bounce, 11);
    g.textAlign = "left";
    label(g, `${world.score}`, 54, 68 - bounce * 0.5, 22);

    // Title card.
    if (time < 2.6 && !world.won) {
      g.globalAlpha = Math.min(1, (2.6 - time) / 0.8);
      g.textAlign = "center";
      label(g, `Level ${params.level}`, view.width / 2, view.height / 2 - 46, 20, "#ffd166");
      label(g, String(params.title), view.width / 2, view.height / 2, 52, "#fff7e6", 700);
      g.globalAlpha = 1;
    }

    // A checkpoint caught: a short note under the hearts.
    const saved = recent("checkpoint", 1.6).at(-1);
    if (saved) {
      g.globalAlpha = Math.min(1, (1.6 - (time - saved.time)) / 0.5);
      g.textAlign = "left";
      label(g, "Checkpoint!", 24, 100, 16, "#ffd166");
      g.globalAlpha = 1;
    }

    g.textAlign = "right";
    label(g, "M sound  ·  R restart", view.width - 20, view.height - 16, 12, "rgba(255, 247, 230, 0.55)", 500);

    const end = recent(world.won ? "win" : "gameover", 1e9).at(-1);
    if (world.won || world.lost) {
      const since = end ? time - end.time : 0;
      g.fillStyle = `rgba(10, 12, 30, ${Math.min(0.6, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 2);
      g.textAlign = "center";
      // Each line rises into place.
      const rise = Math.max(0, 1 - since * 2.5) * 20;
      if (world.lost) {
        label(g, "Game over", view.width / 2, view.height / 2 - 6 + rise, 56, "#ff8fa0", 700);
        label(g, `${world.score} crystal${world.score === 1 ? "" : "s"} this run`, view.width / 2, view.height / 2 + 34 + rise, 20);
        label(g, "Press R to start over", view.width / 2, view.height / 2 + 68 + rise, 15, "rgba(255, 247, 230, 0.7)", 500);
      } else if (world.exit !== undefined) {
        label(g, "Level clear!", view.width / 2, view.height / 2 - 6 + rise, 56, "#7cf29c", 700);
        label(g, "On to the next one…", view.width / 2, view.height / 2 + 34 + rise, 20);
      } else {
        label(g, "The sky is yours!", view.width / 2, view.height / 2 - 6 + rise, 56, "#7cf29c", 700);
        const falls = world.deaths === 0 ? "without a single fall" : `with ${world.deaths} fall${world.deaths === 1 ? "" : "s"}`;
        label(g, `${world.score} crystals, ${falls}`, view.width / 2, view.height / 2 + 34 + rise, 20);
        label(g, "Press R to play this level again", view.width / 2, view.height / 2 + 68 + rise, 15, "rgba(255, 247, 230, 0.7)", 500);
      }
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
