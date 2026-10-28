import type { Script } from "@ludra/core";

const VEIL_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// The veil inside the gate: a slow dark swirl while shards are missing, a rippling pool of
// moonlight once they are all back.
const VEIL_FRAGMENT = `
  uniform float time;
  uniform float open;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float swirl = sin(a * 3.0 + r * 9.0 - time * (0.8 + open * 2.2));
    float rings = sin(r * 26.0 - time * (1.0 + open * 3.0));
    vec3 shut = vec3(0.10, 0.07, 0.22) + vec3(0.12, 0.08, 0.25) * (0.5 + 0.5 * swirl);
    vec3 moon = vec3(0.78, 0.86, 1.0) + vec3(0.25, 0.2, 0.05) * (0.5 + 0.5 * rings) + vec3(0.3) * smoothstep(0.6, 0.0, r);
    vec3 color = mix(shut, moon * 1.6, open);
    float edge = smoothstep(1.0, 0.92, r);
    gl_FragColor = vec4(color, edge * mix(0.75, 0.95, open));
  }`;

/**
 * The moon gate on the sanctum: a stone ring on a plinth, with a socket for each shard
 * (params.need) that lights as shards are found. The veil inside opens when all are back.
 */
export default {
  render({ THREE, object, local, time, world, params, recent }) {
    const l = local as Record<string, any>;
    const need = Number(params.need ?? 6);
    if (!l.veil) {
      const stone = new THREE.MeshStandardMaterial({ color: "#a4adbd", roughness: 0.85, flatShading: true });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.3, 10, 48), stone);
      ring.castShadow = true;
      const lip = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.06, 6, 64), new THREE.MeshBasicMaterial({ color: "#7fe8ff" }));
      // The plinth and two steps up to it.
      const ground = -1.8;
      for (const [w, h, d, y] of [[5, 0.25, 2.4, ground + 0.125], [4, 0.25, 1.6, ground + 0.375]]) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
        step.position.y = y;
        step.receiveShadow = true;
        step.castShadow = true;
        object.add(step);
      }
      const veil = new THREE.Mesh(
        new THREE.CircleGeometry(1.48, 64),
        new THREE.ShaderMaterial({ uniforms: { time: { value: 0 }, open: { value: 0 } }, vertexShader: VEIL_VERTEX, fragmentShader: VEIL_FRAGMENT, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      // A socket per shard around the ring, from the bottom left over the top to the bottom right.
      const sockets: any[] = [];
      for (let i = 0; i < need; i++) {
        const angle = Math.PI * 1.25 - (i / (need - 1)) * Math.PI * 1.5;
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), new THREE.MeshStandardMaterial({ color: "#4b4f66", emissive: "#ffd27a", emissiveIntensity: 0, flatShading: true }));
        gem.position.set(Math.cos(angle) * 2.15, Math.sin(angle) * 2.15, 0);
        gem.scale.y = 1.5;
        gem.rotation.z = angle - Math.PI / 2;
        sockets.push(gem);
        object.add(gem);
      }
      const light = new THREE.PointLight("#bcd4ff", 0, 14, 1.6);
      light.position.z = 1;
      object.add(ring, lip, veil, light);
      Object.assign(l, { veil, sockets, light, lip });
    }
    const open = world.score >= need;
    // The veil eases open from the moment the last shard is found.
    const last = open ? recent("collect", 1e9).at(-1) : undefined;
    l.openness = last ? Math.min(1, (time - last.time) / 1.2) : 0;
    const won = recent("win", 1e9).at(-1);
    const burst = won ? Math.max(0, 1 - (time - won.time) / 1.5) : 0;
    l.veil.material.uniforms.time.value = time;
    l.veil.material.uniforms.open.value = Math.min(1, l.openness + burst);
    l.light.intensity = 2 + 10 * l.openness + 16 * burst;
    l.sockets.forEach((gem: any, i: number) => {
      const filled = i < world.score;
      gem.material.emissiveIntensity = filled ? 2.2 + 0.4 * Math.sin(time * 3 + i) : 0;
      gem.material.color.set(filled ? "#fff1c8" : "#4b4f66");
    });
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.5);
    l.lip.material.color.setRGB(0.3 + 0.5 * l.openness, 0.6 + 0.35 * l.openness + 0.1 * pulse, 1);
  },
} satisfies Script;
