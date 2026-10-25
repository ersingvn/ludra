import type { Script } from "@ludra/core";

/**
 * The way home: a ring of motes spiralling into the goal's center. Dim while crystals are
 * missing (the goal won't accept the player yet), bright once there are enough.
 */
export default {
  render({ THREE, object, local, time, world, params }) {
    const count = 160;
    if (!local.points) {
      const positions = new Float32Array(count * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: "#bff4ff", size: 0.12, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
      const points = new THREE.Points(geometry, material);
      const glow = new THREE.PointLight("#7fd4ff", 0, 10, 2);
      object.add(points, glow);
      local.points = points;
      local.glow = glow;
    }
    const open = world.score >= Number(params.need ?? 0);
    const points = local.points as { geometry: { attributes: { position: { array: Float32Array; needsUpdate: boolean } } }; material: { opacity: number; color: { set(c: string): void } } };
    const positions = points.geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      // Each mote circles inward and starts again at the rim.
      const t = (i / count + time * (open ? 0.35 : 0.1)) % 1;
      const angle = i * 2.399 + t * 6;
      const radius = 1.25 * (1 - t);
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius;
      positions[i * 3 + 2] = (t - 0.5) * 0.3;
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.material.opacity = open ? 0.95 : 0.35;
    points.material.color.set(open ? "#d9fbff" : "#7f93b8");
    (local.glow as { intensity: number }).intensity = open ? 10 + 3 * Math.sin(time * 4) : 1;
  },
} satisfies Script;
