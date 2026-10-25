import type { Script } from "@ludra/core";

/** A stable pseudo-random number per index, so the clouds are the same every run. */
function hash(n: number): number {
  const x = Math.sin(n * 157.3 + 21.9) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A sea of soft clouds far below the islands, drifting slowly: each cloud is a cluster of
 * puffs in one InstancedMesh, so hundreds cost one draw call. params.count, params.depth.
 */
export default {
  render({ THREE, object, local, time, params }) {
    const count = Number(params.count ?? 40);
    if (!local.puffs) {
      const puffs = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 2),
        new THREE.MeshStandardMaterial({ color: "#fff6ef", roughness: 1, emissive: "#ffd9c7", emissiveIntensity: 0.25, flatShading: true }),
        count * 5,
      );
      puffs.receiveShadow = true;
      object.add(puffs);
      local.puffs = puffs;
      local.dummy = new THREE.Object3D();
    }
    const puffs = local.puffs as { setMatrixAt(i: number, m: unknown): void; instanceMatrix: { needsUpdate: boolean } };
    const dummy = local.dummy as {
      position: { set(x: number, y: number, z: number): void };
      scale: { set(x: number, y: number, z: number): void };
      updateMatrix(): void;
      matrix: unknown;
    };
    const depth = Number(params.depth ?? -14);
    for (let c = 0; c < count; c++) {
      // Clouds drift toward +x and wrap around a wide band under the islands.
      const x = ((hash(c) * 160 + time * (0.6 + hash(c + 3)) + 80) % 160) - 80;
      const z = -hash(c + 7) * 110 + 30;
      const y = depth + hash(c + 11) * 6;
      for (let p = 0; p < 5; p++) {
        const size = 2.2 + hash(c * 5 + p) * 2.4;
        dummy.position.set(x + (p - 2) * 2.1, y + hash(c * 5 + p + 1) * 1.2, z + (hash(c * 5 + p + 2) - 0.5) * 3);
        dummy.scale.set(size, size * 0.6, size);
        dummy.updateMatrix();
        puffs.setMatrixAt(c * 5 + p, dummy.matrix);
      }
    }
    puffs.instanceMatrix.needsUpdate = true;
  },
} satisfies Script;
