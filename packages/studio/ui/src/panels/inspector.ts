import { clear, h } from "../dom.ts";
import { componentIcon, entityKind, icon } from "../icons.ts";
import { pref } from "../layout.ts";
import type { ComponentSpec, Diagnostic, Edit, EntityData, FieldSpec } from "../protocol.ts";
import type { Studio } from "../studio.ts";
import { highlightJson } from "../syntax.ts";
import { mergeComponents, SceneDoc, type Components, type FileEntity } from "./scene-doc.ts";

const ORDER = ["transform", "body", "platformer", "topdown", "character", "sprite", "mesh", "script"];
/** Schema fields that mean nothing in 2D, by how their description starts. */
const THREE_D_ONLY = /^3D( only| mesh shape| convex)/;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** What went wrong with the last edit, shown where it belongs. */
interface Problems {
  /** By "component.field", or "component" for the whole component. */
  at: Map<string, Diagnostic[]>;
  /** Not tied to a field: shown at the top. */
  general: { message: string; fix?: string; level: "error" | "warn" }[];
}

/**
 * The selected entity. Entities the scene file holds are edited here (docs/editor.md): fields come from
 * the component schema and show the file's value, with the live value beside it when the game has moved
 * it; edits go to the file through /__ludra/edit. Anything else (tilemap cells, spawned entities) is shown
 * read-only, live, with the reason.
 */
export function inspector(root: HTMLElement, studio: Studio): void {
  const collapsedPref = pref<string[]>("inspector.collapsed", []);
  const rawPref = pref<boolean>("inspector.raw", false);
  const collapsed = new Set(collapsedPref.get());
  let raw = rawPref.get();

  const title = h("span", { class: "panel-title", text: "Inspector" });
  const rawBtn = h("button", { class: "icon-btn", title: "Show the raw JSON (live values)", onclick: () => setRaw(!raw) }, icon("braces"));
  const head = h("div", { class: "panel-head" }, title, h("span", { class: "tb-spacer" }), rawBtn);
  const body = h("div", { class: "panel-body inspector" });
  clear(root, head, body);

  const doc = new SceneDoc(studio.backend, () => {
    shape = "";
    render();
  });

  /** Value cells by path, so live updates touch only what changed. */
  let cells = new Map<string, { el: HTMLElement; last: string }>();
  /** Live-value chips by "component.field", next to the editable scene values. */
  let liveChips = new Map<string, { el: HTMLElement; scene: string; last: string }>();
  /** The problem keys the editable view has a place for, this build. */
  let shown = new Set<string>();
  let shape = "";
  let rawPre: HTMLElement | null = null;
  let problems: Problems = { at: new Map(), general: [] };
  /** What the person is typing, by "component.field", kept when the panel is rebuilt under them. */
  const drafts = new Map<string, string>();
  let renaming: string | null = null;
  let busy = false;
  /** Set while the panel is rebuilt, so the inputs it removes don't commit on blur. */
  let rebuilding = false;

  const setRaw = (on: boolean) => {
    raw = on;
    rawPref.set(on);
    rawBtn.classList.toggle("active", on);
    shape = "";
    render();
  };
  rawBtn.classList.toggle("active", raw);

  const empty = () => {
    shape = "";
    cells = new Map();
    liveChips = new Map();
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

  /** Rebuilds the panel, keeping focus and the caret in the field the person was typing in. */
  const rebuild = (...children: (Node | Node[] | null)[]) => {
    const active = document.activeElement as HTMLInputElement | null;
    const focusKey = active && body.contains(active) ? active.dataset.key : undefined;
    const caret = active && "selectionStart" in active ? active.selectionStart : null;
    rebuilding = true;
    clear(body, ...children);
    rebuilding = false;
    if (focusKey) {
      const again = body.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(focusKey)}"]`);
      if (again) {
        again.focus();
        if (caret !== null && again.setSelectionRange && again.type === "text") again.setSelectionRange(caret, caret);
      }
    }
  };

  const render = () => {
    const id = studio.selected;
    if (!id) return empty();
    const data = studio.entity;
    if (raw) return renderRaw(id, data);
    if (!doc.loaded) {
      if (shape !== "loading") {
        shape = "loading";
        rebuild(entityHeader(id, undefined, data ? Object.keys(data.components) : [], false), h("div", { class: "empty", text: "Reading the scene file…" }));
      }
      return;
    }
    const entity = doc.entity(id);
    if (!entity) return renderReadOnly(id, data);
    renderEditable(entity, data);
  };

  // Raw JSON and read-only views: the live entity, as before v0.99.

  const renderRaw = (id: string, data: EntityData | null) => {
    if (!data) {
      if (shape !== "raw-loading") {
        shape = "raw-loading";
        rebuild(entityHeader(id, undefined, [], false), h("div", { class: "empty", text: "Reading the entity…" }));
      }
      return;
    }
    const text = JSON.stringify(data, roundReplacer, 2);
    if (shape !== `raw:${data.id}` || !rawPre) {
      shape = `raw:${data.id}`;
      rawPre = h("pre", { class: "code raw-json" });
      rebuild(entityHeader(data.id, data.prefab, Object.keys(data.components), false), rawPre);
    }
    rawPre.innerHTML = highlightJson(text);
  };

  const readOnlyReason = (id: string): Node => {
    if (doc.error) return h("span", { text: `Read-only: couldn't read the scene file. ${doc.error}` });
    const tilemap = doc.tilemapOf(id);
    if (tilemap) {
      return h(
        "span",
        {},
        `Read-only: a cell of the tilemap "${tilemap}". Edit the map's rows on that entity instead. `,
        h("a", { text: `Select ${tilemap}`, attrs: { href: "#" }, onclick: (e: MouseEvent) => (e.preventDefault(), studio.select(tilemap)) }),
      );
    }
    return h("span", { text: `Read-only: not in ${doc.path ?? "the scene file"}. It was made while playing (by a script or the engine), so there's nothing in the file to edit.` });
  };

  const renderReadOnly = (id: string, data: EntityData | null) => {
    if (!data) {
      if (shape !== `ro-loading:${id}`) {
        shape = `ro-loading:${id}`;
        rebuild(entityHeader(id, undefined, [], false), notice("info", readOnlyReason(id)), h("div", { class: "empty", text: "Reading the entity…" }));
      }
      return;
    }
    const names = sortComponents(Object.keys(data.components));
    const nextShape = `ro|${data.id}|${doc.version}|${names.map((n) => `${n}:${keysOf(data.components[n])}`).join(";")}|${[...collapsed].join(",")}`;
    if (nextShape !== shape) {
      shape = nextShape;
      cells = new Map();
      liveChips = new Map();
      rebuild(entityHeader(data.id, data.prefab, names, false), notice("info", readOnlyReason(id)), names.map((name) => liveSection(name, data.components[name])));
    } else {
      for (const name of names) updateValues(name, data.components[name]);
    }
  };

  const toggle = (name: string) => {
    if (collapsed.has(name)) collapsed.delete(name);
    else collapsed.add(name);
    collapsedPref.set([...collapsed]);
    shape = "";
    render();
  };

  const liveSection = (name: string, value: unknown) => {
    const isCollapsed = collapsed.has(name);
    const fields = h("div", { class: "fields" });
    if (!isCollapsed) addFields(fields, name, value, 0);
    return h(
      "section",
      { class: `comp${isCollapsed ? " collapsed" : ""}` },
      h(
        "div",
        { class: "comp-head", onclick: () => toggle(name) },
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
    flash(cell.el);
  };

  // The editable view.

  const schema = (): Record<string, ComponentSpec> => studio.project?.components ?? {};

  const renderEditable = (entity: FileEntity, data: EntityData | null) => {
    const prefab = entity.prefab ? doc.prefab(entity.prefab) : null;
    const sceneComps = mergeComponents(prefab, entity.components);
    const live = data?.components ?? {};
    const names = sortComponents([...new Set([...Object.keys(sceneComps), ...Object.keys(live).filter((n) => !(n in entity.components) || entity.components[n] !== null)])]);
    const nextShape = [
      "edit",
      entity.id,
      doc.version,
      prefab === undefined ? "prefab-loading" : prefab ? "prefab" : "",
      names.join(","),
      [...collapsed].join(","),
      renaming ?? "",
      problemsStamp(),
      busy ? "busy" : "",
    ].join("|");
    if (nextShape !== shape) {
      shape = nextShape;
      cells = new Map();
      liveChips = new Map();
      shown = new Set();
      const sections = names.map((name) => editableSection(entity, name, sceneComps[name], prefab, live[name]));
      // Problems about a field that isn't on screen (a folded component, one the edit tried to add) go on top.
      const unseen = [...problems.at.entries()].filter(([key]) => !shown.has(key)).flatMap(([, list]) => list);
      const top = [...problems.general, ...unseen.map((d) => ({ level: d.severity === "error" ? ("error" as const) : ("warn" as const), message: d.message, fix: d.fix }))];
      rebuild(
        entityHeader(entity.id, entity.prefab, names, true),
        top.map((p) => notice(p.level, h("span", {}, h("span", { text: p.message }), p.fix ? h("div", { class: "fix", text: p.fix }) : null))),
        sections,
        addComponentRow(entity, names),
      );
    }
    updateLive(live);
  };

  const editableSection = (entity: FileEntity, name: string, sceneValue: unknown, prefab: Components | null | undefined, liveValue: unknown) => {
    const isCollapsed = collapsed.has(name);
    const spec = schema()[name];
    const inFile = name in entity.components && entity.components[name] !== null;
    const fromPrefab = !!prefab && name in prefab;
    const liveOnly = sceneValue === undefined;
    const fields = h("div", { class: "fields" });
    if (!isCollapsed) {
      const own = isObject(entity.components[name]) ? (entity.components[name] as Obj) : {};
      const base = prefab && isObject(prefab[name]) ? (prefab[name] as Obj) : {};
      const scene = isObject(sceneValue) ? sceneValue : {};
      if (liveOnly) {
        addFields(fields, name, liveValue, 0);
      } else if (!isObject(sceneValue)) {
        fields.append(jsonRow(entity, name, sceneValue));
      } else {
        // In a 2D scene, 3D-only fields show only when the file sets them.
        const hidden = (k: string) => studio.dimensions === 2 && scene[k] === undefined && THREE_D_ONLY.test(spec?.fields[k]?.description ?? "");
        const keys = (spec ? [...Object.keys(spec.fields), ...Object.keys(scene).filter((k) => !(k in spec.fields))] : Object.keys(scene)).filter((k) => !hidden(k));
        for (const key of keys) fields.append(...fieldRow(entity, name, key, spec?.fields[key], scene[key], key in own, base[key]));
      }
      for (const d of problems.at.get(name) ?? []) fields.append(problemLine(d));
      shown.add(name);
    }
    const remove = liveOnly
      ? null
      : h("button", {
          class: "icon-btn comp-remove",
          title: inFile && !fromPrefab ? `Remove ${name}` : `Remove ${name} (the prefab's: writes ${name}: null on this entity)`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const field = `components.${name}`;
            void commit([fromPrefab ? { op: "set", entity: entity.id, field, value: null } : { op: "set", entity: entity.id, field }], `Removed ${name} from ${entity.id}`);
          },
        }, icon("close"));
    return h(
      "section",
      { class: `comp${isCollapsed ? " collapsed" : ""}${liveOnly ? " live-only" : ""}` },
      h(
        "div",
        { class: "comp-head", onclick: () => toggle(name), title: spec?.description ?? "" },
        h("span", { class: `twisty ${isCollapsed ? "closed" : "open"}` }, icon("chevron")),
        h("span", { class: "comp-icon" }, icon(componentIcon(name))),
        h("span", { class: "comp-name", text: name }),
        fromPrefab ? h("span", { class: "tree-prefab", text: inFile ? "prefab + overrides" : "prefab", title: `From the prefab "${entity.prefab}"` }) : null,
        liveOnly ? h("span", { class: "comp-note", text: "live only", title: "The game added this while playing; it isn't in the file." }) : null,
        h("span", { class: "comp-summary", text: summary(name, liveOnly ? liveValue : sceneValue) }),
        remove,
      ),
      fields,
    );
  };

  /** One field: the file's value as an editor, where it comes from, and the live value when it differs. */
  const fieldRow = (entity: FileEntity, comp: string, key: string, spec: FieldSpec | undefined, value: unknown, own: boolean, prefabValue: unknown): HTMLElement[] => {
    const path = `${comp}.${key}`;
    const inPrefab = prefabValue !== undefined;
    shown.add(path);
    const field = `components.${comp}.${key}`;
    const effective = value === undefined ? spec?.default : value;
    const set = (next: unknown, label = `Changed ${entity.id} ${comp}.${key}`) =>
      commit([next === undefined ? { op: "set", entity: entity.id, field } : { op: "set", entity: entity.id, field, value: next }], label, path);
    const editor = fieldEditor(path, spec, value, set);
    const why = [spec?.description, own && inPrefab ? `Overrides the prefab's ${JSON.stringify(prefabValue)}.` : inPrefab ? "From the prefab." : "", value === undefined && spec?.default !== undefined ? `Not set: the default is ${JSON.stringify(spec.default)}.` : ""];
    const keyEl = h("span", { class: "field-key", text: key, title: why.filter(Boolean).join(" ") });
    if (spec?.type === "number" || (!spec && typeof value === "number")) scrub(keyEl, editor as HTMLInputElement, spec, set);
    const chip = h("span", { class: "live-chip", title: "The live value in the running game" });
    liveChips.set(path, { el: chip, scene: valueKey(effective), last: "" });
    const reset = own
      ? h("button", { class: "icon-btn field-reset", title: inPrefab ? "Back to the prefab's value" : "Remove it from the file (use the default)", onclick: () => void set(undefined, `Reset ${entity.id} ${comp}.${key}`) }, icon("restart"))
      : h("span", { class: "field-reset-space" });
    const row = h(
      "div",
      { class: `field edit${own && inPrefab ? " overridden" : ""}${!own && inPrefab ? " from-prefab" : ""}${value === undefined ? " unset" : ""}${problems.at.has(path) ? " has-error" : ""}` },
      keyEl,
      h("span", { class: "field-edit" }, editor, chip, reset),
    );
    return [row, ...(problems.at.get(path) ?? []).map(problemLine)];
  };

  /** A component whose value isn't an object (true, a string): edited as JSON. */
  const jsonRow = (entity: FileEntity, comp: string, value: unknown) => (
    shown.add(comp),
    h(
      "div",
      { class: "field edit" },
      h("span", { class: "field-key", text: "value" }),
      h("span", { class: "field-edit" }, fieldEditor(comp, { type: "object", description: "" }, value, (next) => commit([{ op: "set", entity: entity.id, field: `components.${comp}`, value: next }], `Changed ${entity.id} ${comp}`, comp))),
    )
  );

  /** The input for one field, by its schema type. Enter commits, Esc reverts, leaving it commits. */
  const fieldEditor = (path: string, spec: FieldSpec | undefined, value: unknown, set: (v: unknown) => Promise<void>): HTMLElement => {
    const type = spec?.type ?? (typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "string" ? "string" : "object");
    const placeholder = spec && spec.default !== undefined ? `default ${typeof spec.default === "string" ? spec.default : JSON.stringify(spec.default)}` : spec ? "required" : "";
    if (type === "boolean") {
      const box = h("input", { class: "field-check", attrs: { type: "checkbox" }, data: { key: path } }) as HTMLInputElement;
      box.checked = value === undefined ? spec?.default === true : value === true;
      box.indeterminate = value === undefined;
      box.disabled = busy;
      box.onchange = () => void set(box.checked);
      return box;
    }
    if (type === "enum" && spec?.type === "enum") {
      const select = h("select", { class: "field-input", data: { key: path } }, h("option", { text: placeholder || "(not set)", attrs: { value: "" } }), spec.values.map((v) => h("option", { text: v, attrs: { value: v } }))) as HTMLSelectElement;
      select.value = typeof value === "string" ? value : "";
      select.disabled = busy;
      select.onchange = () => void set(select.value === "" ? undefined : select.value);
      return select;
    }
    const text = (v: unknown) => (v === undefined ? "" : typeof v === "string" && (type === "string" || type === "frames") ? v : type === "number" && typeof v === "number" ? String(v) : JSON.stringify(v));
    const input = h("input", { class: `field-input t-${type}`, attrs: { type: "text", placeholder, spellcheck: "false" }, data: { key: path } }) as HTMLInputElement;
    const original = text(value);
    input.value = drafts.get(path) ?? original;
    input.disabled = busy;
    if (drafts.has(path) && drafts.get(path) !== original) input.classList.add("dirty");
    const parse = (s: string): { ok: true; value: unknown } | { ok: false; error: string } => {
      if (s.trim() === "") return { ok: true, value: undefined };
      if (type === "number") {
        const n = Number(s);
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `"${s}" isn't a number.` };
      }
      if (type === "string" || type === "frames") return { ok: true, value: s };
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch {
        // rotation and axis take a plain number in 2D.
        if ((type === "rotation" || type === "axis") && Number.isFinite(Number(s))) return { ok: true, value: Number(s) };
        return { ok: false, error: `That isn't JSON. ${type === "points" ? "Points look like [[0, 0], [40, 0]]." : type === "strings" ? 'Rows look like ["#..#", "####"].' : "Objects look like { \"key\": 1 }."}` };
      }
    };
    const commitInput = () => {
      if (rebuilding) return;
      const s = input.value;
      if (s === original) {
        drafts.delete(path);
        input.classList.remove("dirty");
        return;
      }
      const parsed = parse(s);
      if (!parsed.ok) {
        problems.at.set(path, [{ severity: "error", code: "E_INPUT", path, message: parsed.error }]);
        shape = "";
        render();
        return;
      }
      void set(parsed.value);
    };
    input.oninput = () => {
      drafts.set(path, input.value);
      input.classList.toggle("dirty", input.value !== original);
    };
    input.onkeydown = (e: KeyboardEvent) => {
      e.stopPropagation(); // the viewport's keys (Delete, Ctrl+Z) are for entities, not for this text
      if (e.key === "Enter") {
        e.preventDefault();
        commitInput();
      } else if (e.key === "Escape") {
        e.preventDefault();
        drafts.delete(path);
        problems.at.delete(path);
        input.value = original;
        input.classList.remove("dirty");
        input.blur();
      }
    };
    input.onblur = commitInput;
    if ((type === "string" && /color/i.test(path)) || (typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))) {
      const hex = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : typeof value === "string" && /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : "#ffffff";
      const picker = h("input", { class: "field-color", attrs: { type: "color", value: hex, title: "Pick a color" } }) as HTMLInputElement;
      picker.disabled = busy;
      picker.onchange = () => void set(picker.value);
      return h("span", { class: "field-with-color" }, picker, input);
    }
    return input;
  };

  /** Number fields: drag the name sideways to change the value (Shift for fine steps); commits on release, Esc cancels. */
  const scrub = (handle: HTMLElement, input: HTMLInputElement, spec: FieldSpec | undefined, set: (v: unknown) => Promise<void>) => {
    if (!(input instanceof HTMLInputElement)) return;
    handle.classList.add("scrub");
    handle.onpointerdown = (down: PointerEvent) => {
      if (down.button !== 0 || busy) return;
      const start = Number(input.value === "" ? (spec?.default ?? 0) : input.value);
      if (!Number.isFinite(start)) return;
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const integer = Number.isInteger(start);
      const per = Math.max(integer ? 1 : 0.01, niceStep(Math.abs(start) / 100));
      let value = start;
      let cancelled = false;
      const min = spec?.type === "number" ? spec.min : undefined;
      const move = (e: PointerEvent) => {
        const dx = e.clientX - down.clientX;
        let next = start + dx * per * (e.shiftKey ? 0.1 : 1);
        if (min !== undefined) next = Math.max(min, next);
        value = integer && !e.shiftKey ? Math.round(next) : Number(next.toFixed(2));
        input.value = String(value);
        input.classList.toggle("dirty", value !== start);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        cancelled = true;
        input.value = String(start);
        input.classList.remove("dirty");
        handle.releasePointerCapture(down.pointerId);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("lostpointercapture", up);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("scrubbing");
        if (!cancelled && value !== start) void set(value);
      };
      document.body.classList.add("scrubbing");
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("lostpointercapture", up);
      window.addEventListener("keydown", key, true);
    };
  };

  const updateLive = (live: Components) => {
    for (const [path, chip] of liveChips) {
      const [comp, key] = splitPath(path);
      const value = isObject(live[comp]) ? (live[comp] as Obj)[key] : undefined;
      const text = value === undefined ? "" : valueKey(value);
      if (text === chip.last) continue;
      chip.last = text;
      const differs = value !== undefined && text !== chip.scene;
      chip.el.classList.toggle("on", differs);
      chip.el.textContent = differs ? short(value) : "";
      chip.el.title = differs ? `Live: ${JSON.stringify(value, roundReplacer)?.slice(0, 400)} (the running game; the file says ${chip.scene || "nothing"})` : "";
    }
  };

  const addComponentRow = (entity: FileEntity, present: string[]) => {
    const available = Object.keys(schema())
      .filter((n) => !present.includes(n))
      .sort();
    if (available.length === 0) return null;
    const select = h("select", { class: "add-comp", title: "Add a component to this entity" }, h("option", { text: "Add component…", attrs: { value: "" } }), available.map((n) => h("option", { text: n, title: schema()[n]?.description ?? "", attrs: { value: n } }))) as HTMLSelectElement;
    select.disabled = busy;
    select.onchange = () => {
      const name = select.value;
      if (!name) return;
      void commit([{ op: "set", entity: entity.id, field: `components.${name}`, value: starter(schema()[name]) }], `Added ${name} to ${entity.id}`, name);
    };
    return h("div", { class: "add-comp-row" }, select);
  };

  // Editing.

  /** Sends edits; shows 422 diagnostics where they belong, and 409/400 at the top. */
  const commit = async (edits: Edit[], label: string, at?: string): Promise<void> => {
    if (busy) return;
    busy = true;
    const id = studio.selected;
    const entityIndex = id ? doc.entity(id)?.index : undefined;
    let result;
    try {
      result = await doc.edit(edits, label);
    } catch (err) {
      result = { ok: false as const, status: 400 as const, error: `Couldn't reach ludra dev: ${err instanceof Error ? err.message : String(err)}` };
    }
    busy = false;
    problems = { at: new Map(), general: [] };
    if (result.ok) {
      if (at) drafts.delete(at);
      for (const d of result.diagnostics) if (d.severity === "warning") place(d, entityIndex, undefined);
    } else if (result.status === 409) {
      problems.general.push({ level: "warn", message: "The agent changed this scene a moment ago, so your edit wasn't written. The inspector shows the file as it is now: make it again.", fix: result.error });
    } else if (result.status === 422) {
      for (const d of result.diagnostics ?? []) place(d, entityIndex, at);
    } else {
      problems.general.push({ level: "error", message: result.error ?? "The edit was refused." });
    }
    shape = "";
    render();
  };

  /** Puts a diagnostic on the field it's about, if it's about this entity. */
  const place = (d: Diagnostic, index: number | undefined, fallback: string | undefined) => {
    const m = /^entities\[(\d+)\]\.components\.([^.[]+)(?:\.([^.[]+))?/.exec(d.path);
    if (m && index !== undefined && Number(m[1]) === index) {
      const key = m[3] ? `${m[2]}.${m[3]}` : m[2]!;
      problems.at.set(key, [...(problems.at.get(key) ?? []), d]);
      return;
    }
    if (fallback && d.severity === "error" && !m) {
      problems.at.set(fallback, [...(problems.at.get(fallback) ?? []), d]);
      return;
    }
    problems.general.push({ level: d.severity === "error" ? "error" : "warn", message: `${d.code}: ${d.message}`, fix: d.fix });
  };

  const problemsStamp = () => [...problems.at.entries()].map(([k, v]) => `${k}:${v.length}`).join(",") + `|${problems.general.length}`;

  const problemLine = (d: Diagnostic) =>
    h("div", { class: `field-problem ${d.severity}` }, icon(d.severity === "error" ? "error" : "warning"), h("span", {}, h("span", { text: d.message }), d.fix ? h("span", { class: "fix", text: ` ${d.fix}` }) : null));

  const notice = (level: "info" | "warn" | "error", content: Node) => h("div", { class: `inspector-notice ${level}` }, icon(level === "info" ? "info" : level === "warn" ? "warning" : "error"), content);

  // The header, with rename.

  const entityHeader = (id: string, prefab: string | undefined, components: string[], editable: boolean) => {
    const kind = entityKind(components, id);
    let nameEl: HTMLElement;
    if (editable && renaming === id) {
      const input = h("input", { class: "field-input rename", attrs: { type: "text", value: id, spellcheck: "false" }, data: { key: "#id" } }) as HTMLInputElement;
      const done = (save: boolean) => {
        if (rebuilding || renaming !== id) return;
        const next = input.value.trim();
        renaming = null;
        if (!save || next === "" || next === id) {
          shape = "";
          render();
          return;
        }
        if (doc.ids().has(next)) {
          problems = { at: new Map(), general: [{ level: "error", message: `The id "${next}" is taken. Pick another.` }] };
          shape = "";
          render();
          return;
        }
        void commit([{ op: "set", entity: id, field: "id", value: next }], `Renamed ${id} to ${next}`).then(() => {
          if (doc.entity(next)) studio.select(next);
        });
      };
      input.onkeydown = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      };
      input.onblur = () => done(true);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      nameEl = input;
    } else {
      nameEl = h("div", {
        class: `entity-name${editable ? " renamable" : ""}`,
        text: id,
        title: editable ? "Click to rename" : "",
        onclick: editable
          ? () => {
              renaming = id;
              shape = "";
              render();
            }
          : undefined,
      });
    }
    return h(
      "div",
      { class: `entity-head kind-${kind}` },
      h("span", { class: "entity-icon" }, icon(kind)),
      h(
        "div",
        { class: "entity-names" },
        nameEl,
        h("div", { class: "entity-sub" }, h("span", { text: `${components.length} components` }), prefab ? h("span", { class: "tree-prefab", text: prefab, title: "Made from this prefab: its values show as \"from the prefab\", and editing one writes an override on this entity." }) : null, editable ? null : h("span", { class: "readonly-tag", text: "read-only" })),
      ),
      h("button", { class: "icon-btn", title: "Copy the id", onclick: () => void navigator.clipboard?.writeText(id) }, icon("copy")),
    );
  };

  studio.on("selection", () => {
    problems = { at: new Map(), general: [] };
    drafts.clear();
    renaming = null;
    shape = "";
    render();
  });
  studio.on("entity", () => render());
  studio.on("project", () => {
    shape = "";
    render();
  });
  studio.on("scene", (path) => void doc.load(path));
  studio.on("activity", (list) => doc.filesChanged(list[0]?.files.map((f) => f.path) ?? []));
  if (studio.scene) void doc.load(studio.scene);
  render();
}

function splitPath(path: string): [string, string] {
  const dot = path.indexOf(".");
  return [path.slice(0, dot), path.slice(dot + 1)];
}

/** A new component: its required fields filled with a starting value, so it passes check where it can. */
function starter(spec: ComponentSpec | undefined): Obj {
  const out: Obj = {};
  for (const [key, field] of Object.entries(spec?.fields ?? {})) {
    if (field.default !== undefined) continue;
    out[key] =
      field.type === "number" ? 0 : field.type === "boolean" ? false : field.type === "enum" ? field.values[0] : field.type === "string" || field.type === "frames" ? "" : field.type === "object" ? {} : field.type === "rotation" || field.type === "axis" ? 0 : [];
  }
  return out;
}

function niceStep(x: number): number {
  if (!(x > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(x));
  return x / p >= 5 ? 5 * p : x / p >= 2 ? 2 * p : p;
}

function flash(el: HTMLElement): void {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function short(value: unknown): string {
  if (typeof value === "number") return String(round(value));
  const text = JSON.stringify(value, roundReplacer) ?? String(value);
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
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
  return JSON.stringify(value, roundReplacer) ?? String(value);
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
