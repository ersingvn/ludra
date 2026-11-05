import { paint } from "../format.ts";
import { CliError, loadProject, type Project } from "../project.ts";
import { RECORDINGS_DIR } from "../recordings.ts";
import { createGameServer, PROJECT_PREFIX, RECORDING_PATH, SCRIPT_PREFIX } from "../server.ts";

/** Serves the game for a human to play, records the session, and reloads the page when the scene or its assets change. */
export function dev(dir: string, options: { port?: string; "no-record"?: boolean }): number {
  const project = loadProject(dir);
  const port = Number(options.port ?? 5173);
  if (!Number.isInteger(port) || port <= 0) throw new CliError(`Invalid --port "${options.port}".`);

  const record = !options["no-record"];
  const { server } = createGameServer(project, (engine) => page(project, engine, record), { record });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(paint("red", err.code === "EADDRINUSE" ? `Port ${port} is in use. Try --port ${port + 1}.` : err.message));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(paint("green", `▶ ${project.config.name} is running at http://localhost:${port}`));
    console.log(paint("dim", `  Arrows/WASD to move, Space/Z to jump, M to mute, R to restart, \` (backquote) for the debug view.`));
    if (record) {
      console.log(paint("dim", `  Marking a moment: 1 too hard, 2 boring, 3 confusing, 4 love this, N your own words.`));
      console.log(paint("dim", `  Every session is recorded in ${RECORDINGS_DIR}/ (--no-record turns that off). "ludra feedback" shows what players felt.`));
    }
    console.log(paint("dim", `  Editing a scene, prefab, script or asset reloads the page. Ctrl+C to stop.`));
  });
  return 0;
}

function page(project: Project, { browserModule, physicsModule, threeModule, importMap }: { browserModule: string; physicsModule: string; threeModule: string; importMap: string }, record: boolean): string {
  const { width, height, pixelated } = project.config.window;
  const title = escapeHtml(project.config.name);
  // A rule on the element, not on one canvas: a postfx scene swaps the canvas for its own.
  const pixelStyle = pixelated ? `\n  canvas { width: calc(${width}px * var(--scale, 1)); height: calc(${height}px * var(--scale, 1)); max-width: none; max-height: none; image-rendering: pixelated; }` : "";
  const pixelScript = pixelated
    ? `\nconst fit = () => document.documentElement.style.setProperty("--scale", Math.max(1, Math.floor(Math.min(innerWidth / ${width}, innerHeight / ${height}))));\naddEventListener("resize", fit);\nfit();\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ludra</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0e14; color: #e6e6e6; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  canvas { max-width: 100vw; max-height: 100vh; box-shadow: 0 0 0 1px #2a3142; }${pixelStyle}
  #marks { position: fixed; left: 0; right: 0; bottom: 6px; text-align: center; font-size: 12px; color: #8b93a7; pointer-events: none; text-shadow: 0 1px 2px #000; }
  #errors { max-width: 900px; padding: 24px; white-space: pre-wrap; font: 14px/1.5 ui-monospace, monospace; color: #ff9b9b; }
</style>
</head>
<body>
<canvas id="game" width="${width}" height="${height}"></canvas>
<pre id="errors" hidden></pre>
${record ? `<div id="marks">Recording · 1 too hard · 2 boring · 3 confusing · 4 love this · N a note</div>` : ""}
${importMap}
<script type="module">
import { Recorder, startGame } from "${browserModule}";${pixelScript}
// Rapier is a few MB of WebAssembly: only scenes with "physics": "rapier" (or 3D scenes) load it.
const loadPhysics = async (name) => {
  if (name === "rapier") await (await import("${physicsModule}")).loadRapierPhysics();
  if (name === "rapier3d") await (await import("${physicsModule}")).loadRapier3DPhysics();
};
// Three.js draws 3D scenes; 2D scenes never load it.
const loadRenderer3D = async () => (await import("${threeModule}")).createRenderer3D;

// One recording per page load. It only reaches the disk once the player does something.
const startRecorder = (entry, versions) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const session = stamp + "-" + Math.random().toString(36).slice(2, 8);
  let closing = false;
  const save = (recording, index, take) => {
    const body = JSON.stringify({ recording, index, take });
    // A fetch can die with the page; a beacon is the browser's promise to send it anyway, up to 64 KB.
    if (closing && navigator.sendBeacon("${RECORDING_PATH}", new Blob([body], { type: "application/json" }))) return;
    fetch("${RECORDING_PATH}", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
  };
  const recorder = new Recorder({ session, game: ${JSON.stringify(project.config.name)}, entry, version: (scene) => versions.get(scene) ?? "", save, now: () => new Date().toISOString() });
  // Often, because nothing a closing page sends is sure to arrive: this bounds what can be lost.
  setInterval(() => recorder.flush(), 2000);
  addEventListener("visibilitychange", () => {
    if (document.hidden) recorder.flush();
  });
  addEventListener("pagehide", () => {
    closing = true;
    recorder.stop();
  });
  return recorder;
};

const data = await (await fetch("/__ludra/scene")).json();
if (data.ok) {
  const scriptPaths = await (await fetch("/__ludra/scripts")).json();
  const versions = new Map([[data.path, data.version]]);
  const loadScene = async (path) => {
    const next = await (await fetch("/__ludra/scene?path=" + encodeURIComponent(path))).json();
    if (!next.ok) throw new Error(next.diagnostics.map((d) => d.code + " at " + d.path + ": " + d.message).join(" "));
    versions.set(path, next.version);
    return next.scene;
  };
  const recorder = ${record} ? startRecorder(data.path, versions) : undefined;
  await startGame(document.getElementById("game"), data.scene, { assetBase: "${PROJECT_PREFIX}", scriptBase: "${SCRIPT_PREFIX}", scriptPaths, loadScene, loadPhysics, loadRenderer3D, recorder });
} else {
  document.getElementById("game").hidden = true;
  const errors = document.getElementById("errors");
  errors.hidden = false;
  errors.textContent = "The scene has errors (run \`ludra check\`):\\n\\n" +
    data.diagnostics.map((d) => d.severity + " " + d.code + " at " + d.path + "\\n  " + d.message + (d.fix ? "\\n  fix: " + d.fix : "")).join("\\n\\n");
}

const version = await (await fetch("/__ludra/version")).text();
setInterval(async () => {
  try {
    if ((await (await fetch("/__ludra/version")).text()) !== version) location.reload();
  } catch {}
}, 1000);
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
