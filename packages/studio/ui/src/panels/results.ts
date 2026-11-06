import { clear, clock, h } from "../dom.ts";
import { icon } from "../icons.ts";
import { pref } from "../layout.ts";
import type { CheckResult, Command, Diagnostic, Finding, ReviewResult, TestRunResult } from "../protocol.ts";
import type { Studio } from "../studio.ts";

type SetBadge = (text: string, kind?: string) => void;

/** The header line every result tab shares: what ran, when, how long, and a run button. */
function runBar(studio: Studio, command: Command, toolbar: HTMLElement, label: string): void {
  const meta = h("span", { class: "run-meta" });
  const btn = h("button", { class: "mini-btn primary", onclick: () => void studio.runCommand(command) }, icon("play"), h("span", { text: label }));
  clear(toolbar, meta, btn);
  const update = () => {
    const s = studio.runs[command];
    btn.disabled = s.running;
    btn.classList.toggle("running", s.running);
    meta.textContent = s.running ? `running ludra ${command}…` : s.at ? `${s.auto ? "auto · " : ""}${clock(s.at)}${s.ms ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}` : "";
  };
  studio.on("run", (c) => c === command && update());
  update();
}

function waiting(text: string, sub: string, iconName: string): HTMLElement {
  return h("div", { class: "empty big" }, icon(iconName, "empty-icon"), h("div", { text }), h("div", { class: "empty-sub", text: sub }));
}

function runningState(command: Command): HTMLElement {
  return h("div", { class: "empty big" }, h("div", { class: "spinner" }), h("div", { text: `Running ludra ${command}…` }));
}

// Problems

export function problems(root: HTMLElement, studio: Studio, setBadge: SetBadge, toolbar: HTMLElement): void {
  runBar(studio, "check", toolbar, "Check");
  const render = () => {
    const s = studio.runs.check;
    const result = s.response?.result as CheckResult | undefined;
    // What check already lists isn't shown twice.
    const known = new Set((result?.diagnostics ?? []).map((d) => `${d.code} ${d.path}`));
    const live = studio.gameErrors.filter((d) => !known.has(`${d.code} ${d.path}`));
    if (!result && s.running) return clear(root, runningState("check"));
    if (s.error && !result) return clear(root, waiting("Couldn't run check", s.error, "error"));
    const diags = result?.diagnostics ?? [];
    const errors = (result?.errors ?? 0) + live.filter((d) => d.severity === "error").length;
    const warnings = (result?.warnings ?? 0) + live.filter((d) => d.severity === "warning").length;
    setBadge(errors > 0 ? String(errors) : warnings > 0 ? String(warnings) : "", errors > 0 ? "bad" : "warn");
    if (!result && live.length === 0) return clear(root, waiting("Not checked yet", "Check runs on its own after every change.", "check"));
    if (diags.length === 0 && live.length === 0) {
      return clear(root, h("div", { class: "all-good" }, icon("check"), h("span", { text: `No problems in ${result?.file ?? "the project"}` }), s.running ? h("span", { class: "spinner small" }) : null));
    }
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of diags) {
      const f = d.file ?? result?.file ?? "project";
      byFile.set(f, [...(byFile.get(f) ?? []), d]);
    }
    clear(
      root,
      h(
        "div",
        { class: "problems" },
        live.length > 0 ? group("Running game (the change it rejected)", live, true) : null,
        [...byFile].map(([file, list]) => group(file, list, false)),
      ),
    );
  };
  const group = (file: string, list: Diagnostic[], live: boolean) =>
    h(
      "div",
      { class: "prob-group" },
      h(
        "div",
        { class: "prob-file" },
        icon(live ? "bolt" : "file"),
        h("span", { class: "mono", text: file }),
        h("span", { class: "panel-count", text: String(list.length) }),
        window.studio && !live
          ? h("button", { class: "icon-btn", title: `Open ${file}`, onclick: () => window.studio?.openInEditor(file) }, icon("open"))
          : null,
      ),
      list.map((d) =>
        h(
          "div",
          { class: `prob prob-${d.severity}` },
          h("span", { class: "prob-icon" }, icon(d.severity === "error" ? "error" : "warning")),
          h(
            "div",
            { class: "prob-text" },
            h("div", { class: "prob-line" }, h("span", { class: "prob-msg", text: d.message }), h("span", { class: "code-chip", text: d.code })),
            d.path ? h("div", { class: "prob-path mono", text: d.path }) : null,
            d.fix ? h("div", { class: "prob-fix" }, h("span", { class: "fix-label", text: "fix" }), h("span", { text: d.fix })) : null,
          ),
        ),
      ),
    );
  studio.on("run", (c) => c === "check" && render());
  studio.on("gameErrors", render);
  render();
}

// Tests

export function tests(root: HTMLElement, studio: Studio, setBadge: SetBadge, toolbar: HTMLElement): void {
  runBar(studio, "test", toolbar, "Run tests");
  const openFailures = new Set<string>();
  const render = () => {
    const s = studio.runs.test;
    const result = s.response?.result as TestRunResult | undefined;
    if (!result && s.running) return clear(root, runningState("test"));
    if (s.error && !result) return clear(root, waiting("Couldn't run the tests", s.error, "error"));
    if (!result) {
      setBadge("");
      return clear(root, waiting("No test run yet", "Tests run on demand: press Run tests or Ctrl+Shift+T.", "flask"));
    }
    if (result.error && result.files.length === 0) {
      setBadge("0", "warn");
      return clear(root, waiting("No tests", result.error, "flask"));
    }
    const failed = result.failed ?? 0;
    const passed = result.passed ?? 0;
    setBadge(failed > 0 ? String(failed) : String(passed), failed > 0 ? "bad" : "good");
    const total = passed + failed;
    clear(
      root,
      h(
        "div",
        { class: "tests" },
        h(
          "div",
          { class: `test-summary ${failed > 0 ? "bad" : "good"}${s.running ? " stale" : ""}` },
          h("div", { class: "bar" }, h("span", { class: "bar-pass", attrs: { style: `width:${total ? (passed / total) * 100 : 0}%` } })),
          h("span", { text: `${passed} passed` }),
          failed > 0 ? h("span", { class: "bad-text", text: `${failed} failed` }) : null,
        ),
        result.files.map((f) =>
          h(
            "div",
            { class: "test-file" },
            h("div", { class: "test-file-name mono" }, icon("test"), f.file, window.studio ? h("button", { class: "icon-btn", title: `Open tests/${f.file}`, onclick: () => window.studio?.openInEditor(`tests/${f.file}`) }, icon("open")) : null),
            f.error ? h("div", { class: "test bad" }, icon("error"), h("span", { text: `Could not read the file: ${f.error}` })) : null,
            f.tests.map((t) => {
              const k = `${f.file}:${t.name}`;
              const failures = t.results.filter((r) => !r.pass);
              const isOpen = !t.pass && !openFailures.has(`closed:${k}`);
              return h(
                "div",
                { class: `test-wrap` },
                h(
                  "div",
                  {
                    class: `test ${t.pass ? "good" : "bad"}`,
                    onclick: () => {
                      if (t.pass) return;
                      if (openFailures.has(`closed:${k}`)) openFailures.delete(`closed:${k}`);
                      else openFailures.add(`closed:${k}`);
                      render();
                    },
                  },
                  icon(t.pass ? "check" : "error"),
                  h("span", { class: "test-name", text: t.name }),
                  h("span", { class: "tb-spacer" }),
                  h("span", { class: "test-time mono", text: `${t.duration < 1 ? Math.round(t.duration * 1000) + " ms" : t.duration.toFixed(2) + " s"}` }),
                ),
                isOpen
                  ? h(
                      "div",
                      { class: "test-fails" },
                      t.error ? h("div", { class: "assert" }, h("span", { class: "mono", text: t.error })) : null,
                      failures.map((r) =>
                        h(
                          "div",
                          { class: "assert" },
                          h("span", { class: "assert-src mono", text: r.source }),
                          h("span", { class: "muted", text: "→" }),
                          h("span", { text: r.message }),
                          h("span", { class: "muted mono", text: ` at ${r.time.toFixed(2)} s` }),
                        ),
                      ),
                    )
                  : null,
              );
            }),
          ),
        ),
      ),
    );
  };
  studio.on("run", (c) => c === "test" && render());
  render();
}

// Review

const AREAS: Record<string, string> = {
  proof: "Proof",
  fair: "Fair",
  feel: "Feel",
  looks: "Looks",
  readable: "Readable",
  players: "Players",
  shipping: "Shipping",
  identity: "Identity",
};
const AREA_HINT: Record<string, string> = {
  proof: "is it shown to work?",
  fair: "can a person beat it, and can it never trap them?",
  feel: "does every moment answer the player?",
  looks: "does it have a style of its own?",
  readable: "can a player see what matters?",
  players: "what did people say when they played it?",
  shipping: "will it run well where players are?",
  identity: "is it a game, or a project folder?",
};

export function review(root: HTMLElement, studio: Studio, setBadge: SetBadge, toolbar: HTMLElement): void {
  const show = pref<"all" | "issue">("review.show", "all");
  const fast = pref<boolean>("review.fast", true);
  const filter = h("div", { class: "seg" });
  const fastBox = h("label", { class: "check-label", title: "Skip the slow checks (screenshots and random play)" }, h("input", { attrs: { type: "checkbox" } }), h("span", { text: "fast" }));
  const fastInput = fastBox.querySelector("input")!;
  fastInput.checked = fast.get();
  fastInput.addEventListener("change", () => fast.set(fastInput.checked));
  const renderFilter = () =>
    clear(
      filter,
      (["all", "issue"] as const).map((v) =>
        h("button", { class: show.get() === v ? "on" : "", text: v === "all" ? "All" : "Issues", onclick: () => { show.set(v); renderFilter(); render(); } }),
      ),
    );
  renderFilter();
  // Review's run button passes --fast when it's ticked.
  const meta = h("span", { class: "run-meta" });
  const btn = h("button", { class: "mini-btn primary", onclick: () => void studio.runCommand("review", false, fastInput.checked ? ["--fast"] : []) }, icon("play"), h("span", { text: "Review" }));
  clear(toolbar, filter, fastBox, meta, btn);

  const render = () => {
    const s = studio.runs.review;
    btn.disabled = s.running;
    meta.textContent = s.running ? "running ludra review…" : s.at ? `${clock(s.at)}${s.ms ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}` : "";
    const result = s.response?.result as ReviewResult | undefined;
    if (!result && s.running) return clear(root, runningState("review"));
    if (s.error && !result) return clear(root, waiting("Couldn't run review", s.error, "error"));
    if (!result) {
      setBadge("");
      return clear(root, waiting("Not reviewed yet", "Review asks whether the game is finished: proven, fair, felt, styled and named.", "review"));
    }
    setBadge(result.issues > 0 ? String(result.issues) : result.ideas > 0 ? String(result.ideas) : "✓", result.issues > 0 ? "bad" : result.ideas > 0 ? "info" : "good");
    const list = result.findings.filter((f) => show.get() === "all" || f.level === "issue");
    if (list.length === 0) return clear(root, h("div", { class: "all-good" }, icon("check"), h("span", { text: result.findings.length === 0 ? "Nothing found. It looks finished." : "No issues, only ideas." })));
    const byArea = new Map<string, Finding[]>();
    for (const f of list) byArea.set(f.area, [...(byArea.get(f.area) ?? []), f]);
    const areas = [...byArea].sort((a, b) => Object.keys(AREAS).indexOf(a[0]) - Object.keys(AREAS).indexOf(b[0]));
    clear(
      root,
      h(
        "div",
        { class: `review${s.running ? " stale" : ""}` },
        areas.map(([area, findings]) => {
          const issues = findings.filter((f) => f.level === "issue").length;
          return h(
            "div",
            { class: "rev-area" },
            h(
              "div",
              { class: "rev-area-head" },
              h("span", { class: "rev-area-name", text: AREAS[area] ?? area }),
              h("span", { class: "rev-area-hint", text: AREA_HINT[area] ?? "" }),
              h("span", { class: "tb-spacer" }),
              issues > 0 ? h("span", { class: "pill bad", text: `${issues} issue${issues === 1 ? "" : "s"}` }) : null,
              findings.length - issues > 0 ? h("span", { class: "pill info", text: `${findings.length - issues} idea${findings.length - issues === 1 ? "" : "s"}` }) : null,
            ),
            findings
              .sort((a, b) => (a.level === b.level ? 0 : a.level === "issue" ? -1 : 1))
              .map((f) =>
                h(
                  "div",
                  { class: `finding ${f.level}` },
                  h("span", { class: "prob-icon" }, icon(f.level === "issue" ? "warning" : "idea")),
                  h(
                    "div",
                    { class: "prob-text" },
                    h("div", { class: "prob-line" }, h("span", { class: "prob-msg", text: f.message }), h("span", { class: "code-chip", text: f.code })),
                    h("div", { class: "prob-path mono", text: f.where }),
                    f.fix ? h("div", { class: "prob-fix" }, h("span", { class: "fix-label", text: "fix" }), h("span", { text: f.fix })) : null,
                  ),
                ),
              ),
          );
        }),
      ),
    );
  };
  studio.on("run", (c) => c === "review" && render());
  render();
}
