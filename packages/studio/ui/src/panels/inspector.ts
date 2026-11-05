import { clear, h } from "../dom.ts";
import { componentIcon, entityKind, icon } from "../icons.ts";
import { pref } from "../layout.ts";
import type { EntityData } from "../protocol.ts";
import type { Studio } from "../studio.ts";
import { highlightJson } from "../syntax.ts";

const ORDER = ["transform", "body", "platformer", "topdown", "character", "sprite", "mesh", "script"];

export function inspector(root: HTMLElement, studio: Studio): void {
  const collapsedPref = pref<string[]>("inspector.collapsed", []);
  const rawPref = pref<boolean>("inspector.raw", false);
  const collapsed = new Set(collapsedPref.get());
  let raw = rawPref.get();

  const title = h("span", { class: "panel-title", text: "Inspector" });
  const rawBtn = h("button", { class: "icon-btn", title: "Show the raw JSON", onclick: () => setRaw(!raw) }, icon("braces"));
  const head = h("div", { class: "panel-head" }, title, h("span", { class: "tb-spacer" }), rawBtn);
  const body = h("div", { class: "panel-body inspector" });
  clear(root, head, body);

  /** Value cells by path, so live updates touch only what changed. */
  let cells = new Map<string, { el: HTMLElement; last: string }>();
  let shape = "";
  let rawPre: HTMLElement | null = null;

  const setRaw = (on: boolean) => {
    raw = on;
    rawPref.set(on);
    rawBtn.classList.toggle("active", on);
    shape = "";
    render(studio.entity);
  };
  rawBtn.classList.toggle("active", raw);

  const empty = () => {
    shape = "";
    cells = new Map();
    clear(
      body,
      h(
        "div",
        { class: "empty big" },
        icon("pick", "empty-icon"),
        h("div", { text: "Nothing selected" }),
        h("div", { class: "empty-sub", text: "Choose an entity in the Hierarchy, or pick one in the game." }),
        h("button", { class: "btn", onclick: () => studio.setPicking(true) }, icon("pick"), h("span", { text: "Pick in game" })),
      ),
    );
  };

  const render = (data: EntityData | null) => {
    if (!studio.selected) return empty();
    if (!data) {
      if (shape !== "loading") {
        shape = "loading";
        clear(body, entityHeader(studio.selected, undefined, undefined, []), h("div", { class: "empty", text: "Reading the entity…" }));
      }
      return;
    }
    if (raw) {
      const text = JSON.stringify(data, roundReplacer, 2);
      if (shape !== `raw:${data.id}` || !rawPre) {
        shape = `raw:${data.id}`;
        rawPre = h("pre", { class: "code raw-json" });
        clear(body, entityHeader(data.id, data.name, data.prefab, Object.keys(data.components)), rawPre);
      }
      rawPre.innerHTML = highlightJson(text);
      return;
    }
    const names = sortComponents(Object.keys(data.components));
    const nextShape = `${data.id}|${names.map((n) => `${n}:${keysOf(data.components[n])}`).join(";")}|${[...collapsed].join(",")}`;
    if (nextShape !== shape) {
      shape = nextShape;
      cells = new Map();
      clear(
        body,
        entityHeader(data.id, data.name, data.prefab, names),
        names.map((name) => section(name, data.components[name])),
      );
    } else {
      // Same shape: update values in place and flash the ones that moved.
      for (const name of names) updateValues(name, data.components[name]);
    }
  };

  const entityHeader = (id: string, name: string | undefined, prefab: string | undefined, components: string[]) => {
    const kind = entityKind(components, id);
    return h(
      "div",
      { class: `entity-head kind-${kind}` },
      h("span", { class: "entity-icon" }, icon(kind)),
      h(
        "div",
        { class: "entity-names" },
        h("div", { class: "entity-name", text: name ?? id }),
        h("div", { class: "entity-sub" }, name && name !== id ? h("span", { class: "mono", text: id }) : h("span", { text: `${components.length} components` }), prefab ? h("span", { class: "tree-prefab", text: prefab }) : null),
      ),
      h("button", { class: "icon-btn", title: "Copy the id", onclick: () => void navigator.clipboard?.writeText(id) }, icon("copy")),
    );
  };

  const section = (name: string, value: unknown) => {
    const isCollapsed = collapsed.has(name);
    const fields = h("div", { class: "fields" });
    if (!isCollapsed) addFields(fields, name, value, 0);
    return h(
      "section",
      { class: `comp${isCollapsed ? " collapsed" : ""}` },
      h(
        "div",
        {
          class: "comp-head",
          onclick: () => {
            if (collapsed.has(name)) collapsed.delete(name);
            else collapsed.add(name);
            collapsedPref.set([...collapsed]);
            shape = "";
            render(studio.entity);
          },
        },
        h("span", { class: `twisty ${isCollapsed ? "closed" : "open"}` }, icon("chevron")),
        h("span", { class: "comp-icon" }, icon(componentIcon(name))),
        h("span", { class: "comp-name", text: name }),
        h("span", { class: "comp-summary", text: summary(name, value) }),
      ),
      fields,
    );
  };

  const addFields = (into: HTMLElement, path: string, value: unknown, depth: number) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      into.append(field("value", path, value, depth));
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}.${key}`;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
        into.append(h("div", { class: "field group", attrs: { style: `--depth:${depth}` } }, h("span", { class: "field-key", text: key })));
        addFields(into, p, v, depth + 1);
      } else {
        into.append(field(key, p, v, depth));
      }
    }
  };

  const field = (key: string, path: string, value: unknown, depth: number) => {
    const valueEl = h("span", { class: "field-value" });
    const text = formatValue(valueEl, value);
    cells.set(path, { el: valueEl, last: text });
    return h("div", { class: "field", attrs: { style: `--depth:${depth}` }, title: path.replace(/^[^.]+\./, "") }, h("span", { class: "field-key", text: key }), valueEl);
  };

  const updateValues = (path: string, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) updateValues(`${path}.${k}`, v);
      return;
    }
    const cell = cells.get(path);
    if (!cell) return;
    const text = valueKey(value);
    if (text === cell.last) return;
    cell.last = formatValue(cell.el, value);
    cell.el.classList.remove("flash");
    void cell.el.offsetWidth;
    cell.el.classList.add("flash");
  };

  studio.on("selection", () => render(null));
  studio.on("entity", (data) => render(data));
  render(null);
}

function sortComponents(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function keysOf(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length > 0 ? `${k}{${keysOf(x)}}` : k))
    .join(",");
}

function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return Number(n.toFixed(digits));
}

function roundReplacer(_key: string, value: unknown): unknown {
  return typeof value === "number" ? round(value) : value;
}

function valueKey(value: unknown): string {
  if (typeof value === "number") return String(round(value));
  return JSON.stringify(value) ?? String(value);
}

/** Fills a value cell and returns its comparison key. */
function formatValue(el: HTMLElement, value: unknown): string {
  el.className = "field-value";
  if (typeof value === "number") {
    el.classList.add("v-num");
    el.textContent = String(round(value));
  } else if (typeof value === "boolean") {
    el.classList.add(value ? "v-true" : "v-false");
    el.textContent = String(value);
  } else if (typeof value === "string") {
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
      el.classList.add("v-color");
      clear(el, h("span", { class: "swatch", attrs: { style: `background:${value}` } }), value);
    } else if (/\.(ts|js|json|svg|png|jpe?g|gif|webp|wav|mp3|ogg|glb|gltf|md)$/i.test(value) && window.studio) {
      el.classList.add("v-path");
      clear(el, h("a", { text: value, title: `Open ${value}`, attrs: { href: "#" }, onclick: (e: MouseEvent) => { e.preventDefault(); window.studio?.openInEditor(value); } }));
    } else {
      el.classList.add("v-str");
      el.textContent = value;
    }
  } else if (value === null || value === undefined) {
    el.classList.add("v-null");
    el.textContent = String(value);
  } else if (Array.isArray(value)) {
    el.classList.add("v-arr");
    const inline = JSON.stringify(value, roundReplacer);
    el.textContent = inline.length <= 48 ? inline.replace(/,/g, ", ") : `[${value.length} items]`;
    el.title = inline.length > 48 ? inline.slice(0, 2000) : "";
  } else {
    el.classList.add("v-null");
    el.textContent = "{}";
  }
  return valueKey(value);
}

function summary(name: string, value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" ? String(round(x)) : "?");
  if (name === "transform") return `${n(v.x)}, ${n(v.y)}${v.z !== undefined ? `, ${n(v.z)}` : ""}`;
  if (name === "body") return [v.type, v.width !== undefined ? `${n(v.width)}×${n(v.height)}` : v.shape].filter(Boolean).join(" · ");
  if (name === "script" && typeof v.src === "string") return v.src.replace(/^.*\//, "");
  if (name === "sprite" && typeof v.image === "string") return v.image.replace(/^.*\//, "");
  return "";
}
