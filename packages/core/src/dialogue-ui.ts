/**
 * The default conversation box: a calm panel at the bottom of the screen with the speaker,
 * the line wrapped to fit, and the choices. Drawn by the browser when `world.talking` is set
 * and the game has no `drawUI` of its own (a game that has one draws the conversation itself,
 * from `world.talking`). Presentation only: it reads the world and changes nothing.
 */
import type { Talking } from "./story.ts";

const PAD = 18;
const FONT = "system-ui, sans-serif";

export function drawDialogue(
  ctx: CanvasRenderingContext2D,
  world: { readonly talking: Talking | undefined; get?(id: string): { transform: { x: number; y: number } } | undefined },
  view: { width: number; height: number; touch?: boolean; cameraY?: number; zoom?: number },
): void {
  const talking = world.talking;
  if (!talking) return;
  const scale = Math.max(0.75, Math.min(1.5, view.height / 540));
  const textSize = Math.round(18 * scale);
  const lineHeight = Math.round(textSize * 1.4);
  const width = Math.min(view.width - 32 * scale, 760 * scale);
  const left = (view.width - width) / 2;
  const inner = width - PAD * 2 * scale;

  ctx.save();
  ctx.font = `500 ${textSize}px ${FONT}`;
  const lines = wrap(ctx, talking.text, inner);
  const choiceLines = talking.choices.map((choice) => wrap(ctx, choice, inner - 22 * scale));
  const speakerHeight = talking.speaker ? Math.round(lineHeight * 1.05) : 0;
  const choicesHeight = choiceLines.reduce((sum, c) => sum + c.length * lineHeight, 0) + (talking.choices.length > 0 ? lineHeight * 0.4 : 0);
  const hintHeight = Math.round(lineHeight * 0.9);
  const height = PAD * scale * 2 + speakerHeight + lines.length * lineHeight + choicesHeight + hintHeight;
  // At the bottom, unless that would cover who is talking (people stand on the ground): then at the top, below the HUD line.
  const speaker = world.get?.(talking.entity);
  const speakerY = speaker && view.cameraY !== undefined ? (speaker.transform.y - view.cameraY) * (view.zoom ?? 1) : undefined;
  const bottom = view.height - height - 16 * scale;
  const top = speakerY !== undefined && speakerY > bottom - 40 * scale ? 48 * scale : bottom;

  // The panel.
  ctx.fillStyle = "rgba(12, 14, 22, 0.88)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  roundRect(ctx, left, top, width, height, 10 * scale);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let y = top + PAD * scale;
  const x = left + PAD * scale;
  if (talking.speaker) {
    ctx.font = `700 ${Math.round(textSize * 0.9)}px ${FONT}`;
    ctx.fillStyle = "#ffd166";
    ctx.fillText(talking.speaker, x, y);
    y += speakerHeight;
  }
  ctx.font = `500 ${textSize}px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  if (talking.choices.length > 0) y += lineHeight * 0.4;
  choiceLines.forEach((wrapped, i) => {
    const picked = i === talking.choice;
    ctx.fillStyle = picked ? "#ffd166" : "rgba(255, 255, 255, 0.7)";
    ctx.font = `${picked ? 700 : 500} ${textSize}px ${FONT}`;
    if (picked) ctx.fillText("▸", x, y);
    for (const line of wrapped) {
      ctx.fillText(line, x + 22 * scale, y);
      y += lineHeight;
    }
  });

  // What to press, quietly, bottom right.
  ctx.font = `500 ${Math.round(textSize * 0.7)}px ${FONT}`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.textAlign = "right";
  const go = view.touch ? "tap ✦" : "X / Enter";
  ctx.fillText(talking.choices.length > 0 ? `↑ ↓ choose · ${go}` : `${go} ▸`, left + width - PAD * scale, top + height - PAD * scale - textSize * 0.7);
  ctx.restore();
}

/** Splits text into lines no wider than `width` at the current font, keeping the author's line breaks. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && ctx.measureText(candidate).width > width) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
