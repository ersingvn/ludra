import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fixed, pad, paint } from "../format.ts";
import { readModel, type ModelSummary } from "../gltf.ts";
import { CliError, isInside } from "../project.ts";

export type Inspection =
  | ({ kind: "model"; file: string; bytes: number; hints: string[]; missingFiles: string[] } & ModelSummary)
  | { kind: "image"; file: string; bytes: number; format: string; width: number; height: number }
  | { kind: "audio"; file: string; bytes: number; format: string; duration?: number; channels?: number; sampleRate?: number };

const AUDIO = [".wav", ".mp3", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus", ".webm"];
/** Clip roles an agent usually maps, in the order they're listed in the hint. */
const ROLES = ["idle", "walk", "run", "jump", "fall"];

/** `ludra inspect <file>`: what a model, image or sound contains, as text. */
export function inspect(file: string | undefined, options: { json?: boolean }): number {
  if (!file) throw new CliError("Usage: ludra inspect <file> [--json]. Reads .glb/.gltf models, PNG/JPEG/GIF/WebP/SVG images and WAV audio.");
  if (!existsSync(file) || !statSync(file).isFile()) throw new CliError(`No file at ${file}.`);
  const result = inspectFile(file);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(format(result));
  return 0;
}

/** Reads a file's header (or the whole model) into an `Inspection`. Throws `CliError` for files it can't read. */
export function inspectFile(file: string): Inspection {
  const ext = extname(file).toLowerCase();
  // Inside the current folder (normally the project), show the path the way a scene would write it.
  // Real paths on both sides: on macOS the temp folder is reached through a link (/var → /private/var).
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const absolute = real(file);
  const cwd = real(process.cwd());
  const shown = (isInside(cwd, absolute) ? relative(cwd, absolute) : file).replaceAll("\\", "/");
  const bytes = statSync(file).size;
  if (ext === ".glb" || ext === ".gltf") {
    let summary: ModelSummary;
    try {
      summary = readModel(file);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    const missingFiles = summary.externalFiles.filter((f) => !existsSync(join(dirname(file), f)));
    return { kind: "model", file: shown, bytes, ...summary, missingFiles, hints: modelHints(shown, summary, missingFiles) };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    const data = readFileSync(file);
    const size = ext === ".svg" ? svgSize(data.toString("utf8")) : imageSize(data);
    if (!size) throw new CliError(`${basename(file)} isn't a readable ${ext.slice(1).toUpperCase()} image: its header has no size.`);
    return { kind: "image", file: shown, bytes, ...size };
  }
  if (AUDIO.includes(ext)) {
    if (ext !== ".wav") return { kind: "audio", file: shown, bytes, format: ext.slice(1) };
    const wav = wavInfo(readFileSync(file));
    if (!wav) throw new CliError(`${basename(file)} isn't a readable WAV file: no "fmt " and "data" chunks.`);
    return { kind: "audio", file: shown, bytes, format: "wav", ...wav };
  }
  throw new CliError(`ludra inspect can't read ${ext || "files without an extension"}. It reads .glb .gltf .png .jpg .gif .webp .svg and audio (${AUDIO.join(" ")}).`);
}

function modelHints(file: string, model: ModelSummary, missing: string[]): string[] {
  const hints: string[] = [];
  const names = model.animations.map((a) => a.name);
  const mapping: Record<string, string> = {};
  for (const role of ROLES) {
    const clip = names.find((n) => n.toLowerCase().includes(role));
    if (clip) mapping[role] = clip;
  }
  if (Object.keys(mapping).length === 0 && names[0]) mapping.idle = names[0];
  const animations = Object.keys(mapping).length ? `, "animations": { ${Object.entries(mapping).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(", ")} }` : "";
  hints.push(`Use it with "mesh": { "model": ${JSON.stringify(file)}${animations} }`);

  const tallest = Math.max(...model.bounds.size);
  if (tallest > 100) hints.push(`It is ${fixed(tallest)} m across: probably exported in centimetres. Scale it by 0.01 (or re-export in metres).`);
  else if (tallest > 0 && tallest < 0.05) hints.push(`It is only ${fixed(tallest, 3)} m across: check the export units, or scale it up.`);
  if (model.bounds.min[1] < -0.01 && model.bounds.size[1] > 0) {
    hints.push(`Its lowest point is ${fixed(model.bounds.min[1], 2)} m below its origin. That only matters with "fit": "none"; the default fit puts the lowest point at the bottom of the body.`);
  }
  if (model.extensionsRequired.length) hints.push(`It needs ${model.extensionsRequired.join(", ")} to load; re-export without them if the renderer can't decode them.`);
  if (missing.length) hints.push(`Missing next to the model: ${missing.join(", ")}. Copy them there, or export a single .glb.`);
  return hints;
}

function format(info: Inspection): string {
  const size = info.bytes >= 1024 * 1024 ? `${fixed(info.bytes / 1024 / 1024)} MB` : `${fixed(info.bytes / 1024)} KB`;
  const row = (label: string, value: string) => `  ${pad(label, 11)} ${value}`;
  if (info.kind === "image") return `${paint("bold", info.file)}  ${info.format} image, ${size}\n${row("size", `${info.width} × ${info.height} px`)}`;
  if (info.kind === "audio") {
    const lines = [`${paint("bold", info.file)}  ${info.format} audio, ${size}`];
    if (info.duration !== undefined) lines.push(row("duration", `${fixed(info.duration, 2)}s`));
    if (info.channels !== undefined) lines.push(row("channels", info.channels === 1 ? "1 (mono)" : info.channels === 2 ? "2 (stereo)" : String(info.channels)));
    if (info.sampleRate !== undefined) lines.push(row("sample rate", `${info.sampleRate} Hz`));
    return lines.join("\n");
  }

  const [w, h, d] = info.bounds.size;
  const point = (p: number[]) => `(${p.map((n) => fixed(n, 2)).join(", ")})`;
  const lines = [
    `${paint("bold", info.file)}  ${info.format === "glb" ? "glTF binary" : "glTF"}, ${size}${info.generator ? paint("dim", `, made by ${info.generator}`) : ""}`,
    row("size", `${fixed(w, 2)} × ${fixed(h, 2)} × ${fixed(d, 2)} m ${paint("dim", "(x × y × z)")}`),
    row("bounds", `min ${point(info.bounds.min)}  max ${point(info.bounds.max)}`),
    row("geometry", `${count(info.meshes, "mesh", "meshes")}, ${count(info.primitives, "primitive")}, ${count(info.vertices, "vertex", "vertices")}, ${count(info.triangles, "triangle")}`),
    row("materials", info.materials.length ? info.materials.join(", ") : paint("dim", "none")),
    row("textures", `${info.textures}${info.images.length ? ` (${info.images.length} images, ${info.images.filter((i) => i.embedded).length} embedded)` : ""}`),
    row("skins", info.skins.length ? info.skins.map((s) => `${s.name ?? "skin"}: ${s.joints} bones`).join(", ") : paint("dim", "none")),
    row("animations", info.animations.length ? "" : paint("dim", "none")),
  ];
  for (const a of info.animations) lines.push(`    ${pad(a.name, 24)} ${fixed(a.duration, 2)}s ${paint("dim", count(a.channels, "channel"))}`);
  if (info.extensionsRequired.length) lines.push(row("requires", paint("yellow", info.extensionsRequired.join(", "))));
  if (info.externalFiles.length) lines.push(row("files", info.externalFiles.map((f) => (info.missingFiles.includes(f) ? paint("red", `${f} (missing)`) : f)).join(", ")));
  if (info.hints.length) lines.push("", ...info.hints.map((h) => `${paint("cyan", "hint:")} ${h}`));
  return lines.join("\n");
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Width and height from a PNG, JPEG, GIF or WebP header. */
export function imageSize(b: Uint8Array): { format: string; width: number; height: number } | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length >= 24 && ascii(1, 3) === "PNG") return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { format: "gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { format: "webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
      return { format: "webp", width: u24(24) + 1, height: u24(27) + 1 };
    }
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker (SOF0-SOF15, except DHT, JPG and DAC).
    for (let at = 2; at + 9 < b.length; ) {
      if (b[at] !== 0xff) return undefined;
      const marker = b[at + 1]!;
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return undefined;
}

/** Size of an SVG from its width/height attributes, falling back to the viewBox. */
export function svgSize(text: string): { format: string; width: number; height: number } | undefined {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return undefined;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const length = (value: string | undefined) => {
    const match = value === undefined ? null : /^\s*([\d.]+)\s*(px)?\s*$/.exec(value);
    return match ? Number(match[1]) : undefined;
  };
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = length(attr("width")) ?? box?.[2];
  const height = length(attr("height")) ?? box?.[3];
  return width !== undefined && height !== undefined && Number.isFinite(width) && Number.isFinite(height) ? { format: "svg", width, height } : undefined;
}

/** Duration, channels and sample rate from a WAV file's chunks. */
export function wavInfo(b: Uint8Array): { duration: number; channels: number; sampleRate: number } | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
  if (b.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return undefined;
  let fmt: { channels: number; sampleRate: number; byteRate: number } | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= b.length) {
      fmt = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true), byteRate: view.getUint32(at + 16, true) };
    } else if (id === "data" && fmt) {
      // A streamed WAV may leave the data size at 0 or past the end; use what is actually there.
      const dataBytes = Math.min(size || Infinity, b.length - at - 8);
      return { duration: fmt.byteRate ? Math.round((dataBytes / fmt.byteRate) * 1000) / 1000 : 0, channels: fmt.channels, sampleRate: fmt.sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}
