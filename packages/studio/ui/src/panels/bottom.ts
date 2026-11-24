import { clear, h } from "../dom.ts";
import { icon } from "../icons.ts";
import { pref } from "../layout.ts";
import type { Studio } from "../studio.ts";
import { activity } from "./activity.ts";
import { consolePanel } from "./console.ts";
import { palette } from "./palette.ts";
import { problems, review, tests } from "./results.ts";

export interface Tab {
  id: string;
  label: string;
  icon: string;
  /** Builds the panel; returns the badge text and kind to show, kept current via `setBadge`. */
  build(body: HTMLElement, setBadge: (text: string, kind?: string) => void, toolbar: HTMLElement): void;
}

export function bottom(root: HTMLElement, studio: Studio): void {
  const tabs: Tab[] = [
    { id: "activity", label: "Activity", icon: "activity", build: (b, s, t) => activity(b, studio, s, t) },
    { id: "problems", label: "Problems", icon: "warning", build: (b, s, t) => problems(b, studio, s, t) },
    { id: "tests", label: "Tests", icon: "flask", build: (b, s, t) => tests(b, studio, s, t) },
    { id: "review", label: "Review", icon: "review", build: (b, s, t) => review(b, studio, s, t) },
    { id: "console", label: "Console", icon: "terminal", build: (b, s, t) => consolePanel(b, studio, s, t) },
    { id: "palette", label: "Palette", icon: "prefab", build: (b, s, t) => palette(b, studio, s, t) },
  ];
  const current = pref<string>("bottom.tab", "activity");
  const strip = h("div", { class: "tabs", attrs: { role: "tablist" } });
  const tools = h("div", { class: "tab-tools" });
  const bodies = h("div", { class: "tab-bodies" });
  clear(root, h("div", { class: "tab-strip" }, strip, h("span", { class: "tb-spacer" }), tools), bodies);

  const entries = tabs.map((tab) => {
    const badge = h("span", { class: "tab-badge" });
    const button = h(
      "button",
      { class: "tab", attrs: { role: "tab" }, data: { tab: tab.id }, onclick: () => show(tab.id) },
      icon(tab.icon),
      h("span", { text: tab.label }),
      badge,
    );
    const body = h("div", { class: "tab-body", attrs: { role: "tabpanel" } });
    const toolbar = h("div", { class: "tab-toolbar" });
    strip.append(button);
    bodies.append(body);
    tools.append(toolbar);
    tab.build(body, (text, kind = "") => {
      badge.textContent = text;
      badge.className = `tab-badge ${kind}`;
      badge.hidden = !text;
    }, toolbar);
    return { tab, button, body, toolbar };
  });

  const show = (id: string) => {
    if (!entries.some((e) => e.tab.id === id)) id = "activity";
    current.set(id);
    for (const e of entries) {
      const on = e.tab.id === id;
      e.button.classList.toggle("active", on);
      e.button.setAttribute("aria-selected", String(on));
      e.body.hidden = !on;
      e.toolbar.hidden = !on;
    }
  };
  show(current.get());
  studio.on("tab", show);
  // Placing from the palette keeps it in view.
  studio.on("placing", (p) => p && show("palette"));
}
