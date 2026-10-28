import type { Script } from "@ludra/core";

function hash(n: number): number {
  const x = Math.sin(n * 78.233 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Dresses a stone slab: old paving tiles of uneven tone on square slabs (params.w, params.d),
 * a carved ring of light on round stepping stones (params.round), tufts of moss on both.
 */
export default {
  render({ THREE, object, local, self, params, time }) {
    const l = local as Record<string, any>;
    if (!l.built) {
      l.built = true;
      const seed = self.id.length * 7 + self.width * 13;
      const top = 0.5;
      const w = Number(params.w ?? self.width);
      const d = Number(params.d ?? self.width);
      const round = params.round === true;

      if (!round) {
        const cols = Math.round(w / 1.25);
        const rows = Math.round(d / 1.25);
        const tile = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), cols * rows);
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            const i = c * rows + r;
            dummy.position.set((c + 0.5) * (w / cols) - w / 2, top - 0.03 + hash(seed + i) * 0.03, (r + 0.5) * (d / rows) - d / 2);
            dummy.rotation.set(0, (hash(seed + i + 50) - 0.5) * 0.06, 0);
            dummy.scale.set(w / cols - 0.08, 1, d / rows - 0.08);
            dummy.updateMatrix();
            tile.setMatrixAt(i, dummy.matrix);
            tile.setColorAt(i, color.set("#7d8aa0").offsetHSL(0, (hash(seed + i + 9) - 0.5) * 0.06, (hash(seed + i + 3) - 0.5) * 0.12));
          }
        }
        tile.receiveShadow = true;
        object.add(tile);
        // A thin line of light carved along the front edge, facing the camera.
        const rune = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 0.025, 0.02), new THREE.MeshBasicMaterial({ color: "#7fe8ff" }));
        rune.position.set(0, 0.05, d / 2 + 0.011);
        object.add(rune);
        l.rune = rune;
      } else {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(w / 2 - 0.28, 0.035, 6, 48), new THREE.MeshBasicMaterial({ color: "#7fe8ff" }));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = top + 0.005;
        const inner = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 - 0.45, w / 2 - 0.45, 0.04, 32), new THREE.MeshStandardMaterial({ color: "#7a879c", roughness: 0.95, flatShading: true }));
        inner.position.y = top;
        inner.receiveShadow = true;
        object.add(ring, inner);
        l.rune = ring;
      }

      // Moss gathers near the edges.
      const tufts = 10 + Math.round(w * d * 0.4);
      const moss = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.2, 0), new THREE.MeshStandardMaterial({ color: "#3f6b4f", roughness: 1, flatShading: true }), tufts);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < tufts; i++) {
        const a = hash(seed + i * 3) * Math.PI * 2;
        const edge = 0.82 + hash(seed + i * 3 + 1) * 0.16;
        const x = round ? Math.cos(a) * (w / 2) * edge : (hash(seed + i * 5) - 0.5) * w * 0.96;
        let z = round ? Math.sin(a) * (w / 2) * edge : (hash(seed + i * 5 + 2) > 0.5 ? 1 : -1) * (d / 2) * edge;
        if (!round && hash(seed + i * 7) > 0.5) z = (hash(seed + i * 7 + 1) - 0.5) * d * 0.96;
        const s = 0.6 + hash(seed + i * 11) * 1.1;
        dummy.position.set(round || Math.abs(z) > d * 0.4 ? x : Math.sign(x || 1) * (w / 2) * edge, top + 0.02, z);
        dummy.scale.set(s, s * 0.45, s);
        dummy.updateMatrix();
        moss.setMatrixAt(i, dummy.matrix);
      }
      moss.receiveShadow = true;
      object.add(moss);
    }
    // The runes breathe slowly, each slab a little out of step with the next.
    const pulse = 0.55 + 0.45 * Math.sin(time * 1.4 + self.z * 0.3);
    l.rune.material.color.setRGB(0.2 * pulse + 0.1, 0.55 * pulse + 0.2, 0.6 + 0.3 * pulse);
  },
} satisfies Script;
