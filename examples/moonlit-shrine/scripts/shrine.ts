import type { Script } from "@ludra/core";

/**
 * The checkpoint: a vermilion gate standing over the bridge, with a spirit lantern hanging
 * from its beam. The lantern is cold and dark until the player passes under it, then it
 * catches a blue-white flame and keeps it.
 */
export default {
  render({ THREE, object, local, recent, self, time }) {
    const l = local as Record<string, any>;
    if (!l.lamp) {
      // The entity's centre is 1 m above the bridge.
      const ground = -1;
      const red = new THREE.MeshStandardMaterial({ color: "#c2412d", roughness: 0.55 });
      const black = new THREE.MeshStandardMaterial({ color: "#1c1a22", roughness: 0.6 });
      const piece = (geometry: any, material: any, x: number, y: number, z = 0, tilt = 0) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.rotation.z = tilt;
        mesh.castShadow = true;
        object.add(mesh);
        return mesh;
      };
      for (const side of [-1, 1]) {
        piece(new THREE.CylinderGeometry(0.13, 0.16, 3.5, 12), red, side * 1.32, ground + 1.75);
        piece(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12), black, side * 1.32, ground + 0.15);
        // The top beam's ends sweep upward.
        piece(new THREE.BoxGeometry(0.9, 0.2, 0.34), black, side * 2.05, ground + 3.72, 0, side * 0.18);
      }
      piece(new THREE.BoxGeometry(3.4, 0.2, 0.34), black, 0, ground + 3.62);
      piece(new THREE.BoxGeometry(3.6, 0.16, 0.3), red, 0, ground + 3.4);
      piece(new THREE.BoxGeometry(3.2, 0.16, 0.2), red, 0, ground + 2.7);
      piece(new THREE.BoxGeometry(0.16, 0.6, 0.22), red, 0, ground + 3.05);

      // The spirit lantern on a cord under the lower beam.
      const cord = piece(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4), black, 0, ground + 2.42);
      cord.castShadow = false;
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 16, 12),
        new THREE.MeshStandardMaterial({ color: "#e8eef8", emissive: "#8fe3ff", emissiveIntensity: 0, roughness: 0.6 }),
      );
      lamp.scale.y = 1.3;
      lamp.position.y = ground + 2.05;
      const light = new THREE.PointLight("#9fe6ff", 0, 10, 1.8);
      light.position.y = ground + 2;
      const count = 40;
      const sparks = new THREE.Points(
        new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3)),
        new THREE.PointsMaterial({ color: "#c8f6ff", size: 0.07, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      object.add(lamp, light, sparks);
      Object.assign(l, { lamp, light, sparks, count, ground });
    }
    const reached = recent("checkpoint", 1e9).find((e) => (e.data as { checkpoint?: string } | undefined)?.checkpoint === self.id);
    const since = reached ? time - reached.time : -1;
    const lit = since >= 0;
    // It flares as it catches, then settles into a slow breath.
    const flare = lit ? Math.max(0, 1 - since / 1.2) : 0;
    const breath = lit ? 1 + 0.12 * Math.sin(time * 2.5) : 0;
    l.lamp.material.emissiveIntensity = lit ? 1.6 * breath + 2 * flare : 0;
    l.light.intensity = lit ? 7 * breath + 14 * flare : 0;
    l.lamp.rotation.y = time * 0.4;
    l.lamp.position.x = Math.sin(time * 1.1) * 0.03;

    const positions = l.sparks.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < l.count; i++) {
      const k = (i / l.count + time * (0.2 + flare)) % 1;
      const a = i * 2.4 + time;
      const r = 0.2 + k * (0.6 + flare * 1.5);
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = l.ground + 2.05 + k * 1.2 - 0.3;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    l.sparks.geometry.attributes.position.needsUpdate = true;
    l.sparks.material.opacity = lit ? 0.35 + 0.65 * flare : 0;
  },
} satisfies Script;
