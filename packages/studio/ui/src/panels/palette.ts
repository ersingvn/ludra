// The palette (docs/editor.md, part B): the project's prefabs and the block library, from
// /__ludra/project. Pick one, then click in the game to place it; the game draws a ghost where it goes.

import { clear, h } from "../dom.ts";
import { icon } from "../icons.ts";
import type { Placing, Studio } from "../studio.ts";

export function palette(root: HTMLElement, studio: Studio, setBadge: (text: string, kind?: string) => void, toolbar: HTMLElement): void {
  const search = h("input", { class: "search-input", attrs: { type: "search", placeholder: "Search prefabs and blocks", spellcheck: "false" } });
  const hint = h("div", { class: "palette-hint" });
  const body = h("div", { class: "palette-body" });
  clear(root, h("div", { class: "palette" }, hint, body));
  clear(toolbar, h("span", { class: "panel-search" }, icon("search", "muted"), search));

  const same = (a: Placing | null, b: Placing) => a !== null && a.kind === b.kind && a.name === b.name;
  const item = (p: Placing, description: string, tags: string[] = []) =>
    h(
      "button",
      {
        class: `palette-item${same(studio.placing, p) ? " active" : ""}`,
        title: `${description}${tags.length ? `\n${tags.join(", ")}` : ""}`,
        onclick: () => studio.setPlacing(same(studio.placing, p) ? null : p),
      },
      icon(p.kind === "prefab" ? "prefab" : "layers"),
      h("span", { class: "pi-text" }, h("span", { class: "pi-name", text: p.name }), h("span", { class: "pi-desc", text: description })),
    );

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const prefabs = (studio.project?.prefabs ?? []).filter((n) => !q || n.toLowerCase().includes(q));
    const blocks = (studio.project?.blocks ?? []).filter((b) => !q || b.name.includes(q) || b.description.toLowerCase().includes(q) || b.tags.some((t) => t.includes(q)));
    const groups: HTMLElement[] = [];
    if (prefabs.length > 0) {
      groups.push(h("div", { class: "palette-group", text: "Prefabs" }), h("div", { class: "palette-grid" }, prefabs.map((name) => item({ kind: "prefab", name }, `prefabs/${name}.prefab.json`))));
    }
    if (blocks.length > 0) {
      groups.push(h("div", { class: "palette-group", text: "Blocks" }), h("div", { class: "palette-grid" }, blocks.map((b) => item({ kind: "block", name: b.name }, b.description, b.tags))));
    }
    const total = (studio.project?.prefabs?.length ?? 0) + (studio.project?.blocks?.length ?? 0);
    if (groups.length === 0) {
      groups.push(
        h("div", { class: "empty" }, total === 0 ? "This project has no prefabs, and the server sent no blocks." : `Nothing matches “${search.value}”.`),
      );
    }
    clear(body, groups);
    setBadge(total > 0 ? String(total) : "");
    const p = studio.placing;
    hint.className = `palette-hint${p ? " placing" : ""}`;
    hint.textContent =
      studio.dimensions !== 2
        ? "Placing is 2D only for now."
        : p
          ? `Click in the game to place ${p.name}. Shift keeps placing, Esc stops.`
          : "Pick a prefab or a block, then click in the game to place it. It's written to the scene file.";
  };

  search.addEventListener("input", render);
  studio.on("project", render);
  studio.on("placing", render);
  studio.on("scene", render);
  render();
}
