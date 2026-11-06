import { clear, h } from "../dom.ts";
import { icon } from "../icons.ts";
import type { CheckResult, Command, ReviewResult, TestRunResult } from "../protocol.ts";
import type { Studio } from "../studio.ts";

export function toolbar(root: HTMLElement, studio: Studio): void {
  const name = h("span", { class: "project-name", text: "…" });
  const dir = h("span", { class: "project-dir" });
  const open = window.studio
    ? h("button", { class: "tb-btn icon-only", title: "Open project… (Ctrl+O)", onclick: () => window.studio?.openProject() }, icon("folder"))
    : null;

  const scenes = h("select", { class: "scene-picker", title: "Scene", onchange: () => studio.goto(scenes.value) });

  const play = h("button", { class: "tb-btn icon-only play", title: "Play / Pause (F5)", onclick: () => studio.togglePlay() });
  const step = h("button", { class: "tb-btn icon-only", title: "Step one frame (F10)", onclick: () => studio.step() }, icon("step"));
  const restart = h("button", { class: "tb-btn icon-only", title: "Restart (Ctrl+R)", onclick: () => studio.restart() }, icon("restart"));
  const frame = h("span", { class: "readout-value mono", text: "0" });
  const time = h("span", { class: "readout-sub mono", text: "0.0 s" });
  const fps = h("span", { class: "readout-value mono", text: "–" });
  const pick = h("button", { class: "tb-btn icon-only", title: "Pick an entity in the game (Esc to cancel)", onclick: () => studio.setPicking(!studio.picking) }, icon("pick"));
  const mute = h("button", { class: "tb-btn icon-only", title: "Mute", onclick: () => studio.setMuted(!studio.muted) });

  const runButton = (command: Command, label: string, iconName: string, shortcut: string) => {
    const badge = h("span", { class: "badge" });
    const btn = h(
      "button",
      { class: "tb-btn run", title: `ludra ${command} (${shortcut})`, onclick: () => { void studio.runCommand(command); studio.showTab(tabFor(command)); } },
      icon(iconName),
      h("span", { text: label }),
      badge,
    );
    return { btn, badge };
  };
  const runs = {
    check: runButton("check", "Check", "check", "Ctrl+Shift+C"),
    test: runButton("test", "Test", "flask", "Ctrl+Shift+T"),
    review: runButton("review", "Review", "review", "no shortcut"),
  };

  clear(
    root,
    h("div", { class: "tb-group brand" }, h("span", { class: "logo", html: LOGO }), h("div", { class: "project" }, name, dir), open),
    h("div", { class: "tb-sep" }),
    h("div", { class: "tb-group" }, icon("scene", "muted"), scenes),
    h("div", { class: "tb-sep" }),
    h("div", { class: "tb-group transport" }, play, step, restart),
    h(
      "div",
      { class: "tb-group readouts" },
      h("div", { class: "readout", title: "Frame and game time" }, h("span", { class: "readout-label", text: "FRAME" }), frame, time),
      h("div", { class: "readout", title: "Frames drawn per second" }, h("span", { class: "readout-label", text: "FPS" }), fps),
    ),
    h("div", { class: "tb-sep" }),
    h("div", { class: "tb-group" }, pick, mute),
    h("div", { class: "tb-spacer" }),
    h("div", { class: "tb-group runs" }, runs.check.btn, runs.test.btn, runs.review.btn),
  );

  const renderPlay = () => {
    const paused = studio.status.paused;
    clear(play, icon(paused ? "play" : "pause"));
    play.classList.toggle("is-paused", paused);
    play.title = paused ? "Play (F5)" : "Pause (F5)";
  };
  renderPlay();
  clear(mute, icon("volume"));

  studio.on("project", (p) => {
    name.textContent = p.name;
    dir.textContent = p.dir;
    dir.title = p.dir;
    clear(scenes, p.scenes.map((s) => h("option", { text: s.replace(/^scenes\//, "").replace(/\.scene\.json$/, ""), attrs: { value: s } })));
    if (studio.scene) scenes.value = studio.scene;
  });
  studio.on("scene", (s) => {
    if (s && ![...scenes.options].some((o) => o.value === s)) scenes.append(h("option", { text: s, attrs: { value: s } }));
    if (s) scenes.value = s;
  });
  let lastPaused: boolean | null = null;
  studio.on("status", (s) => {
    frame.textContent = s.frame.toLocaleString("en-US");
    time.textContent = `${(s.frame / 60).toFixed(1)} s`;
    fps.textContent = s.paused ? "–" : String(Math.round(s.fps));
    if (s.paused !== lastPaused) {
      lastPaused = s.paused;
      renderPlay();
    }
  });
  studio.on("picking", (on) => pick.classList.toggle("active", on));
  studio.on("muted", (on) => {
    clear(mute, icon(on ? "muted" : "volume"));
    mute.classList.toggle("active", on);
    mute.title = on ? "Unmute" : "Mute";
  });
  studio.on("run", (command) => {
    const { btn, badge } = runs[command];
    const state = studio.runs[command];
    btn.classList.toggle("running", state.running);
    if (state.running) {
      badge.className = "badge spin";
      badge.textContent = "";
      return;
    }
    const b = badgeFor(command, state.response?.result, state.error);
    badge.className = `badge ${b.kind}`;
    badge.textContent = b.text;
    btn.title = `ludra ${command}: ${b.title}`;
  });
}

export function tabFor(command: Command): string {
  return command === "check" ? "problems" : command === "test" ? "tests" : "review";
}

function badgeFor(command: Command, result: unknown, error?: string): { kind: string; text: string; title: string } {
  if (error) return { kind: "bad", text: "!", title: error };
  if (!result) return { kind: "", text: "", title: "not run yet" };
  if (command === "check") {
    const r = result as CheckResult;
    if (r.errors > 0) return { kind: "bad", text: String(r.errors), title: `${r.errors} error(s), ${r.warnings} warning(s)` };
    if (r.warnings > 0) return { kind: "warn", text: String(r.warnings), title: `${r.warnings} warning(s)` };
    return { kind: "good", text: "✓", title: "no problems" };
  }
  if (command === "test") {
    const r = result as TestRunResult;
    if (r.error) return { kind: "warn", text: "0", title: r.error };
    if ((r.failed ?? 0) > 0) return { kind: "bad", text: `${r.failed}`, title: `${r.failed} failed, ${r.passed} passed` };
    return { kind: "good", text: `${r.passed ?? 0}`, title: `${r.passed} passed` };
  }
  const r = result as ReviewResult;
  if (r.issues > 0) return { kind: "bad", text: String(r.issues), title: `${r.issues} issue(s), ${r.ideas} idea(s)` };
  if (r.ideas > 0) return { kind: "info", text: String(r.ideas), title: `${r.ideas} idea(s)` };
  return { kind: "good", text: "✓", title: "nothing found" };
}

const LOGO = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="#f2a93b"/><path d="M6.5 5v10h7" fill="none" stroke="#1a1408" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13.6" cy="6.6" r="1.6" fill="#1a1408"/></svg>`;
