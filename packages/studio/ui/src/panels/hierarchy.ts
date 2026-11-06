import { clear, h } from "../dom.ts";
import { entityKind, icon } from "../icons.ts";
import type { EntitySummary } from "../protocol.ts";
import type { Studio } from "../studio.ts";

interface Node {
  entity: EntitySummary;
  children: Node[];
}

export function hierarchy(root: HTMLElement, studio: Studio): void {
  const count = h("span", { class: "panel-count" });
  const search = h("input", { class: "search-input", attrs: { type: "search", placeholder: "Search entities", spellcheck: "false" } });
  const list = h("div", { class: "tree", attrs: { role: "tree", tabindex: "0" } });
  const empty = h("div", { class: "empty" });
  const collapsed = new Set<string>();
  let rows: { id: string; el: HTMLElement }[] = [];

  clear(
    root,
    h("div", { class: "panel-head" }, h("span", { class: "panel-title", text: "Hierarchy" }), count),
    h("div", { class: "panel-search" }, icon("search", "muted"), search),
    h("div", { class: "panel-body" }, list, empty),
  );

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const all = studio.entities;
    count.textContent = all.length > 0 ? String(all.length) : "";
    const matches = (e: EntitySummary) =>
      !q || e.id.toLowerCase().includes(q) || (e.name ?? "").toLowerCase().includes(q) || (e.prefab ?? "").toLowerCase().includes(q) || e.components.some((c) => c.toLowerCase() === q);

    rows = [];
    const frag = document.createDocumentFragment();
    if (q) {
      for (const e of all.filter(matches)) frag.append(row(e, 0, false, q));
    } else {
      for (const node of buildTree(all)) addNode(frag, node, 0);
    }
    list.replaceChildren(frag);
    const shown = rows.length;
    empty.textContent = all.length === 0 ? "Waiting for the game…" : shown === 0 ? `No entity matches “${search.value}”.` : "";
    empty.hidden = shown > 0;
  };

  const addNode = (parent: DocumentFragment | HTMLElement, node: Node, depth: number) => {
    const isCollapsed = collapsed.has(node.entity.id);
    parent.append(row(node.entity, depth, node.children.length > 0 ? (isCollapsed ? "closed" : "open") : false, ""));
    if (!isCollapsed) for (const child of node.children) addNode(parent, child, depth + 1);
  };

  const row = (e: EntitySummary, depth: number, twisty: "open" | "closed" | false, q: string): HTMLElement => {
    const kind = entityKind(e.components, e.id);
    const label = e.name ?? e.id;
    const el = h(
      "div",
      {
        class: `tree-row kind-${kind}${e.id === studio.selected ? " selected" : ""}`,
        attrs: { role: "treeitem", "aria-selected": String(e.id === studio.selected) },
        data: { id: e.id },
        title: `${e.id}${e.prefab ? `  (prefab ${e.prefab})` : ""}\n${e.components.join(", ")}\nx ${Math.round(e.x)}  y ${Math.round(e.y)}${e.z !== undefined ? `  z ${Math.round(e.z)}` : ""}`,
        onclick: () => studio.select(e.id),
        onmouseenter: () => studio.hover(e.id),
        onmouseleave: () => studio.hover(null),
      },
      h("span", { class: "indent", attrs: { style: `width:${depth * 14}px` } }),
      twisty
        ? h(
            "span",
            {
              class: `twisty ${twisty}`,
              onclick: (ev: MouseEvent) => {
                ev.stopPropagation();
                if (collapsed.has(e.id)) collapsed.delete(e.id);
                else collapsed.add(e.id);
                render();
              },
            },
            icon("chevron"),
          )
        : h("span", { class: "twisty none" }),
      h("span", { class: "kind-icon" }, icon(kind)),
      h("span", { class: "tree-label" }, highlightMatch(label, q)),
      e.name && e.name !== e.id ? h("span", { class: "tree-id", text: e.id }) : null,
      e.prefab ? h("span", { class: "tree-prefab", text: e.prefab.replace(/^.*\//, "").replace(/\.prefab\.json$/, ""), title: `prefab ${e.prefab}` }) : null,
    );
    rows.push({ id: e.id, el });
    return el;
  };

  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      render();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list.focus();
      move(1);
    } else if (e.key === "Enter" && rows[0]) {
      studio.select(rows[0].id);
    }
  });

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const i = rows.findIndex((r) => r.id === studio.selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))]!;
    studio.select(next.id);
  };
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Escape") studio.select(null);
    else if (e.key === "Home") move(-rows.length);
    else if (e.key === "End") move(rows.length);
  });

  studio.on("entities", render);
  studio.on("selection", (id) => {
    for (const r of rows) {
      const on = r.id === id;
      r.el.classList.toggle("selected", on);
      r.el.setAttribute("aria-selected", String(on));
      if (on) r.el.scrollIntoView({ block: "nearest" });
    }
  });
  render();

  // Ctrl+F in the hierarchy's window focuses its search.
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });
}

function buildTree(list: EntitySummary[]): Node[] {
  const nodes = new Map<string, Node>();
  for (const e of list) nodes.set(e.id, { entity: e, children: [] });
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.entity.parent ? nodes.get(node.entity.parent) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function highlightMatch(text: string, q: string): (string | HTMLElement)[] {
  if (!q) return [text];
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return [text];
  return [text.slice(0, i), h("mark", { text: text.slice(i, i + q.length) }), text.slice(i + q.length)];
}

