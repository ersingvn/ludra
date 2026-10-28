import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What an agent needs to know about a .glb/.gltf model before using it, read without loading Three.js. */
export interface ModelSummary {
  format: "glb" | "gltf";
  generator?: string;
  /** In metres, in the scene root's space: each mesh's POSITION box through its node transforms. */
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  meshes: number;
  primitives: number;
  vertices: number;
  triangles: number;
  materials: string[];
  textures: number;
  images: { uri?: string; embedded: boolean }[];
  nodes: number;
  skins: { name?: string; joints: number }[];
  /** `duration` is the longest sampler input, in seconds. Unnamed clips are "animation-<i>". */
  animations: { name: string; duration: number; channels: number }[];
  extensionsRequired: string[];
  extensionsUsed: string[];
  /** Files the .gltf references (buffers/images by uri, not data: URIs), relative to the model file. */
  externalFiles: string[];
}

interface Gltf {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: { name?: string }[];
  textures?: unknown[];
  images?: { uri?: string; bufferView?: number }[];
  skins?: { name?: string; joints?: number[] }[];
  animations?: { name?: string; channels?: unknown[]; samplers?: { input: number }[] }[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

interface Parsed {
  json: Gltf;
  format: "glb" | "gltf";
  name: string;
  /** The GLB's BIN chunk, which is buffer 0 when that buffer has no uri. */
  bin?: Uint8Array;
  /** Folder for external buffers; absent when reading from memory. */
  dir?: string;
}

type Mat4 = number[];

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;
const COMPRESSION = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"];

/** Reads a .glb or .gltf file. Throws an Error that says what is wrong with it. */
export function readModel(file: string): ModelSummary {
  return summarize(parseFile(file));
}

/** Like `readModel`, from bytes in memory (a .glb or .gltf JSON). `name` is used for messages. */
export function readModelBuffer(bytes: Uint8Array, name: string): ModelSummary {
  return summarize(parse(bytes, name));
}

/** Every triangle of every mesh, in the scene root's space, merged into one vertex and index list. */
export function readModelGeometry(file: string): { positions: Float32Array; indices: Uint32Array } {
  const model = parseFile(file);
  const { json } = model;
  const buffers = new Map<number, Uint8Array>();
  const positions: number[] = [];
  const indices: number[] = [];

  walkMeshes(json, (mesh, matrix) => {
    for (const prim of json.meshes?.[mesh]?.primitives ?? []) {
      const mode = prim.mode ?? TRIANGLES;
      if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) continue;
      const compressed = compressionOf(json, prim);
      if (compressed) {
        throw new Error(`${model.name}: mesh ${mesh} is compressed with ${compressed}, which Ludra can't read for geometry. Export it without mesh compression.`);
      }
      const position = prim.attributes?.POSITION;
      if (position === undefined) continue;
      const points = readAccessor(model, buffers, position);
      const base = positions.length / 3;
      for (let i = 0; i + 2 < points.length; i += 3) {
        positions.push(...transformPoint(matrix, points[i]!, points[i + 1]!, points[i + 2]!));
      }
      const count = points.length / 3;
      const order = prim.indices === undefined ? Array.from({ length: count }, (_, i) => i) : Array.from(readAccessor(model, buffers, prim.indices));
      for (const [a, b, c] of triangles(order, mode)) indices.push(base + a, base + b, base + c);
    }
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function parseFile(file: string): Parsed {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    throw new Error(`Can't read ${file}: ${(err as Error).message}`);
  }
  return { ...parse(bytes, basename(file)), dir: dirname(file) };
}

function parse(bytes: Uint8Array, name: string): Parsed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67) return parseGlb(bytes, view, name);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(`${name} is neither a .glb (no "glTF" header) nor glTF JSON: ${(err as Error).message}`);
  }
  return { json: checkJson(json, name), format: "gltf", name };
}

function parseGlb(bytes: Uint8Array, view: DataView, name: string): Parsed {
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`${name} is a version ${version} .glb; only glTF 2.0 is supported. Re-export it as glTF 2.0.`);
  const length = Math.min(view.getUint32(8, true), bytes.length);
  let json: unknown;
  let bin: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= length; ) {
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) throw new Error(`${name} is truncated: a chunk runs past the end of the file.`);
    const chunk = bytes.subarray(start, start + chunkLength);
    if (type === 0x4e4f534a && json === undefined) {
      try {
        json = JSON.parse(new TextDecoder().decode(chunk));
      } catch (err) {
        throw new Error(`${name} has a broken JSON chunk: ${(err as Error).message}`);
      }
    } else if (type === 0x004e4942 && bin === undefined) {
      bin = chunk;
    }
    offset = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (json === undefined) throw new Error(`${name} has no JSON chunk, so it isn't a valid .glb.`);
  return { json: checkJson(json, name), format: "glb", name, bin };
}

function checkJson(json: unknown, name: string): Gltf {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${name} isn't glTF: the JSON is not an object.`);
  const version = (json as Gltf).asset?.version;
  if (typeof version !== "string") throw new Error(`${name} isn't glTF: it has no "asset": { "version" }.`);
  if (!version.startsWith("2")) throw new Error(`${name} is glTF ${version}; only glTF 2.0 is supported. Re-export it as glTF 2.0.`);
  return json as Gltf;
}

function summarize(model: Parsed): ModelSummary {
  const { json } = model;
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const buffers = new Map<number, Uint8Array>();

  let primitives = 0;
  let vertices = 0;
  let triangleCount = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      primitives++;
      const position = prim.attributes?.POSITION;
      const count = position === undefined ? 0 : (accessors[position]?.count ?? 0);
      vertices += count;
      const drawn = prim.indices === undefined ? count : (accessors[prim.indices]?.count ?? 0);
      const mode = prim.mode ?? TRIANGLES;
      if (mode === TRIANGLES) triangleCount += Math.floor(drawn / 3);
      else if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) triangleCount += Math.max(0, drawn - 2);
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  walkMeshes(json, (mesh, matrix) => {
    for (const prim of meshes[mesh]?.primitives ?? []) {
      const position = prim.attributes?.POSITION;
      if (position === undefined) continue;
      const box = positionBox(model, buffers, position);
      if (!box) continue;
      for (let corner = 0; corner < 8; corner++) {
        const pick = (axis: number, bit: number) => (corner & bit ? box.max[axis] : box.min[axis]) ?? 0;
        const p = transformPoint(matrix, pick(0, 1), pick(1, 2), pick(2, 4));
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, p[axis]!);
          max[axis] = Math.max(max[axis]!, p[axis]!);
        }
      }
    }
  });
  const empty = min[0] === Infinity;
  const bounds = {
    min: empty ? ([0, 0, 0] as [number, number, number]) : min.map(round) as [number, number, number],
    max: empty ? ([0, 0, 0] as [number, number, number]) : max.map(round) as [number, number, number],
    size: empty ? ([0, 0, 0] as [number, number, number]) : ([0, 1, 2].map((a) => round(max[a]! - min[a]!)) as [number, number, number]),
  };

  const animations = (json.animations ?? []).map((anim, i) => {
    let duration = 0;
    for (const sampler of anim.samplers ?? []) duration = Math.max(duration, accessorMax(model, buffers, sampler.input));
    return { name: anim.name || `animation-${i}`, duration: round(duration), channels: anim.channels?.length ?? 0 };
  });

  const externalFiles: string[] = [];
  const external = (uri: string | undefined) => {
    if (uri === undefined || uri.startsWith("data:")) return;
    const file = safeDecode(uri);
    if (!externalFiles.includes(file)) externalFiles.push(file);
  };
  for (const buffer of json.buffers ?? []) external(buffer.uri);
  for (const image of json.images ?? []) external(image.uri);

  return {
    format: model.format,
    ...(json.asset?.generator ? { generator: json.asset.generator } : {}),
    bounds,
    meshes: meshes.length,
    primitives,
    vertices,
    triangles: triangleCount,
    materials: (json.materials ?? []).map((m, i) => m.name || `material-${i}`),
    textures: json.textures?.length ?? 0,
    images: (json.images ?? []).map((image) =>
      image.uri === undefined || image.uri.startsWith("data:") ? { embedded: true } : { uri: safeDecode(image.uri), embedded: false },
    ),
    nodes: json.nodes?.length ?? 0,
    skins: (json.skins ?? []).map((skin) => ({ ...(skin.name ? { name: skin.name } : {}), joints: skin.joints?.length ?? 0 })),
    animations,
    extensionsRequired: json.extensionsRequired ?? [],
    extensionsUsed: json.extensionsUsed ?? [],
    externalFiles,
  };
}

/** Calls `visit` for every mesh node of the default scene (or every root node when there are no scenes) with its world matrix. */
function walkMeshes(json: Gltf, visit: (mesh: number, matrix: Mat4) => void): void {
  const nodes = json.nodes ?? [];
  let roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!roots) {
    const children = new Set(nodes.flatMap((n) => n.children ?? []));
    roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
  }
  const seen = new Set<number>();
  const walk = (index: number, parent: Mat4) => {
    const node = nodes[index];
    if (!node || seen.has(index)) return;
    seen.add(index);
    const matrix = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) visit(node.mesh, matrix);
    for (const child of node.children ?? []) walk(child, matrix);
  };
  for (const root of roots) walk(root, IDENTITY);
}

function positionBox(model: Parsed, buffers: Map<number, Uint8Array>, index: number): { min: number[]; max: number[] } | undefined {
  const accessor = model.json.accessors?.[index];
  if (!accessor) return undefined;
  if (accessor.min?.length === 3 && accessor.max?.length === 3 && !accessor.sparse) return { min: accessor.min, max: accessor.max };
  // min/max are required for POSITION, but not every exporter writes them: read the data if we can.
  const values = tryReadAccessor(model, buffers, index);
  if (!values || values.length < 3) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < values.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, values[i + axis]!);
      max[axis] = Math.max(max[axis]!, values[i + axis]!);
    }
  }
  return { min, max };
}

function accessorMax(model: Parsed, buffers: Map<number, Uint8Array>, index: number): number {
  const accessor = model.json.accessors?.[index];
  if (accessor?.max?.length && !accessor.sparse) return accessor.max[0]!;
  const values = tryReadAccessor(model, buffers, index);
  return values && values.length > 0 ? Math.max(...values) : 0;
}

function tryReadAccessor(model: Parsed, buffers: Map<number, Uint8Array>, index: number): Float64Array | undefined {
  try {
    return readAccessor(model, buffers, index);
  } catch {
    return undefined;
  }
}

/** An accessor's values as numbers (count × components), following byteStride and `normalized`. */
function readAccessor(model: Parsed, buffers: Map<number, Uint8Array>, index: number): Float64Array {
  const accessor = model.json.accessors?.[index];
  if (!accessor) throw new Error(`${model.name}: accessor ${index} doesn't exist.`);
  if (accessor.sparse) throw new Error(`${model.name}: accessor ${index} is sparse, which Ludra can't read. Export without sparse accessors.`);
  const components = COMPONENTS[accessor.type];
  const size = COMPONENT_BYTES[accessor.componentType];
  if (!components || !size) throw new Error(`${model.name}: accessor ${index} has an unknown type ${accessor.type}/${accessor.componentType}.`);
  const out = new Float64Array(accessor.count * components);
  if (accessor.bufferView === undefined) return out;

  const view = model.json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`${model.name}: bufferView ${accessor.bufferView} doesn't exist.`);
  if (view.extensions && COMPRESSION.some((e) => e in view.extensions!)) {
    throw new Error(`${model.name}: bufferView ${accessor.bufferView} is compressed with ${COMPRESSION.find((e) => e in view.extensions!)}, which Ludra can't read. Export it without mesh compression.`);
  }
  const buffer = loadBuffer(model, buffers, view.buffer);
  const stride = view.byteStride ?? components * size;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + stride * (accessor.count - 1) + components * size;
  if (accessor.count > 0 && end > buffer.length) throw new Error(`${model.name}: accessor ${index} reads past the end of buffer ${view.buffer}.`);
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = reader(accessor.componentType, accessor.normalized ?? false);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) out[i * components + c] = read(data, start + i * stride + c * size);
  }
  return out;
}

function reader(componentType: number, normalized: boolean): (data: DataView, at: number) => number {
  switch (componentType) {
    case 5120:
      return normalized ? (d, at) => Math.max(d.getInt8(at) / 127, -1) : (d, at) => d.getInt8(at);
    case 5121:
      return normalized ? (d, at) => d.getUint8(at) / 255 : (d, at) => d.getUint8(at);
    case 5122:
      return normalized ? (d, at) => Math.max(d.getInt16(at, true) / 32767, -1) : (d, at) => d.getInt16(at, true);
    case 5123:
      return normalized ? (d, at) => d.getUint16(at, true) / 65535 : (d, at) => d.getUint16(at, true);
    case 5125:
      return (d, at) => d.getUint32(at, true);
    default:
      return (d, at) => d.getFloat32(at, true);
  }
}

function loadBuffer(model: Parsed, buffers: Map<number, Uint8Array>, index: number): Uint8Array {
  const cached = buffers.get(index);
  if (cached) return cached;
  const buffer = model.json.buffers?.[index];
  if (!buffer) throw new Error(`${model.name}: buffer ${index} doesn't exist.`);
  let bytes: Uint8Array;
  if (buffer.uri === undefined) {
    if (index !== 0 || !model.bin) throw new Error(`${model.name}: buffer ${index} has no uri and there is no .glb BIN chunk.`);
    bytes = model.bin;
  } else if (buffer.uri.startsWith("data:")) {
    const comma = buffer.uri.indexOf(",");
    if (comma < 0 || !buffer.uri.slice(0, comma).endsWith(";base64")) throw new Error(`${model.name}: buffer ${index} has a data: URI that isn't base64.`);
    bytes = Buffer.from(buffer.uri.slice(comma + 1), "base64");
  } else {
    const file = safeDecode(buffer.uri);
    if (model.dir === undefined) throw new Error(`${model.name}: buffer ${index} is the external file ${file}, which can't be read from memory.`);
    try {
      bytes = readFileSync(join(model.dir, file));
    } catch {
      throw new Error(`${model.name}: buffer ${index} points to ${file}, which is missing next to the model. Copy it there or export a .glb.`);
    }
  }
  buffers.set(index, bytes);
  return bytes;
}

function compressionOf(json: Gltf, prim: GltfPrimitive): string | undefined {
  const own = COMPRESSION.find((e) => prim.extensions && e in prim.extensions);
  if (own) return own;
  const accessors = [...Object.values(prim.attributes ?? {}), ...(prim.indices === undefined ? [] : [prim.indices])];
  for (const a of accessors) {
    const viewIndex = json.accessors?.[a]?.bufferView;
    const ext = viewIndex === undefined ? undefined : json.bufferViews?.[viewIndex]?.extensions;
    const found = COMPRESSION.find((e) => ext && e in ext);
    if (found) return found;
  }
  return undefined;
}

function* triangles(order: number[], mode: number): Generator<[number, number, number]> {
  if (mode === TRIANGLES) {
    for (let i = 0; i + 2 < order.length; i += 3) yield [order[i]!, order[i + 1]!, order[i + 2]!];
  } else if (mode === TRIANGLE_STRIP) {
    // Every other triangle flips so all keep the same winding.
    for (let i = 0; i + 2 < order.length; i++) {
      yield i % 2 === 0 ? [order[i]!, order[i + 1]!, order[i + 2]!] : [order[i + 1]!, order[i]!, order[i + 2]!];
    }
  } else {
    for (let i = 1; i + 1 < order.length; i++) yield [order[0]!, order[i]!, order[i + 1]!];
  }
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A node's local matrix (column-major): its `matrix`, or translation × rotation × scale. */
function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [qx, qy, qz, qw] = [x ?? 0, y ?? 0, z ?? 0, w ?? 1];
  const [ax, ay, az] = [sx ?? 1, sy ?? 1, sz ?? 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * ax, 2 * (qx * qy + qw * qz) * ax, 2 * (qx * qz - qw * qy) * ax, 0,
    2 * (qx * qy - qw * qz) * ay, (1 - 2 * (qx * qx + qz * qz)) * ay, 2 * (qy * qz + qw * qx) * ay, 0,
    2 * (qx * qz + qw * qy) * az, 2 * (qy * qz - qw * qx) * az, (1 - 2 * (qx * qx + qy * qy)) * az, 0,
    tx ?? 0, ty ?? 0, tz ?? 0, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Six decimals: enough for any game model, and hides float noise like 0.30000000000000004. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6 || 0;
}

function safeDecode(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}
