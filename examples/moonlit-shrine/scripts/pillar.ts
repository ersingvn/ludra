import type { Script } from "@ludra/core";

/**
 * A rising pillar: carved bands of light around the shaft that brighten while it climbs
 * and dim as it sinks, so the player can read its rhythm from afar. A cap of paving on top.
 */
export default {
  render({ THREE, object, local, self, time }) {
    const l = local as Record<string, any>;
    if (!l.bands) {
      const r = self.width / 2;
      const top = self.height / 2;
      const bands: any[] = [];
      for (let i = 0; i < 4; i++) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.04, 6, 40), new THREE.MeshBasicMaterial({ color: "#7fe8ff" }));
        band.rotation.x = Math.PI / 2;
        band.position.y = top - 0.35 - i * 0.9;
        bands.push(band);
        object.add(band);
      }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.12, r + 0.05, 0.2, 10), new THREE.MeshStandardMaterial({ color: "#8a96aa", roughness: 0.9, flatShading: true }));
      cap.position.y = top - 0.08;
      cap.receiveShadow = true;
      cap.castShadow = true;
      // A rune disc set into the top, the same light as the bands.
      const disc = new THREE.Mesh(new THREE.RingGeometry(r * 0.35, r * 0.45, 6), new THREE.MeshBasicMaterial({ color: "#7fe8ff", side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = top + 0.03;
      object.add(cap, disc);
      Object.assign(l, { bands, disc });
    }
    // Rising: bright and cyan. Sinking: dim and violet.
    const rise = Math.max(-1, Math.min(1, self.vy / 2.5));
    const glow = 0.45 + 0.4 * rise;
    l.bands.forEach((band: any, i: number) => {
      const ripple = 0.85 + 0.15 * Math.sin(time * 4 - i * 0.9);
      band.material.color.setRGB((0.55 - 0.25 * rise) * glow * ripple, (0.65 + 0.3 * rise) * glow * ripple + 0.1, glow * ripple + 0.2);
    });
    l.disc.material.color.copy(l.bands[0].material.color);
    l.disc.rotation.z = time * 0.5;
  },
} satisfies Script;
