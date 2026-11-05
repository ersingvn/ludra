import { clear, h } from "../dom.ts";
import { icon } from "../icons.ts";
import type { Studio, Toast } from "../studio.ts";

const TOAST_MS = 4200;
const MAX_TOASTS = 4;

export function viewport(root: HTMLElement, studio: Studio): HTMLIFrameElement {
  const frame = h("iframe", {
    class: "game-frame",
    attrs: { src: studio.backend.gameUrl, title: "Game", allow: "autoplay; gamepad; fullscreen" },
  });
  const sizer = h("div", { class: "game-sizer" }, frame);
  const stage = h("div", { class: "game-stage" }, sizer);

  const frameChip = h("span", { class: "chip mono" });
  const pausedChip = h("span", { class: "chip chip-paused", text: "PAUSED" });
  const resultChip = h("span", { class: "chip" });
  const sceneChip = h("span", { class: "chip chip-dim mono" });
  const hud = h("span", { class: "chip chip-dim mono" });
  const toasts = h("div", { class: "toasts", attrs: { "aria-live": "polite" } });
  const pickBanner = h(
    "div",
    { class: "pick-banner" },
    icon("pick"),
    h("span", { text: "Click an entity in the game to select it" }),
    h("kbd", { text: "Esc" }),
  );
  const offline = h("div", { class: "offline" }, h("div", { class: "spinner" }), h("span", { text: "Connecting to ludra dev…" }));

  clear(
    root,
    h(
      "div",
      { class: "viewport-head" },
      h("span", { class: "panel-title" }, icon("play", "muted"), " Game"),
      sceneChip,
      h("span", { class: "tb-spacer" }),
      hud,
    ),
    h(
      "div",
      { class: "viewport" },
      stage,
      h("div", { class: "overlay-tl" }, frameChip, pausedChip, resultChip),
      pickBanner,
      toasts,
      offline,
    ),
  );
  studio.link.attach(frame);

  // Keep the game at its aspect ratio, as large as fits.
  const fit = () => {
    const { width: gw, height: gh } = studio.gameSize;
    const w = stage.clientWidth;
    const hgt = stage.clientHeight;
    if (w <= 0 || hgt <= 0) return;
    const scale = Math.min(w / gw, hgt / gh);
    sizer.style.width = `${Math.floor(gw * scale)}px`;
    sizer.style.height = `${Math.floor(gh * scale)}px`;
  };
  new ResizeObserver(fit).observe(stage);
  window.addEventListener("ludra:layout", fit);

  let lastFrame = -1;
  studio.on("status", (s) => {
    if (s.frame !== lastFrame) {
      lastFrame = s.frame;
      frameChip.textContent = `${(s.frame / 60).toFixed(1)} s · f${s.frame}`;
    }
    pausedChip.hidden = !s.paused;
    resultChip.hidden = !s.won && !s.lost;
    resultChip.textContent = s.won ? "WON" : s.lost ? "LOST" : "";
    resultChip.className = `chip ${s.won ? "chip-won" : "chip-lost"}`;
    hud.textContent = `score ${s.score} · lives ${s.lives} · deaths ${s.deaths}`;
  });
  pausedChip.hidden = true;
  resultChip.hidden = true;

  studio.on("scene", (scene) => {
    sceneChip.textContent = `${scene ?? ""}  ·  ${studio.dimensions}D${studio.physics ? ` · ${studio.physics}` : ""}`;
    offline.hidden = true;
    fit();
  });
  studio.on("project", fit);
  studio.on("picking", (on) => {
    pickBanner.classList.toggle("show", on);
    root.classList.toggle("picking", on);
  });
  studio.on("connection", (c) => {
    if (c === "live") return;
    if (c === "lost" || studio.scene === null) {
      offline.hidden = false;
      (offline.lastChild as HTMLElement).textContent = c === "lost" ? "Lost ludra dev. Is it still running?" : "Connecting to ludra dev…";
    }
  });
  studio.on("connection", (c) => {
    if (c !== "live") return;
    if (studio.scene !== null) offline.hidden = true;
    // The game page failed to load while the server was down: load it again.
    else frame.src = studio.backend.gameUrl;
  });

  studio.on("toast", (t) => showToast(toasts, t));

  // A click on the empty stage hands the keyboard to the game.
  stage.addEventListener("mousedown", (e) => {
    if (e.target === stage) studio.focusGame();
  });
  return frame;
}

function showToast(root: HTMLElement, t: Toast): void {
  const kindIcon = t.kind === "kept" ? "bolt" : t.kind === "restarted" ? "restart" : t.kind === "info" ? "info" : "warning";
  const el = h(
    "div",
    { class: `toast toast-${t.kind}`, attrs: { role: "status" } },
    h("span", { class: "toast-icon" }, icon(kindIcon)),
    h("div", { class: "toast-text" }, h("div", { class: "toast-title", text: t.title }), t.detail ? h("div", { class: "toast-detail", text: t.detail }) : null),
  );
  root.prepend(el);
  while (root.children.length > MAX_TOASTS) root.lastElementChild?.remove();
  requestAnimationFrame(() => el.classList.add("in"));
  const ms = t.kind === "rejected" || t.kind === "error" ? TOAST_MS * 1.6 : TOAST_MS;
  setTimeout(() => {
    el.classList.remove("in");
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  }, ms);
}
