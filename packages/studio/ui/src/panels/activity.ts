import { clear, clock, h } from "../dom.ts";
import { icon } from "../icons.ts";
import type { FileChange } from "../protocol.ts";
import type { ActivityEntry, Studio } from "../studio.ts";
import { parseDiff, renderDiff } from "../syntax.ts";
import { youDid } from "../tools.ts";

export function activity(root: HTMLElement, studio: Studio, setBadge: (t: string, k?: string) => void, toolbar: HTMLElement): void {
  const list = h("div", { class: "activity" });
  const open = new Set<string>();
  const seen = { count: 0 };
  clear(root, list);

  const collapseAll = h("button", { class: "mini-btn", text: "Collapse all", onclick: () => { open.clear(); render(); } });
  const clearBtn = h("button", { class: "mini-btn", text: "Clear", onclick: () => { studio.activity = []; render(); } });
  clear(toolbar, collapseAll, clearBtn);

  const render = () => {
    const entries = studio.activity;
    if (entries.length === 0) {
      clear(
        list,
        h(
          "div",
          { class: "empty big" },
          icon("activity", "empty-icon"),
          h("div", { text: "No changes yet" }),
          h("div", { class: "empty-sub", text: "When the agent edits a scene, script or asset, it shows up here with its diff." }),
        ),
      );
      setBadge("");
      return;
    }
    // The newest change opens on its own, so the person sees what just happened.
    const newest = entries[0]!;
    if (newest.id > seen.count) {
      seen.count = newest.id;
      for (const f of newest.files) if (f.diff) open.add(key(newest, f));
    }
    clear(list, entries.map((e) => entry(e)));
    setBadge(String(entries.length));
  };

  const entry = (e: ActivityEntry) =>
    h(
      "div",
      { class: `act${e.by === "studio" ? " act-you" : ""}` },
      h(
        "div",
        { class: "act-head" },
        h("span", { class: "act-time mono", text: clock(e.at) }),
        // The person's own edits (by: "studio") say what they did; the rest is the agent, as before.
        e.by === "studio" ? h("span", { class: "act-who you" }, icon("pick"), " You") : h("span", { class: "act-who" }, icon("spark"), " Agent"),
        h("span", { class: "act-what", text: e.by === "studio" ? youDid(e.label).replace(/^You /, "") : describe(e.files) }),
        h("span", { class: "tb-spacer" }),
        hotBadge(e),
      ),
      e.files.map((f) => fileRow(e, f)),
    );

  const fileRow = (e: ActivityEntry, f: FileChange) => {
    const k = key(e, f);
    const isOpen = open.has(k);
    const stats = f.diff ? parseDiff(f.diff) : null;
    const row = h(
      "div",
      {
        class: `act-file${f.diff ? " has-diff" : ""}${isOpen ? " open" : ""}`,
        onclick: () => {
          if (!f.diff) return;
          if (open.has(k)) open.delete(k);
          else open.add(k);
          render();
        },
      },
      h("span", { class: `twisty ${f.diff ? (isOpen ? "open" : "closed") : "none"}` }, f.diff ? icon("chevron") : null),
      h("span", { class: `file-icon kind-${f.kind}` }, icon(fileIcon(f.kind))),
      h("span", { class: "act-path mono" }, dirOf(f.path), h("b", { text: baseOf(f.path) })),
      h("span", { class: `change change-${f.change}`, text: f.change }),
      stats ? h("span", { class: "diffstat mono" }, h("span", { class: "plus", text: `+${stats.added}` }), h("span", { class: "minus", text: `−${stats.removed}` })) : null,
      h("span", { class: "tb-spacer" }),
      window.studio && f.change !== "removed"
        ? h(
            "button",
            {
              class: "icon-btn",
              title: `Open ${f.path}`,
              onclick: (ev: MouseEvent) => {
                ev.stopPropagation();
                window.studio?.openInEditor(f.path, firstChangedLine(f.diff));
              },
            },
            icon("open"),
          )
        : null,
    );
    return h("div", { class: "act-file-wrap" }, row, isOpen && f.diff ? renderDiff(f.diff, f.path) : null);
  };

  studio.on("activity", render);
  render();
}

function key(e: ActivityEntry, f: FileChange): string {
  return `${e.id}:${f.path}`;
}

function hotBadge(e: ActivityEntry): HTMLElement {
  if (!e.hot) {
    const hotKinds = e.files.some((f) => ["scene", "prefab", "script", "asset"].includes(f.kind));
    return h("span", { class: `hot hot-none`, text: hotKinds ? "waiting for the game…" : "not used by the game" });
  }
  const at = `${(e.hot.frame / 60).toFixed(1)} s`;
  const text = e.hot.result === "kept" ? `state kept at ${at}` : e.hot.result === "restarted" ? `restarted${e.hot.reason ? `: ${e.hot.reason}` : ""}` : `not applied${e.hot.reason ? `: ${e.hot.reason}` : ""}`;
  return h("span", { class: `hot hot-${e.hot.result}` }, icon(e.hot.result === "kept" ? "bolt" : e.hot.result === "restarted" ? "restart" : "warning"), text);
}

function describe(files: FileChange[]): string {
  if (files.length === 1) {
    const f = files[0]!;
    return `${f.change === "added" ? "added" : f.change === "removed" ? "removed" : "changed"} ${baseOf(f.path)}`;
  }
  return `changed ${files.length} files`;
}

function fileIcon(kind: FileChange["kind"]): string {
  return { scene: "scene", prefab: "prefab", script: "script", asset: "asset", config: "config", test: "test", design: "design", other: "file" }[kind] ?? "file";
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}
function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function firstChangedLine(diff?: string): number | undefined {
  if (!diff) return undefined;
  const line = parseDiff(diff).lines.find((l) => l.kind === "add" || l.kind === "del");
  return line?.newNo ?? line?.oldNo;
}
