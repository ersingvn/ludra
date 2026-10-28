import type { Script } from "@ludra/core";

/**
 * A stone lantern standing on the ground at the entity's position: plinth, post, a glowing
 * paper firebox (params.color) and a pagoda roof. Its flame flickers and casts real light.
 */
export default {
  render({ THREE, object, local, time, params, self }) {
    const l = local as Record<string, any>;
    if (!l.flame) {
      const color = String(params.color ?? "#ffb35c");
      const stone = new THREE.MeshStandardMaterial({ color: "#8590a3", roughness: 0.95, flatShading: true });
      const parts: [any, number][] = [
        [new THREE.CylinderGeometry(0.42, 0.5, 0.25, 6), 0.125],
        [new THREE.CylinderGeometry(0.16, 0.2, 0.9, 6), 0.7],
        [new THREE.CylinderGeometry(0.42, 0.3, 0.16, 6), 1.23],
        [new THREE.ConeGeometry(0.62, 0.42, 6), 1.92],
        [new THREE.SphereGeometry(0.1, 8, 6), 2.2],
      ];
      for (const [geometry, y] of parts) {
        const mesh = new THREE.Mesh(geometry, stone);
        mesh.position.y = y;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        object.add(mesh);
      }
      // The firebox: four posts around a glowing paper box.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.42), new THREE.MeshStandardMaterial({ color: "#fff1d6", emissive: color, emissiveIntensity: 2.5, roughness: 0.7 }));
      box.position.y = 1.5;
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.07), stone);
        post.position.set(x * 0.24, 1.5, z * 0.24);
        object.add(post);
      }
      const flame = new THREE.PointLight(color, 10, 9, 1.8);
      flame.position.y = 1.5;
      // Embers drift up out of the roof.
      const count = 12;
      const embers = new THREE.Points(
        new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3)),
        new THREE.PointsMaterial({ color, size: 0.06, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      object.add(box, flame, embers);
      Object.assign(l, { box, flame, embers, count, phase: self.x * 3.1 + self.z });
    }
    const t = time + l.phase;
    // Two out-of-step sines and a fast shiver read as a living flame.
    const flicker = 0.85 + 0.1 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 13.1) + 0.04 * Math.sin(t * 29.7);
    l.flame.intensity = 10 * flicker;
    l.box.material.emissiveIntensity = 2.5 * flicker;
    const positions = l.embers.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < l.count; i++) {
      const k = (i / l.count + t * 0.25) % 1;
      positions[i * 3] = Math.sin(i * 4.1 + t) * 0.15 * (1 + k);
      positions[i * 3 + 1] = 2.2 + k * 1.6;
      positions[i * 3 + 2] = Math.cos(i * 2.7 + t * 0.8) * 0.15 * (1 + k);
    }
    l.embers.geometry.attributes.position.needsUpdate = true;
    l.embers.material.opacity = 0.8;
  },
} satisfies Script;
