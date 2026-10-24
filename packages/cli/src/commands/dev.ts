import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../format.ts";
import { CliError, loadProject, readScene, type Project } from "../project.ts";

/**
 * Serves the game with the engine's browser runtime and reloads the page when
 * the scene file changes. No bundler: when the engine runs from source, its
 * TypeScript files are type-stripped on the fly.
 */
export function dev(dir: string, options: { port?: string }): number {
  const project = loadProject(dir);
  const port = Number(options.port ?? 5173);
  if (!Number.isInteger(port) || port <= 0) throw new CliError(`Invalid --port "${options.port}".`);

  const coreEntry = fileURLToPath(import.meta.resolve("@ludra/core/browser"));
  const coreDir = dirname(coreEntry);
  const browserModule = `/__ludra/core/${relative(coreDir, coreEntry).replaceAll(sep, "/")}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(project, browserModule));
      } else if (url.pathname === "/__ludra/scene") {
        const { scene, diagnostics } = readScene(project);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: !!scene, scene, diagnostics }));
      } else if (url.pathname === "/__ludra/version") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(existsSync(project.entryPath) ? String(statSync(project.entryPath).mtimeMs) : "missing");
      } else if (url.pathname.startsWith("/__ludra/core/")) {
        const file = join(coreDir, decodeURIComponent(url.pathname.slice("/__ludra/core/".length)));
        if (!file.startsWith(coreDir + sep) || !existsSync(file)) return notFound(res);
        const source = readFileSync(file, "utf8");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(extname(file) === ".ts" ? stripTypeScriptTypes(source) : source);
      } else {
        notFound(res);
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end((err as Error).message);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(paint("red", err.code === "EADDRINUSE" ? `Port ${port} is in use. Try --port ${port + 1}.` : err.message));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(paint("green", `▶ ${project.config.name} is running at http://localhost:${port}`));
    console.log(paint("dim", `  Arrows/WASD to move, Space/Z to jump. Editing ${project.entryLabel} reloads the page. Ctrl+C to stop.`));
  });
  return 0;
}

function notFound(res: import("node:http").ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
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
  startGame(document.getElementById("game"), data.scene);
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
