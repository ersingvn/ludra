import type { Script } from "@ludra/core";

/**
 * The checkpoint beacon: a stone post with a crystal on top that stays dim until the
 * player reaches it, then lights up with a warm point light and a slow pulse.
 */
export default {
  render({ THREE, object, local, recent, self, time }) {
    if (!local.lamp) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.6, 10), new THREE.MeshStandardMaterial({ color: "#8a7f74", roughness: 0.9 }));
      post.position.y = -0.2;
      post.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshStandardMaterial({ color: "#ffd8a0", emissive: "#ff9a3c", emissiveIntensity: 0.1, roughness: 0.3 }));
      lamp.position.y = 0.85;
      const light = new THREE.PointLight("#ffb35c", 0, 9, 2);
      light.position.y = 0.85;
      object.add(post, lamp, light);
      local.lamp = lamp;
      local.light = light;
    }
    // Lit once the player has reached this checkpoint (the event names it).
    const lit = recent("checkpoint", 1e9).some((e) => (e.data as { checkpoint?: string } | undefined)?.checkpoint === self.id);
    const pulse = lit ? 1 + 0.15 * Math.sin(time * 3) : 0;
    const lamp = local.lamp as { material: { emissiveIntensity: number }; rotation: { y: number } };
    lamp.material.emissiveIntensity = lit ? 3 * pulse : 0.1;
    lamp.rotation.y = time * (lit ? 1.5 : 0.3);
    (local.light as { intensity: number }).intensity = lit ? 14 * pulse : 0;
  },
} satisfies Script;
