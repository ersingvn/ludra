import { paint } from "../format.ts";
import { CliError, loadProject, type Project } from "../project.ts";
import { createGameServer, PROJECT_PREFIX, SCRIPT_PREFIX } from "../server.ts";

/** Serves the game for a human to play, and reloads the page when the scene or its assets change. */
export function dev(dir: string, options: { port?: string }): number {
  const project = loadProject(dir);
  const port = Number(options.port ?? 5173);
  if (!Number.isInteger(port) || port <= 0) throw new CliError(`Invalid --port "${options.port}".`);

  const { server } = createGameServer(project, (browserModule) => page(project, browserModule));
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(paint("red", err.code === "EADDRINUSE" ? `Port ${port} is in use. Try --port ${port + 1}.` : err.message));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(paint("green", `▶ ${project.config.name} is running at http://localhost:${port}`));
    console.log(paint("dim", `  Arrows/WASD to move, Space/Z to jump, M to mute, R to restart.`));
    console.log(paint("dim", `  Editing ${project.entryLabel} or its images and sounds reloads the page. Ctrl+C to stop.`));
  });
  return 0;
}

function page(project: Project, browserModule: string): string {
  const { width, height } = project.config.window;
  const title = escapeHtml(project.config.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ludra</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0e14; color: #e6e6e6; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  canvas { max-width: 100vw; max-height: 100vh; box-shadow: 0 0 0 1px #2a3142; }
  #errors { max-width: 900px; padding: 24px; white-space: pre-wrap; font: 14px/1.5 ui-monospace, monospace; color: #ff9b9b; }
</style>
</head>
<body>
<canvas id="game" width="${width}" height="${height}"></canvas>
<pre id="errors" hidden></pre>
<script type="module">
import { startGame } from "${browserModule}";

const data = await (await fetch("/__ludra/scene")).json();
if (data.ok) {
  const scriptPaths = await (await fetch("/__ludra/scripts")).json();
  await startGame(document.getElementById("game"), data.scene, { assetBase: "${PROJECT_PREFIX}", scriptBase: "${SCRIPT_PREFIX}", scriptPaths });
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
