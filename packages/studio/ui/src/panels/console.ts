import { clear, clock, h } from "../dom.ts";
import { icon } from "../icons.ts";
import { pref } from "../layout.ts";
import type { ConsoleEntry, Studio } from "../studio.ts";

type Level = ConsoleEntry["level"];
const FILTERS: { id: Level; label: string }[] = [
  { id: "event", label: "Events" },
  { id: "hot", label: "Hot" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Warnings" },
  { id: "error", label: "Errors" },
];

export function consolePanel(root: HTMLElement, studio: Studio, setBadge: (t: string, k?: string) => void, toolbar: HTMLElement): void {
  const hiddenPref = pref<Level[]>("console.hidden", []);
  const hidden = new Set<Level>(hiddenPref.get());
  const list = h("div", { class: "console mono" });
  const search = h("input", { class: "search-input small", attrs: { type: "search", placeholder: "Filter", spellcheck: "false" } });
  const chips = h("div", { class: "seg" });
  let errors = 0;
  let stick = true;

  const renderChips = () =>
    clear(
      chips,
      FILTERS.map((f) =>
        h("button", {
          class: hidden.has(f.id) ? "" : "on",
          text: f.label,
          onclick: () => {
            if (hidden.has(f.id)) hidden.delete(f.id);
            else hidden.add(f.id);
            hiddenPref.set([...hidden]);
            renderChips();
            renderAll();
          },
        }),
      ),
    );
  renderChips();
  clear(toolbar, search, chips, h("button", { class: "mini-btn", text: "Clear", onclick: () => studio.clearConsole() }));
  clear(root, list);

  list.addEventListener("scroll", () => {
    stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  });

  const visible = (e: ConsoleEntry) => {
    if (hidden.has(e.level)) return false;
    const q = search.value.trim().toLowerCase();
    return !q || e.text.toLowerCase().includes(q) || (e.detail ?? "").toLowerCase().includes(q);
  };

  const line = (e: ConsoleEntry) =>
    h(
      "div",
      { class: `con con-${e.level}` },
      h("span", { class: "con-time", text: clock(e.at) }),
      h("span", { class: "con-frame", text: e.frame === null ? "" : `f${e.frame}` }),
      h("span", { class: "con-icon" }, icon(e.level === "error" ? "error" : e.level === "warn" ? "warning" : e.level === "hot" ? "bolt" : e.level === "event" ? "spark" : "info")),
      h("span", { class: "con-text" }, h("span", { class: "con-main", text: e.text }), e.detail ? h("span", { class: "con-detail", text: ` ${e.detail}` }) : null),
    );

  const renderAll = () => {
    clear(list, studio.consoleEntries.filter(visible).map(line));
    if (list.childElementCount === 0) list.append(h("div", { class: "empty", text: "Game events and errors show up here." }));
    list.scrollTop = list.scrollHeight;
  };

  studio.on("console", (e) => {
    if (e.level === "error") setBadge(String(++errors), "bad");
    if (!visible(e)) return;
    list.querySelector(".empty")?.remove();
    list.append(line(e));
    while (list.childElementCount > 1000) list.firstElementChild?.remove();
    if (stick) list.scrollTop = list.scrollHeight;
  });
  studio.on("consoleCleared", () => {
    errors = 0;
    setBadge("");
    renderAll();
  });
  studio.on("tab", (t) => {
    if (t === "console") {
      errors = 0;
      setBadge("");
    }
  });
  search.addEventListener("input", renderAll);
  renderAll();
}
