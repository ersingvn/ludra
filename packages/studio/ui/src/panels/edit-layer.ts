// The viewport's editing tools (docs/editor.md, part B): a layer over the game that holds the pointer
// while the game is paused, the pick tool is on or the palette is placing. Click selects, drag moves
// (G grid snap, Shift one axis, Alt duplicates), and the keys: Delete, Ctrl+D, Ctrl+Z/Y, F, G, Esc.
// Everything the game draws for it (preview, ghost, grid, look) is presentation; edits go to the file.

import { h } from "../dom.ts";
import type { Studio } from "../studio.ts";
import { dragTo, entityBox, frameLook, screenScale, snap, toScreen, toWorld, type Point } from "../tools.ts";

/** How far (CSS px) the pointer moves before a press becomes a drag. */
const DRAG_START = 3;

interface Drag {
  id: string;
  from: Point;
  start: Point;
  startScreen: Point;
  to: Point;
  moved: boolean;
  copy: boolean;
  components: Record<string, unknown> | undefined;
}

export function editLayer(sizer: HTMLElement, head: HTMLElement, studio: Studio): void {
  const box = h("div", { class: "sel-box" }, ...["nw", "ne", "sw", "se"].map((c) => h("span", { class: `sel-handle ${c}` })), h("span", { class: "sel-label" }));
  const readout = h("div", { class: "edit-readout mono" });
  const layer = h("div", { class: "edit-layer", attrs: { "aria-label": "Edit the scene" } }, box, readout);
  sizer.append(layer);

  // The viewport head: grid toggle and size, F, and a hint of what the pointer does now.
  const gridBtn = h("button", { class: "mini-btn grid-btn", title: "Grid: show and snap to it (G)", text: "Grid", onclick: () => studio.setGrid(!studio.gridOn) });
  const gridSize = h("input", { class: "grid-size mono", attrs: { type: "number", min: "1", max: "512", step: "1", value: String(studio.gridSize), title: "Grid size in world px" } });
  gridSize.addEventListener("change", () => studio.setGrid(studio.gridOn, Number(gridSize.value) || studio.gridSize));
  const frameBtn = h("button", { class: "mini-btn", title: "Frame the selection (F); again to go back to the game's camera", text: "Frame", onclick: () => frame() });
  const hint = h("span", { class: "chip chip-dim edit-hint" });
  head.append(h("span", { class: "tool-group" }, gridBtn, gridSize, frameBtn), hint);

  let drag: Drag | null = null;
  let looking = false;
  let clearPreview: ReturnType<typeof setTimeout> | undefined;

  const twoD = () => studio.dimensions === 2;
  const active = () => twoD() && studio.view !== null && (studio.status.paused || studio.picking || studio.placing !== null);
  const local = (e: PointerEvent): Point => {
    const r = layer.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const refresh = () => {
    const on = active();
    layer.classList.toggle("on", on);
    layer.classList.toggle("placing", studio.placing !== null);
    gridBtn.classList.toggle("active", studio.gridOn);
    frameBtn.classList.toggle("active", looking);
    for (const el of [gridBtn, gridSize, frameBtn]) (el as HTMLButtonElement | HTMLInputElement).disabled = !twoD();
    hint.textContent = !twoD()
      ? "Editing tools are 2D only for now"
      : studio.placing
        ? `Click to place ${studio.placing.name} · Shift keeps placing · Esc stops`
        : on
          ? "Drag to move · Shift one axis · Alt copies · Del · Ctrl+D · Ctrl+Z"
          : "Pause (F5) to edit in the game";
    drawBox();
  };

  /** The selection's box on screen, where it is or where it is being dragged to. */
  const drawBox = () => {
    const view = studio.view;
    const id = studio.selected;
    const summary = id ? studio.entities.find((e) => e.id === id) : undefined;
    if (!view || !id || !summary || !twoD()) {
      box.hidden = true;
      return;
    }
    const data = studio.entity?.id === id ? studio.entity.components : undefined;
    const at = drag?.moved && drag.id === id && !drag.copy ? drag.to : data ? undefined : { x: summary.x, y: summary.y };
    const b = entityBox(data, at);
    const tl = toScreen(view, { x: b.x - b.width / 2, y: b.y - b.height / 2 });
    const k = screenScale(view);
    box.hidden = false;
    box.style.left = `${tl.x}px`;
    box.style.top = `${tl.y}px`;
    box.style.width = `${Math.max(4, b.width * k)}px`;
    box.style.height = `${Math.max(4, b.height * k)}px`;
    // The game's highlight already names it; while dragging, say where it goes instead.
    (box.lastChild as HTMLElement).textContent = drag?.moved && drag.id === id ? `${drag.copy ? "copy → " : ""}${drag.to.x}, ${drag.to.y}` : "";
  };

  const whereIs = (id: string): Point | undefined => {
    const t = studio.entity?.id === id ? (studio.entity.components.transform as Record<string, unknown> | undefined) : undefined;
    if (t && typeof t.x === "number" && typeof t.y === "number") return { x: t.x, y: t.y };
    const s = studio.entities.find((e) => e.id === id);
    return s ? { x: s.x, y: s.y } : undefined;
  };

  const insideBox = (p: Point) => {
    if (box.hidden) return false;
    const l = box.offsetLeft;
    const t = box.offsetTop;
    return p.x >= l - 4 && p.x <= l + box.offsetWidth + 4 && p.y >= t - 4 && p.y <= t + box.offsetHeight + 4;
  };

  layer.addEventListener("pointerdown", async (e) => {
    const view = studio.view;
    if (!active() || !view || e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const p = local(e);
    const world = toWorld(view, p);

    if (studio.placing) {
      const at = { x: snap(world.x, studio.snap), y: snap(world.y, studio.snap) };
      const what = studio.placing;
      if (!e.shiftKey) studio.setPlacing(null);
      if (what.kind === "block") return void (await studio.editor.placeBlock(what.name, at));
      const id = await studio.editor.placePrefab(what.name, at);
      if (id) studio.select(id);
      return;
    }

    // A press on the selection drags it even where something smaller overlaps it.
    const id = studio.selected && insideBox(p) ? studio.selected : await studio.pickAt(world);
    if (studio.picking) studio.setPicking(false);
    if (!id) {
      studio.select(null);
      return;
    }
    studio.select(id);
    const from = whereIs(id);
    if (!from) return;
    drag = { id, from, start: world, startScreen: p, to: from, moved: false, copy: e.altKey, components: undefined };
  });

  layer.addEventListener("pointermove", (e) => {
    const view = studio.view;
    if (!view) return;
    const p = local(e);
    const world = toWorld(view, p);
    readout.textContent = `${Math.round(world.x)}, ${Math.round(world.y)}`;
    if (studio.placing) {
      studio.ghost({ x: snap(world.x, studio.snap), y: snap(world.y, studio.snap) });
      return;
    }
    if (!drag) {
      layer.style.cursor = insideBox(p) ? "move" : "";
      return;
    }
    if (!drag.moved && Math.hypot(p.x - drag.startScreen.x, p.y - drag.startScreen.y) < DRAG_START) return;
    if (!drag.moved) {
      drag.moved = true;
      const c = studio.entity?.id === drag.id ? studio.entity.components : undefined;
      drag.components = c ? { sprite: c.sprite, body: c.body } : undefined;
    }
    drag.to = dragTo(drag.from, drag.start, world, { grid: studio.snap, axisLock: e.shiftKey });
    if (drag.copy) studio.ghost(drag.to, drag.components ?? { sprite: { color: "#9aa5b1", width: 24, height: 24 } });
    else {
      clearTimeout(clearPreview);
      studio.preview(drag.id, drag.to);
    }
    drawBox();
  });

  const endDrag = async (commit: boolean) => {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return drawBox();
    const moved = d.to.x !== d.from.x || d.to.y !== d.from.y;
    if (d.copy) {
      studio.ghost(null);
      if (!commit || !moved) return drawBox();
      const id = await studio.editor.duplicate(d.id, { x: d.to.x - d.from.x, y: d.to.y - d.from.y });
      if (id) studio.select(id);
      return;
    }
    if (!commit || !moved) {
      studio.preview(null);
      return drawBox();
    }
    const ok = await studio.editor.move(d.id, d.to);
    // Keep drawing it where it was dropped until the hot reload puts it there for real.
    if (!ok) studio.preview(null);
    else clearPreview = setTimeout(() => studio.preview(null), 1500);
    drawBox();
  };
  layer.addEventListener("pointerup", () => void endDrag(true));
  layer.addEventListener("pointercancel", () => void endDrag(false));
  layer.addEventListener("pointerleave", () => {
    readout.textContent = "";
    if (studio.placing) studio.ghost(null);
  });
  studio.link.on("hot", () => {
    if (drag) return;
    clearTimeout(clearPreview);
    studio.preview(null);
  });

  const frame = () => {
    const view = studio.view;
    if (!view || !twoD()) return;
    if (looking || !studio.selected) {
      looking = false;
      studio.look(null);
    } else {
      const data = studio.entity?.id === studio.selected ? studio.entity.components : undefined;
      const at = whereIs(studio.selected);
      if (!at) return;
      looking = true;
      studio.look(frameLook(entityBox(data, at), view));
    }
    refresh();
  };

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const id = studio.selected;
    let action: (() => void) | undefined;
    if (ctrl && !e.shiftKey && key === "z") action = () => void studio.editor.undo();
    else if (ctrl && (key === "y" || (e.shiftKey && key === "z"))) action = () => void studio.editor.redo();
    else if (ctrl && !e.shiftKey && key === "d" && id) action = () => void studio.editor.duplicate(id, { x: studio.snap || 16, y: 0 }).then((n) => n && studio.select(n));
    else if (!ctrl && !e.altKey && (e.key === "Delete" || e.key === "Backspace") && id) action = () => void studio.editor.remove(id).then((ok) => ok && studio.select(null));
    else if (!ctrl && !e.altKey && key === "f" && twoD()) action = frame;
    else if (!ctrl && !e.altKey && key === "g" && twoD()) action = () => studio.setGrid(!studio.gridOn);
    else if (e.key === "Escape" && (studio.placing || looking || drag)) {
      action = () => {
        if (studio.placing) studio.setPlacing(null);
        else if (drag) void endDrag(false);
        else frame();
      };
    }
    if (!action) return;
    e.preventDefault();
    action();
  });

  studio.on("frame", frame);
  studio.on("status", refresh);
  studio.on("view", drawBox);
  studio.on("entity", drawBox);
  studio.on("entities", drawBox);
  studio.on("selection", () => {
    // A new selection while framed: look at it instead.
    if (looking) {
      looking = false;
      frame();
    }
    refresh();
  });
  studio.on("scene", () => {
    looking = false;
    refresh();
  });
  studio.on("picking", refresh);
  studio.on("placing", refresh);
  studio.on("grid", () => {
    gridSize.value = String(studio.gridSize);
    refresh();
  });
  refresh();
}
