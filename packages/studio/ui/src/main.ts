import { ServerBackend, type Backend } from "./backend.ts";
import { $, clear, h } from "./dom.ts";
import { icon } from "./icons.ts";
import { initLayout } from "./layout.ts";
import { bottom } from "./panels/bottom.ts";
import { hierarchy } from "./panels/hierarchy.ts";
import { inspector } from "./panels/inspector.ts";
import { tabFor, toolbar } from "./panels/toolbar.ts";
import { viewport } from "./panels/viewport.ts";
import type { Command } from "./protocol.ts";
import { Studio } from "./studio.ts";

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const server = params.get("server");
  const mock = params.has("mock") || !server;
  let backend: Backend;
  let startMock: ((studio: Studio) => void) | undefined;
  if (mock) {
    const m = await import("./mock/backend.ts");
    const b = new m.MockBackend();
    backend = b;
    startMock = (studio) => b.start(studio);
  } else {
    backend = new ServerBackend(server);
  }

  const app = $("#app");
  document.body.classList.toggle("in-electron", Boolean(window.studio));
  const studio = new Studio(backend, mock);
  toolbar($("#toolbar"), studio);
  hierarchy($("#left"), studio);
  viewport($("#center"), studio);
  inspector($("#right"), studio);
  bottom($("#bottom"), studio);
  statusbar($("#statusbar"), studio, mock ? "mock" : server!);
  initLayout(app);
  shortcuts(studio);
  app.classList.add("ready");
  await studio.start();
  startMock?.(studio);
}

function statusbar(root: HTMLElement, studio: Studio, server: string): void {
  const dot = h("span", { class: "conn-dot" });
  const conn = h("span", { class: "sb-item" }, dot, h("span", { text: server === "mock" ? "Mock game (no server)" : server.replace(/^https?:\/\//, "") }));
  const scene = h("span", { class: "sb-item mono" });
  const count = h("span", { class: "sb-item" });
  const sel = h("span", { class: "sb-item mono" });
  const keys = h("span", { class: "sb-item sb-keys", text: "F5 play · F10 step · Ctrl+R restart · Ctrl+Shift+C check · Ctrl+Shift+T test" });
  clear(
    root,
    conn,
    scene,
    count,
    sel,
    h("span", { class: "tb-spacer" }),
    keys,
    window.studio ? h("span", { class: "sb-item", text: `Studio ${window.studio.version}` }) : h("span", { class: "sb-item", text: "Browser" }),
  );
  const setConn = (c: string) => {
    dot.className = `conn-dot ${c}`;
    conn.title = c === "live" ? "Connected to ludra dev" : c === "lost" ? "Disconnected" : "Connecting…";
  };
  setConn(server === "mock" ? "live" : "connecting");
  studio.on("connection", setConn);
  studio.on("scene", (s) => (scene.textContent = s ?? ""));
  studio.on("entities", (l) => (count.textContent = `${l.length} entities`));
  studio.on("selection", (id) => (sel.textContent = id ? `selected: ${id}` : ""));
}

function shortcuts(studio: Studio): void {
  const run = (command: Command) => {
    void studio.runCommand(command);
    studio.showTab(tabFor(command));
  };
  const menu: Record<string, () => void> = {
    play: () => studio.togglePlay(),
    pause: () => studio.togglePlay(),
    step: () => studio.step(),
    restart: () => studio.restart(),
    pick: () => studio.setPicking(!studio.picking),
    check: () => run("check"),
    test: () => run("test"),
    review: () => run("review"),
  };
  // In Electron the native menu owns these keys and sends them through onMenu.
  window.studio?.onMenu((command) => menu[command]?.());
  const electron = Boolean(window.studio);

  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === "Escape" && studio.picking) {
      studio.setPicking(false);
      return;
    }
    if (electron) return;
    let action: (() => void) | undefined;
    if (e.key === "F5" && !ctrl) action = menu.play;
    else if (e.key === "F10") action = menu.step;
    else if (ctrl && !e.shiftKey && key === "r") action = menu.restart;
    else if (ctrl && e.shiftKey && key === "c") action = menu.check;
    else if (ctrl && e.shiftKey && key === "t") action = menu.test;
    else if (ctrl && !e.shiftKey && key === "p") action = menu.pick;
    else if (!typing && !ctrl && e.key === " " && document.activeElement === document.body) action = menu.play;
    if (!action) return;
    e.preventDefault();
    action();
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.append(h("div", { class: "fatal" }, icon("error"), h("span", { text: `Studio couldn't start: ${err instanceof Error ? err.message : String(err)}` })));
});
