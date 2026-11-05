import type { Action, SceneDef } from "./types.ts";

/**
 * The actions a game needs a player to have: from its player components, and from what its scripts
 * read (`input.held("action")`). On-screen controls show these and no others.
 */
export function actionsUsed(scenes: readonly SceneDef[], scriptSources: readonly string[] = []): Action[] {
  const used = new Set<Action>();
  const add = (...actions: Action[]) => actions.forEach((a) => used.add(a));
  for (const scene of scenes) {
    const entities = [...scene.entities, ...Object.values(scene.prefabs ?? {})] as { components?: Record<string, Record<string, unknown> | undefined> }[];
    for (const entity of entities) {
      const c = entity.components ?? {};
      if (c.platformer) add("left", "right", "jump");
      if (c.topdown) {
        const directions = c.topdown.directions ?? "8";
        if (directions !== "y") add("left", "right");
        if (directions !== "x") add("up", "down");
      }
    }
  }
  for (const source of scriptSources) {
    for (const [, action] of source.matchAll(/\b(?:held|pressed)\(\s*["'`](left|right|up|down|jump|action)["'`]/g)) add(action as Action);
  }
  return ACTION_ORDER.filter((a) => used.has(a));
}

const ACTION_ORDER: readonly Action[] = ["left", "right", "up", "down", "jump", "action"];

/** How far a stick must lean before it counts as a direction. */
const STICK_DEADZONE = 0.5;

/** What gamepads hold this frame, in the standard layout every browser maps pads to. */
export interface PadState {
  actions: Set<Action>;
  /** Start was just pressed: restart. */
  restart: boolean;
  /** Back/select was just pressed: mute. */
  mute: boolean;
}

/**
 * Reads gamepads once a frame. The left stick and the d-pad move, A (bottom) jumps, the other face
 * buttons are `action`, Start restarts and Back mutes. Any number of pads play as one player.
 */
export class Gamepads {
  private start = false;
  private back = false;

  poll(): PadState {
    const actions = new Set<Action>();
    let start = false;
    let back = false;
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const button = (i: number) => (pad.buttons[i]?.pressed ?? false) || (pad.buttons[i]?.value ?? 0) > 0.5;
      const [x = 0, y = 0] = pad.axes;
      if (button(14) || x < -STICK_DEADZONE) actions.add("left");
      if (button(15) || x > STICK_DEADZONE) actions.add("right");
      if (button(12) || y < -STICK_DEADZONE) actions.add("up");
      if (button(13) || y > STICK_DEADZONE) actions.add("down");
      if (button(0)) actions.add("jump");
      if (button(1) || button(2) || button(3)) actions.add("action");
      start ||= button(9);
      back ||= button(8);
    }
    const state = { actions, restart: start && !this.start, mute: back && !this.back };
    this.start = start;
    this.back = back;
    return state;
  }
}

interface Button {
  action: Action;
  element: HTMLElement;
}

const LABELS: Record<Action, string> = { left: "◀", right: "▶", up: "▲", down: "▼", jump: "⤒", action: "✦" };

/**
 * On-screen buttons for phones and tablets, shown once someone touches the page. Movement sits
 * under the left thumb and jump and action under the right. A finger can slide from one button to
 * the next without lifting, and several fingers can press at once.
 */
export class TouchControls {
  /** Actions pressed right now. */
  readonly held = new Set<Action>();
  readonly root: HTMLElement;
  private buttons: Button[] = [];
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly move: HTMLElement;
  private readonly act: HTMLElement;
  private shown = false;

  constructor(actions: readonly Action[], tools: { restart: () => void; mute: () => boolean; touched: () => void }) {
    const root = document.createElement("div");
    root.className = "ludra-touch";
    root.hidden = true;
    root.innerHTML = `<style>
  .ludra-touch { position: fixed; inset: 0; z-index: 10; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; font-family: system-ui, sans-serif; }
  .ludra-touch .pad { position: absolute; bottom: max(18px, env(safe-area-inset-bottom)); display: grid; gap: 10px; }
  .ludra-touch .move { left: max(18px, env(safe-area-inset-left)); }
  .ludra-touch .act { right: max(18px, env(safe-area-inset-right)); grid-auto-flow: column; align-items: end; }
  .ludra-touch .b { width: 68px; height: 68px; border-radius: 50%; display: grid; place-items: center; font-size: 26px; color: rgba(255,255,255,0.85); background: rgba(20,24,34,0.42); border: 2px solid rgba(255,255,255,0.35); box-sizing: border-box; }
  .ludra-touch .b.on { background: rgba(255,255,255,0.35); }
  .ludra-touch .act .b { width: 78px; height: 78px; }
  .ludra-touch .act .b[data-action="action"] { margin-bottom: 46px; }
  .ludra-touch .tools { position: absolute; top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); display: flex; gap: 8px; }
  .ludra-touch .tools button { width: 40px; height: 40px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.3); background: rgba(20,24,34,0.42); color: rgba(255,255,255,0.85); font-size: 18px; }
</style><div class="pad move"></div><div class="pad act"></div><div class="tools"><button type="button" data-tool="mute" aria-label="Sound">♪</button><button type="button" data-tool="restart" aria-label="Restart">↻</button></div>`;
    this.root = root;
    this.move = root.querySelector(".move")!;
    this.act = root.querySelector(".act")!;
    this.setActions(actions);

    const tool = (event: Event) => (event.target as HTMLElement).closest("button")?.dataset.tool;
    root.addEventListener("pointerdown", (event) => {
      const which = tool(event);
      if (which === "restart") return tools.restart();
      if (which === "mute") {
        (event.target as HTMLElement).textContent = tools.mute() ? "×" : "♪";
        return;
      }
      try {
        // A finger that slides off the buttons keeps pressing until it lifts.
        root.setPointerCapture(event.pointerId);
      } catch {
        // Not a pointer the browser tracks (one a test made up): it still presses.
      }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.update();
    });
    root.addEventListener("pointermove", (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.update();
    });
    const lift = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      this.update();
    };
    root.addEventListener("pointerup", lift);
    root.addEventListener("pointercancel", lift);
    // No long-press menu or text selection over the game.
    root.addEventListener("contextmenu", (event) => event.preventDefault());

    // Shown for touch only: a mouse or a keyboard never sees them.
    const show = (event: PointerEvent | TouchEvent) => {
      if ("pointerType" in event && event.pointerType !== "touch" && event.pointerType !== "pen") return;
      tools.touched();
      if (this.shown) return;
      this.shown = true;
      root.hidden = false;
      // The touch that revealed the buttons may already be on one.
      if ("pointerId" in event) {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.update();
      }
    };
    addEventListener("pointerdown", show, { capture: true });
    addEventListener("touchstart", show, { capture: true, passive: true });
    this.dispose = () => {
      removeEventListener("pointerdown", show, { capture: true });
      removeEventListener("touchstart", show, { capture: true });
      root.remove();
    };
  }

  readonly dispose: () => void;

  /** Lays out the buttons for these actions: a scene can need others than the one before. */
  setActions(actions: readonly Action[]): void {
    const has = (a: Action) => actions.includes(a);
    const button = (action: Action, area?: string) => {
      const element = document.createElement("div");
      element.className = "b";
      element.dataset.action = action;
      element.textContent = LABELS[action];
      if (area) element.style.gridArea = area;
      return { action, element };
    };
    const horizontal = has("left") || has("right");
    const vertical = has("up") || has("down");
    const move: Button[] = [];
    if (horizontal && vertical) {
      this.move.style.gridTemplateAreas = `". up ." "left . right" ". down ."`;
      move.push(button("up", "up"), button("left", "left"), button("right", "right"), button("down", "down"));
    } else if (vertical) {
      this.move.style.gridTemplateAreas = `"up" "down"`;
      move.push(button("up", "up"), button("down", "down"));
    } else {
      this.move.style.gridTemplateAreas = `"left right"`;
      if (horizontal) move.push(button("left", "left"), button("right", "right"));
    }
    const act = (["action", "jump"] as const).filter(has).map((a) => button(a));
    this.move.replaceChildren(...move.map((b) => b.element));
    this.act.replaceChildren(...act.map((b) => b.element));
    this.buttons = [...move, ...act];
    this.update();
  }

  /**
   * What the fingers press. On the movement pad a finger's direction from its middle decides, so it
   * can slide round and press diagonals; elsewhere a finger presses the nearest button it's close
   * to, a little generously, because thumbs don't aim.
   */
  private update(): void {
    this.held.clear();
    const inside = (r: DOMRect, x: number, y: number, slack: number) => x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;
    const movable = new Set(this.buttons.filter((b) => b.element.parentElement === this.move).map((b) => b.action));
    const pad = this.move.getBoundingClientRect();
    for (const { x, y } of this.pointers.values()) {
      if (movable.size > 0 && inside(pad, x, y, 28)) {
        const dx = x - (pad.left + pad.width / 2);
        const dy = y - (pad.top + pad.height / 2);
        // The middle of a pad presses nothing, and one axis only when the finger leans that way.
        const dead = 16;
        if (movable.has("left") && dx < -dead && Math.abs(dx) * 2.4 > Math.abs(dy)) this.held.add("left");
        if (movable.has("right") && dx > dead && Math.abs(dx) * 2.4 > Math.abs(dy)) this.held.add("right");
        if (movable.has("up") && dy < -dead && Math.abs(dy) * 2.4 > Math.abs(dx)) this.held.add("up");
        if (movable.has("down") && dy > dead && Math.abs(dy) * 2.4 > Math.abs(dx)) this.held.add("down");
        // One row of two buttons: wherever the finger is, it's on one of them.
        if (!movable.has("up") && !movable.has("down") && Math.abs(dx) <= dead) this.held.add(dx < 0 ? "left" : "right");
        continue;
      }
      let nearest: Button | undefined;
      let best = Infinity;
      for (const button of this.buttons) {
        if (movable.has(button.action)) continue;
        const r = button.element.getBoundingClientRect();
        const distance = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (inside(r, x, y, 18) && distance < best) {
          best = distance;
          nearest = button;
        }
      }
      if (nearest) this.held.add(nearest.action);
    }
    for (const { action, element } of this.buttons) element.classList.toggle("on", this.held.has(action));
  }
}
