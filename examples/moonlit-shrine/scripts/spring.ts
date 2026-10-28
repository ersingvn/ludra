import type { Script } from "@ludra/core";

/**
 * The spirit spring: stepping onto it throws the player straight up (params.launch, m/s),
 * high enough to reach the sanctum. Game logic in update, its glow and rising motes in render.
 */
export default {
  update({ self, world, params }) {
    const player = world.player();
    if (!player || !self.touches(player) || player.vy > 1) return;
    player.vy = Number(params.launch ?? 12);
    self.state.launches = Number(self.state.launches ?? 0) + 1;
    world.emit("spring");
  },

  render({ THREE, object, local, time, recent }) {
    const l = local as Record<string, any>;
    if (!l.motes) {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1.1, 0.3, 40),
        new THREE.MeshStandardMaterial({ color: "#3a4256", roughness: 0.8, flatShading: true }),
      );
      base.receiveShadow = true;
      // A ring of light carved into the stone.
      const rune = new THREE.Mesh(
        new THREE.TorusGeometry(0.7, 0.05, 8, 48),
        new THREE.MeshBasicMaterial({ color: "#8ff3ff" }),
      );
      rune.rotation.x = Math.PI / 2;
      rune.position.y = 0.16;
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(0.62, 40),
        new THREE.MeshBasicMaterial({ color: "#5fd8ff", transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.17;
      const count = 70;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      const motes = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: "#b8fbff", size: 0.09, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      const light = new THREE.PointLight("#6fe3ff", 6, 7, 2);
      light.position.y = 0.8;
      object.add(base, rune, pool, motes, light);
      Object.assign(l, { rune, pool, motes, light, count });
    }
    // Motes rise in a slow spiral; a launch makes everything flare for a moment.
    const launch = recent("spring", 0.6).at(-1);
    const flare = launch ? 1 - (time - launch.time) / 0.6 : 0;
    const positions = l.motes.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < l.count; i++) {
      const t = (i / l.count + time * (0.25 + flare)) % 1;
      const angle = i * 2.399 + time * 0.8;
      const radius = 0.65 * (1 - t * 0.5);
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 0.2 + t * 2.6;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    l.motes.geometry.attributes.position.needsUpdate = true;
    l.motes.material.opacity = 0.55 + 0.4 * flare;
    l.pool.material.opacity = 0.3 + 0.08 * Math.sin(time * 3) + 0.4 * flare;
    l.light.intensity = 3 + Math.sin(time * 3) + 12 * flare;
    l.rune.rotation.z = time * 0.6;
  },
} satisfies Script;
