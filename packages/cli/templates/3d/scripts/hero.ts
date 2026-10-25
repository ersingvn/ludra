import type { Script } from "@ludra/core";

/**
 * The hero's face and scarf, added to its capsule: they turn with it (it faces where it
 * walks), the eyes blink, and the scarf streams back while it moves.
 */
export default {
  render({ THREE, object, local, self, time }) {
    if (!local.eyes) {
      const white = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.3 });
      const dark = new THREE.MeshStandardMaterial({ color: "#1c1830", roughness: 0.2 });
      const eyes = new THREE.Group();
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), white);
        eye.position.set(side * 0.13, 0.45, -0.25);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), dark);
        pupil.position.set(side * 0.13, 0.45, -0.33);
        eyes.add(eye, pupil);
      }
      const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.07, 8, 24), new THREE.MeshStandardMaterial({ color: "#ffd166", roughness: 0.7 }));
      scarf.rotation.x = Math.PI / 2;
      scarf.position.y = 0.15;
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.5), scarf.material);
      tail.position.set(0.12, 0.12, 0.45);
      tail.castShadow = true;
      object.add(eyes, scarf, tail);
      local.eyes = eyes;
      local.tail = tail;
    }
    // A blink every few seconds.
    const blink = time % 3.2 < 0.12 ? 0.15 : 1;
    (local.eyes as { scale: { y: number } }).scale.y = blink;
    // The scarf's tail lifts with speed.
    const speed = Math.hypot(self.vx, self.vz);
    (local.tail as { rotation: { x: number } }).rotation.x = -Math.min(0.9, speed * 0.15) + Math.sin(time * 9) * 0.06 * Math.min(1, speed);
  },
} satisfies Script;
