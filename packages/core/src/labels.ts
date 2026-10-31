/** A name to write at a point on a frame. */
export interface Label {
  text: string;
  x: number;
  y: number;
}

/** A label with its text placed: `textX, textY` is the text's top left corner, `x, y` the point it names. */
export interface PlacedLabel extends Label {
  textX: number;
  textY: number;
  width: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const LABEL_HEIGHT = 14;
const GAP = 4;
/** Points closer than this are one place on the map: "plaza, plaza-rock". */
const SAME_SPOT = 6;
/** How many rows up and down a label may move beside its point. */
const MAX_ROWS = 6;

/**
 * Puts each name next to its point so that no two overlap and none leaves the frame:
 * points in the same spot share a label, and when a point's own surroundings are full
 * its label moves further away (draw a line back to the point for those). A label that
 * can't fit anywhere stays above its point rather than being dropped.
 */
export function layoutLabels(labels: readonly Label[], measure: (text: string) => number, width: number, height: number): PlacedLabel[] {
  const spots: Label[] = [];
  for (const label of labels) {
    const spot = spots.find((s) => Math.hypot(s.x - label.x, s.y - label.y) < SAME_SPOT);
    if (spot) spot.text += `, ${label.text}`;
    else spots.push({ ...label });
  }

  const taken: Box[] = spots.map((s) => ({ left: s.x - 2, top: s.y - 2, right: s.x + 2, bottom: s.y + 2 }));
  const fits = (box: Box) => box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height && !taken.some((t) => overlap(t, box));

  return spots
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((spot) => {
      const textWidth = measure(spot.text);
      const boxAt = (left: number, top: number): Box => ({ left, top, right: left + textWidth, bottom: top + LABEL_HEIGHT });
      const above = boxAt(spot.x - textWidth / 2, spot.y - GAP - LABEL_HEIGHT);
      const candidates = [above, boxAt(spot.x - textWidth / 2, spot.y + GAP)];
      for (let row = 0; row <= MAX_ROWS; row++) {
        for (const top of row === 0 ? [spot.y - LABEL_HEIGHT / 2] : [spot.y - LABEL_HEIGHT / 2 - row * LABEL_HEIGHT, spot.y - LABEL_HEIGHT / 2 + row * LABEL_HEIGHT]) {
          candidates.push(boxAt(spot.x + GAP * 2, top), boxAt(spot.x - GAP * 2 - textWidth, top));
        }
      }
      const box = candidates.find(fits) ?? clamp(above, width, height);
      taken.push(box);
      return { ...spot, textX: box.left, textY: box.top, width: textWidth };
    });
}

function overlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function clamp(box: Box, width: number, height: number): Box {
  const left = Math.max(0, Math.min(box.left, width - (box.right - box.left)));
  const top = Math.max(0, Math.min(box.top, height - (box.bottom - box.top)));
  return { left, top, right: left + (box.right - box.left), bottom: top + (box.bottom - box.top) };
}
