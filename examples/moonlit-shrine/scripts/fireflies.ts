import type { Script } from "@ludra/core";

function hash(n: number): number {
  const x = Math.sin(n * 43.17 + 7.31) * 43758.5453;
  return x - Math.floor(x);
}

const VERTEX = `
  attribute vec3 seed;
  uniform float time;
  varying float vGlow;
  void main() {
    // Each firefly wanders on its own slow loop and blinks on its own rhythm.
    vec3 p = position + vec3(
      sin(time * (0.3 + seed.x * 0.4) + seed.y * 30.0) * 1.2,
      sin(time * (0.5 + seed.y * 0.5) + seed.z * 20.0) * 0.6,
      cos(time * (0.25 + seed.z * 0.4) + seed.x * 25.0) * 1.2);
    vGlow = pow(0.5 + 0.5 * sin(time * (1.0 + seed.z * 2.0) + seed.x * 50.0), 3.0);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (0.4 + vGlow) * 70.0 / -view.z;
    gl_Position = projectionMatrix * view;
  }`;
const FRAGMENT = `
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(0.78, 1.0, 0.55) * (0.6 + vGlow * 1.4), a * (0.25 + vGlow * 0.75));
  }`;

/** Fireflies over the water along the route (params.count), drifting and blinking. */
export default {
  render({ THREE, object, local, time, params }) {
    const l = local as Record<string, any>;
    if (!l.points) {
      const count = Number(params.count ?? 120);
      const positions = new Float32Array(count * 3);
      const seeds = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (hash(i) - 0.5) * 26;
        positions[i * 3 + 1] = -2 + hash(i + 1) * 11;
        positions[i * 3 + 2] = (hash(i + 2) - 0.5) * 90;
        seeds[i * 3] = hash(i + 3);
        seeds[i * 3 + 1] = hash(i + 4);
        seeds[i * 3 + 2] = hash(i + 5);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));
      const points = new THREE.Points(
        geometry,
        new THREE.ShaderMaterial({ uniforms: { time: { value: 0 } }, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      points.frustumCulled = false;
      object.add(points);
      l.points = points;
    }
    l.points.material.uniforms.time.value = time;
  },
} satisfies Script;
