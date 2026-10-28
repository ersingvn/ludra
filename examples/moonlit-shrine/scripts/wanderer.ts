import type { Script } from "@ludra/core";

/**
 * The wanderer: a small hooded figure in an indigo cloak with glowing eyes, a red scarf and a
 * lantern held out in front, the warmest light in the night. Built around the player's
 * capsule (centre at 0, feet at -0.9, facing -z): it bobs as it walks, leans into its stride,
 * stretches on a jump and squashes on landing.
 */
export default {
  render({ THREE, object, local, self, time, recent }) {
    const l = local as Record<string, any>;
    if (!l.body) {
      const body = new THREE.Group();
      const cloth = new THREE.MeshStandardMaterial({ color: "#4a56a8", emissive: "#141a44", roughness: 0.85, flatShading: true });
      const lining = new THREE.MeshStandardMaterial({ color: "#11122a", roughness: 1 });
      const add = (mesh: any, x: number, y: number, z: number) => {
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        body.add(mesh);
        return mesh;
      };
      add(new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.3, 9, 1, true), cloth), 0, -0.25, 0);
      add(new THREE.Mesh(new THREE.CircleGeometry(0.44, 9), lining), 0, -0.9, 0).rotation.x = Math.PI / 2;
      add(new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), lining), 0, 0.52, 0);
      // The hood: an open shell around the head with a tip that falls back.
      const hood = add(new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 12, Math.PI * 1.2, Math.PI * 1.6), cloth), 0, 0.55, 0.02);
      hood.material = cloth.clone();
      hood.material.side = THREE.DoubleSide;
      add(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.4, 7), cloth), 0, 0.72, 0.3).rotation.x = 1.1;
      const eyes = new THREE.Group();
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: "#fff3c4" }));
        eye.scale.set(1, 1.4, 0.5);
        eye.position.set(side * 0.09, 0.53, -0.23);
        eyes.add(eye);
      }
      body.add(eyes);
      const red = new THREE.MeshStandardMaterial({ color: "#e0563a", roughness: 0.7 });
      const scarf = add(new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.07, 8, 20), red), 0, 0.3, 0);
      scarf.rotation.x = Math.PI / 2;
      const tail = new THREE.Group();
      tail.position.set(0.1, 0.3, 0.2);
      const cloth1 = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.42), red);
      cloth1.position.z = 0.2;
      cloth1.castShadow = true;
      tail.add(cloth1);
      body.add(tail);

      // The lantern hangs from a short pole held out front and to the right.
      const arm = new THREE.Group();
      arm.position.set(0.3, 0.05, -0.2);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 5), new THREE.MeshStandardMaterial({ color: "#5a3d2b" }));
      pole.rotation.x = Math.PI / 2.6;
      pole.position.set(0, 0.05, -0.18);
      const hang = new THREE.Group();
      hang.position.set(0, 0.12, -0.38);
      const box = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.18, 6), new THREE.MeshStandardMaterial({ color: "#fff1d0", emissive: "#ffa040", emissiveIntensity: 3 }));
      box.position.y = -0.17;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.08, 6), new THREE.MeshStandardMaterial({ color: "#3b2a22" }));
      cap.position.y = -0.05;
      const glow = new THREE.PointLight("#ffb060", 7, 9, 1.7);
      glow.position.y = -0.17;
      hang.add(box, cap, glow);
      arm.add(pole, hang);
      body.add(arm);

      object.add(body);
      Object.assign(l, { body, eyes, tail, hang, glow, box });
    }
    const speed = Math.hypot(self.vx, self.vz);
    const moving = Math.min(1, speed / 5);
    const airborne = !self.grounded;
    // Walk bob, a lean into the stride, and the stretch and squash of jumps and landings.
    const land = recent("land", 0.25).at(-1);
    const squash = land ? Math.sin(((time - land.time) / 0.25) * Math.PI) * 0.18 : 0;
    const stretch = airborne ? Math.max(-0.08, Math.min(0.12, self.vy * 0.02)) : 0;
    const body = l.body;
    body.position.y = airborne ? 0 : Math.abs(Math.sin(time * 11)) * 0.06 * moving;
    body.rotation.x = -0.18 * moving;
    body.scale.set(1 + squash * 0.6 - stretch * 0.4, 1 - squash + stretch, 1 + squash * 0.6 - stretch * 0.4);
    // The eyes blink now and then.
    l.eyes.scale.y = time % 3.7 < 0.1 ? 0.15 : 1;
    // The scarf streams back with speed and lifts when falling.
    l.tail.rotation.x = -0.25 * moving + (airborne ? 0.4 : 0) + Math.sin(time * 10) * 0.08 * moving;
    l.tail.rotation.y = Math.sin(time * 4) * 0.15;
    // The lantern swings on its pole, and its flame never quite holds still.
    l.hang.rotation.x = 0.3 * moving + Math.sin(time * 5.5) * 0.12 * (0.3 + moving) + (airborne ? -self.vy * 0.03 : 0);
    l.hang.rotation.z = Math.sin(time * 3.1) * 0.08;
    const flicker = 0.9 + 0.07 * Math.sin(time * 9.7) + 0.04 * Math.sin(time * 23.3);
    l.glow.intensity = 7 * flicker;
    l.box.material.emissiveIntensity = 3 * flicker;
  },
} satisfies Script;
