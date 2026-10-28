import type { Script } from "@ludra/core";

/**
 * A shard of the moon: a long faceted crystal of pale gold light with a soft halo and a few
 * motes circling it. The tweens on the entity turn it and make it bob.
 */
export default {
  render({ THREE, object, local, time, self }) {
    const l = local as Record<string, any>;
    if (!l.crystal) {
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32, 0),
        new THREE.MeshStandardMaterial({ color: "#fff4d6", emissive: "#ffd27a", emissiveIntensity: 2.4, roughness: 0.2, metalness: 0.1, flatShading: true }),
      );
      crystal.scale.set(0.8, 1.6, 0.8);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
      core.scale.set(0.8, 1.7, 0.8);

      // A soft warm glow, computed once into a small texture.
      const size = 64;
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const r = Math.min(1, Math.hypot((i % size) / (size - 1) - 0.5, Math.floor(i / size) / (size - 1) - 0.5) * 2);
        data.set([255, 222, 160, Math.round(Math.pow(1 - r, 2) * 200)], i * 4);
      }
      const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.set(1.8, 1.8, 1);

      const motes = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const mote = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: "#fff1c4" }));
        motes.add(mote);
      }
      const light = new THREE.PointLight("#ffc96b", 3, 4.5, 2);
      object.add(crystal, core, halo, motes, light);
      Object.assign(l, { halo, motes, light, phase: self.x * 1.3 + self.z * 0.7 });
    }
    const t = time + l.phase;
    l.halo.material.opacity = 0.7 + 0.3 * Math.sin(t * 2.2);
    l.light.intensity = 2.5 + Math.sin(t * 2.2);
    l.motes.children.forEach((mote: any, i: number) => {
      const a = t * (1.6 + i * 0.4) + (i * Math.PI * 2) / 3;
      mote.position.set(Math.cos(a) * 0.55, Math.sin(t * 1.3 + i) * 0.3, Math.sin(a) * 0.55);
    });
  },
} satisfies Script;
