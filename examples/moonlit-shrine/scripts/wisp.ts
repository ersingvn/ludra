import type { Script } from "@ludra/core";

const FLAME_VERTEX = `
  attribute float seed;
  uniform float time;
  varying float vLife;
  void main() {
    float life = fract(seed * 7.13 + time * (0.9 + seed * 0.6));
    vLife = life;
    float angle = seed * 40.0 + time * 2.0;
    float spread = 0.32 * (1.0 - life);
    vec3 p = vec3(cos(angle) * spread, -0.25 + life * 1.15, sin(angle) * spread);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (1.0 - life) * 140.0 / -view.z;
    gl_Position = projectionMatrix * view;
  }`;
const FLAME_FRAGMENT = `
  uniform vec3 hot;
  uniform vec3 cool;
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * (1.0 - vLife);
    gl_FragColor = vec4(mix(hot, cool, vLife), a);
  }`;

/**
 * The bridge's guardian: a ghostly violet flame with two pale eyes that watch the player.
 * Its hazard and patrol are components; this only draws it.
 */
export default {
  render({ THREE, object, local, time, world, self }) {
    const l = local as Record<string, any>;
    if (!l.flame) {
      const count = 90;
      const seeds = new Float32Array(count);
      for (let i = 0; i < count; i++) seeds[i] = i / count;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
      const flame = new THREE.Points(
        geometry,
        new THREE.ShaderMaterial({
          uniforms: { time: { value: 0 }, hot: { value: new THREE.Color("#f2c8ff") }, cool: { value: new THREE.Color("#6a2cff") } },
          vertexShader: FLAME_VERTEX,
          fragmentShader: FLAME_FRAGMENT,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      flame.frustumCulled = false;
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), new THREE.MeshBasicMaterial({ color: "#d9a6ff", transparent: true, opacity: 0.85 }));
      const face = new THREE.Group();
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
        eye.scale.set(1, 1.6, 0.6);
        eye.position.set(side * 0.11, 0.05, 0.27);
        face.add(eye);
      }
      const light = new THREE.PointLight("#a35cff", 8, 7, 1.8);
      object.add(flame, core, face, light);
      Object.assign(l, { flame, core, face, light });
    }
    l.flame.material.uniforms.time.value = time;
    const flicker = 0.85 + 0.15 * Math.sin(time * 11) * Math.sin(time * 7.3);
    l.light.intensity = 8 * flicker;
    l.core.scale.setScalar(0.9 + 0.12 * Math.sin(time * 6));
    // The eyes turn toward the player.
    const player = world.player();
    if (player) l.face.rotation.y = Math.atan2(player.x - self.x, player.z - self.z);
    l.face.position.y = Math.sin(time * 3) * 0.05;
  },
} satisfies Script;
