import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectAssetPaths, physicsEngineName, type SceneDef } from "@ludra/core";
import { formatDiagnostics, paint } from "../format.ts";
import { CliError, gameActions, isInside, listScenes, loadGame, loadProject, readScene, scriptPaths, type Project } from "../project.ts";
import { enginePaths, MEDIA_TYPES } from "../server.ts";
import { gltfFiles, ModulePacker, normalizePath, scriptSafe, zip } from "../pack.ts";

/** A game packed into a page, in memory. */
export interface PackedGame {
  /** The page, and the zip that holds it. */
  page: Buffer;
  zip: Buffer;
  scenes: string[];
  scripts: string[];
  assets: string[];
  /** What a player of this build won't get that `ludra dev` has. */
  notes: string[];
}

export interface BuildResult extends Omit<PackedGame, "page" | "zip"> {
  /** Where the page and the zip were written. */
  html: string;
  zip: string;
  htmlBytes: number;
  zipBytes: number;
}

/** Packs a game into one HTML file and writes it, and a zip of it, to `outDir`. */
export async function buildGame(project: Project, outDir: string): Promise<BuildResult> {
  const { page, zip: packed, ...rest } = await packGame(project);
  mkdirSync(outDir, { recursive: true });
  const htmlFile = join(outDir, "index.html");
  writeFileSync(htmlFile, page);
  const zipFile = join(outDir, `${slug(project.config.name)}-web.zip`);
  writeFileSync(zipFile, packed);
  return { html: htmlFile, zip: zipFile, htmlBytes: page.length, zipBytes: packed.length, ...rest };
}

/** Everything a game is, in one HTML file: engine, scenes, scripts and assets. */
export async function packGame(project: Project): Promise<PackedGame> {
  // Every scene the game can reach, checked as `ludra check` would, scripts too: a build never ships an error.
  const scenes: Record<string, SceneDef> = {};
  const failed: string[] = [];
  for (const path of listScenes(project)) {
    const { game, diagnostics, label } = await loadGame(project, path);
    if (!game || diagnostics.some((d) => d.severity === "error")) failed.push(formatDiagnostics(diagnostics, label));
    else scenes[label] = readScene(project, path).scene!;
  }
  if (failed.length > 0) throw new CliError(`The game has errors, so it wasn't built. Run "ludra check".\n\n${failed.join("\n\n")}`);
  const entry = project.entryLabel;
  const all = Object.values(scenes);

  const notes: string[] = [];
  const assets = new Map<string, { type: string; data: string }>();
  const missing: string[] = [];
  const addAsset = (path: string) => {
    const key = normalizePath(path);
    if (assets.has(key)) return;
    const file = resolve(project.dir, key);
    const type = MEDIA_TYPES[extname(key).toLowerCase()];
    if (!type || !isInside(project.dir, file) || !existsSync(file)) return void missing.push(key);
    assets.set(key, { type, data: readFileSync(file).toString("base64") });
    for (const more of gltfFiles(project.dir, key)) addAsset(more);
  };
  for (const scene of all) {
    for (const ref of collectAssetPaths(scene)) if (ref.kind !== "script" && ref.kind !== "scene") addAsset(ref.path);
    if (Object.values(scene.fonts ?? {}).includes("google")) notes.push("Google fonts load from the internet, so offline the game uses a fallback font.");
  }
  notes.splice(0, notes.length, ...new Set(notes));
  if (missing.length > 0) notes.push(`Not found, so not in the build: ${[...new Set(missing)].join(", ")}.`);

  const scripts = [...new Set(all.flatMap((scene) => scriptPaths(project, scene)))].filter((path) => existsSync(resolve(project.dir, path)));
  const engines = new Set(all.map((scene) => physicsEngineName(scene)));
  const threeD = all.some((scene) => scene.world?.dimensions === 3);

  const paths = enginePaths();
  const bare: Record<string, string> = {
    "@ludra/core": paths.coreIndex,
    "@ludra/core/browser": paths.coreEntry,
    "@ludra/physics": paths.physicsEntry,
    "@ludra/three": paths.threeEntry,
    "@dimforge/rapier2d-deterministic-compat": paths.rapierFile,
    "@dimforge/rapier3d-deterministic-compat": paths.rapier3dFile,
    three: join(paths.threeLibDir, "three.module.js"),
  };
  // 3D Rapier on its own: @ludra/physics's entry brings 2D Rapier (3 MB) along, which a 3D game never runs.
  const rapier3dModule = join(dirname(paths.physicsEntry), `rapier3d${extname(paths.physicsEntry)}`);
  // And a 2D game never runs 3D Rapier, though @ludra/physics can import it.
  const skip = new Set(engines.has("rapier3d") ? [] : [rapier3dModule]);
  const packer = new ModulePacker((specifier) => {
    if (bare[specifier]) return bare[specifier];
    if (specifier.startsWith("three/addons/")) return join(paths.threeAddonsDir, specifier.slice("three/addons/".length));
    return undefined;
  }, skip);
  const url = (file: string) => JSON.stringify(pathToFileURL(file).href);
  if (threeD) {
    // Render hooks ask for three's addons by name at run time, which no import says: find them in the scripts.
    for (const path of scripts) {
      const source = readFileSync(resolve(project.dir, path), "utf8");
      for (const [, addon] of source.matchAll(ADDON_CALL)) {
        const file = join(paths.threeAddonsDir, addon!);
        if (existsSync(file)) packer.alias(`three/addons/${addon}`, file);
        else notes.push(`${path} asks for the three addon "${addon}", which doesn't exist.`);
      }
      if (ADDON_BY_VARIABLE.test(source)) notes.push(`${path} names a three addon with a variable, which a build can't see: write addon("path/File.js").`);
    }
  }
  // Specifiers are literals, so the packer finds every module the game can import.
  const start = `import { startGame } from ${url(paths.coreEntry)};
const game = JSON.parse(document.getElementById("ludra-game").textContent);
const normalize = (path) => {
  const out = [];
  for (const part of path.replaceAll("\\\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};
const urls = new Map();
for (const [path, asset] of Object.entries(game.assets)) {
  const bytes = Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0));
  urls.set(path, URL.createObjectURL(new Blob([bytes], { type: asset.type })));
}
const scripts = {
${scripts.map((path) => `  ${JSON.stringify(path)}: () => import(${url(resolve(project.dir, path))}),`).join("\n")}
};
await startGame(document.getElementById("game"), game.scenes[game.entry], {
  assetUrl: (path) => urls.get(normalize(path)) ?? path,
  scriptPaths: Object.keys(scripts),
  loadScript: (path) => (scripts[path] ?? scripts[normalize(path)] ?? (() => Promise.reject(new Error("No script " + path + " in this build."))))(),
  loadScene: async (path) => {
    const scene = game.scenes[normalize(path)];
    if (!scene) throw new Error("No scene " + path + " in this build.");
    return structuredClone(scene);
  },
  loadPhysics: async (name) => {${engines.has("rapier") ? `\n    if (name === "rapier") await (await import(${url(paths.physicsEntry)})).loadRapierPhysics();` : ""}${engines.has("rapier3d") ? `\n    if (name === "rapier3d") await (await import(${url(rapier3dModule)})).loadRapier3DPhysics();` : ""}
  },${threeD ? `\n  loadRenderer3D: async () => (await import(${url(paths.threeEntry)})).createRenderer3D,` : ""}
  debugKey: false,
  entryPath: game.entry,
  save: ${JSON.stringify(project.config.name)},
  actions: ${JSON.stringify(gameActions(project))},
});
`;
  const startName = packer.addSource(start, join(project.dir, "__ludra_start__.js"));

  const { width, height, pixelated } = project.config.window;
  const title = escapeHtml(project.config.name);
  // Fills the window (an itch.io frame, a phone) and keeps the game's shape; pixel art scales by whole steps.
  const fit = pixelated
    ? `const fit = () => document.documentElement.style.setProperty("--scale", Math.max(1, Math.floor(Math.min(innerWidth / ${width}, innerHeight / ${height}))));`
    : `const fit = () => document.documentElement.style.setProperty("--scale", Math.min(innerWidth / ${width}, innerHeight / ${height}));`;
  const game = { entry, scenes, assets: Object.fromEntries(assets) };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="generator" content="Ludra">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  body { display: grid; place-items: center; touch-action: none; user-select: none; -webkit-user-select: none; }
  canvas { display: block; width: calc(${width}px * var(--scale, 1)); height: calc(${height}px * var(--scale, 1));${pixelated ? " image-rendering: pixelated;" : ""} }
</style>
</head>
<body>
<canvas id="game" width="${width}" height="${height}" tabindex="0"></canvas>
<script>
${fit}
addEventListener("resize", fit);
fit();
// In an itch.io frame keys go to the page once it has focus.
addEventListener("pointerdown", () => { window.focus(); document.getElementById("game")?.focus(); });
</script>
<script id="ludra-game" type="application/json">${scriptSafe(JSON.stringify(game))}</script>
${packer.html(startName)}
</body>
</html>
`;

  const page = Buffer.from(html, "utf8");
  return { page, zip: zip([{ name: "index.html", data: page }]), scenes: Object.keys(scenes), scripts, assets: [...assets.keys()], notes };
}

export async function build(dir: string, options: { out?: string; json?: boolean }): Promise<number> {
  const project = loadProject(dir);
  const outDir = resolve(project.dir, options.out ?? "build");
  const result = await buildGame(project, outDir);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, ...result, html: relative(project.dir, result.html), zip: relative(project.dir, result.zip) }, null, 2));
    return 0;
  }
  const show = (file: string) => relative(process.cwd(), file) || file;
  console.log(paint("green", `✓ Built ${project.config.name}: ${result.scenes.length} scene${result.scenes.length === 1 ? "" : "s"}, ${result.scripts.length} script${result.scripts.length === 1 ? "" : "s"}, ${result.assets.length} asset${result.assets.length === 1 ? "" : "s"}`));
  console.log(`  ${show(result.html)}  ${megabytes(result.htmlBytes)}   one file: open it, or put it on any web host`);
  console.log(`  ${show(result.zip)}  ${megabytes(result.zipBytes)}   for itch.io: upload it as an HTML game ("This file will be played in the browser")`);
  for (const note of result.notes) console.log(paint("yellow", `  ! ${note}`));
  return 0;
}

/** `addon("postprocessing/RenderPass.js")` in a render hook. */
const ADDON_CALL = /\baddon\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
/** `addon(name)`, with anything but a string literal. */
const ADDON_BY_VARIABLE = /\baddon\(\s*[^"'`\s)]/;

export function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-") || "game";
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
