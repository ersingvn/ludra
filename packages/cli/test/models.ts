/** Builds small glTF models in memory for tests: no files or exporters needed. */

/** A unit box (-0.5..0.5) on a node moved up 1 and scaled 2, a 2 s "Spin" clip and a 3-joint skin. */
export function boxModel(options: { stride?: boolean; indexed?: boolean } = {}): { json: Record<string, unknown>; bin: Buffer } {
  const corners: number[][] = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5]);
  // Two triangles per face, as corner indices.
  const faces = [
    [0, 2, 1, 1, 2, 3], [4, 5, 6, 5, 7, 6], [0, 1, 4, 1, 5, 4],
    [2, 6, 3, 3, 6, 7], [0, 4, 2, 2, 4, 6], [1, 3, 5, 3, 7, 5],
  ].flat();
  const indexed = options.indexed ?? true;
  const points = indexed ? corners : faces.map((i) => corners[i]!);
  const stride = options.stride ? 16 : 12;

  const position = Buffer.alloc(points.length * stride);
  points.forEach((p, i) => p.forEach((v, axis) => position.writeFloatLE(v, i * stride + axis * 4)));
  const indices = Buffer.alloc(indexed ? faces.length * 2 : 0);
  faces.forEach((v, i) => indexed && indices.writeUInt16LE(v, i * 2));
  const times = Buffer.alloc(8);
  times.writeFloatLE(0, 0);
  times.writeFloatLE(2, 4);
  const rotations = Buffer.alloc(32);
  [0, 0, 0, 1, 0, 1, 0, 0].forEach((v, i) => rotations.writeFloatLE(v, i * 4));

  const parts = [position, indices, times, rotations];
  const offsets = parts.map((_, i) => parts.slice(0, i).reduce((sum, p) => sum + p.length, 0));
  const bin = Buffer.concat(parts);
  const views = parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.length, ...(i === 0 && options.stride ? { byteStride: 16 } : {}) }));

  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: points.length, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 2, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [2] },
    { bufferView: 3, componentType: 5126, count: 2, type: "VEC4" },
  ];
  if (indexed) accessors.push({ bufferView: 1, componentType: 5123, count: faces.length, type: "SCALAR" });
  const primitive = { attributes: { POSITION: 0 }, ...(indexed ? { indices: 3 } : {}), material: 0 };

  const json = {
    asset: { version: "2.0", generator: "ludra test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Box", mesh: 0, translation: [0, 1, 0], scale: [2, 2, 2], children: [1] }, { children: [2] }, { children: [3] }, {}],
    meshes: [{ primitives: [primitive] }],
    materials: [{ name: "Crate" }],
    accessors,
    bufferViews: views.filter((v) => v.byteLength > 0),
    buffers: [{ byteLength: bin.length }],
    skins: [{ name: "Rig", joints: [1, 2, 3] }],
    animations: [{ name: "Spin", samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }],
  };
  if (!indexed) {
    // Without the empty index view, later views shift down by one.
    json.bufferViews = views.filter((_, i) => i !== 1);
    accessors[1]!.bufferView = 1;
    accessors[2]!.bufferView = 2;
  }
  return { json, bin };
}

export function glb(json: object, bin: Buffer): Buffer {
  const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const text = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const data = pad(bin, 0);
  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  const body = Buffer.concat([chunk(0x4e4f534a, text), chunk(0x004e4942, data)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}
