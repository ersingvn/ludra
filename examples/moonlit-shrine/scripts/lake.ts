import type { Script } from "@ludra/core";

function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return x - Math.floor(x);
}

const WATER_VERTEX = `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

// Still water: small waves bend the reflection of the night sky, the moon lays a path of
// glints across it, and the far water melts into the haze at the horizon.
const WATER_FRAGMENT = `
  uniform float time;
  uniform vec3 moonDir;
  uniform vec3 deep;
  uniform vec3 skyTop;
  uniform vec3 skyLow;
  uniform vec3 haze;
  uniform float hazeNear;
  uniform float hazeFar;
  varying vec3 vWorld;

  vec2 slope(vec2 p) {
    vec2 s = vec2(0.0);
    s += 0.050 * vec2(cos(p.x * 0.90 + time * 1.10), 0.0);
    s += 0.040 * vec2(0.0, cos(p.y * 1.30 - time * 0.90));
    s += 0.030 * cos(dot(p, vec2(1.7, 2.3)) + time * 1.7) * vec2(1.7, 2.3) * 0.5;
    s += 0.020 * cos(dot(p, vec2(-3.1, 1.9)) - time * 2.3) * vec2(-3.1, 1.9) * 0.5;
    s += 0.012 * cos(dot(p, vec2(5.3, -4.7)) + time * 3.1) * vec2(5.3, -4.7) * 0.5;
    return s;
  }

  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 v = toEye / dist;
    // Far away the small waves would only shimmer as noise: calm them with distance.
    vec2 s = slope(vWorld.xz) / (1.0 + dist * 0.04);
    vec3 n = normalize(vec3(-s.x, 1.0, -s.y));
    vec3 r = reflect(-v, n);
    vec3 sky = mix(skyLow, skyTop, pow(clamp(r.y, 0.0, 1.0), 0.6));
    float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    float moon = max(dot(r, moonDir), 0.0);
    vec3 glint = vec3(1.0, 0.95, 0.85) * (pow(moon, 2200.0) * 2.2 + pow(moon, 260.0) * 0.18);
    vec3 color = mix(deep, sky, fresnel) + glint;
    float fade = smoothstep(hazeNear, hazeFar, dist);
    gl_FragColor = vec4(mix(color, haze, fade), 1.0);
  }`;

/**
 * The lake under the shrine: a water shader reflecting the night (params.size metres wide),
 * with paper lanterns floating on it and lily pads drifting around them.
 */
export default {
  render({ THREE, object, local, time, params }) {
    const l = local as Record<string, any>;
    if (!l.water) {
      const size = Number(params.size ?? 400);
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size, 1, 1),
        new THREE.ShaderMaterial({
          uniforms: {
            time: { value: 0 },
            moonDir: { value: new THREE.Vector3(-0.2, 0.11, -1).normalize() },
            deep: { value: new THREE.Color("#060a1c") },
            skyTop: { value: new THREE.Color("#141a46") },
            skyLow: { value: new THREE.Color("#4a3a78") },
            haze: { value: new THREE.Color("#2a2350") },
            hazeNear: { value: 30 },
            hazeFar: { value: 300 },
          },
          vertexShader: WATER_VERTEX,
          fragmentShader: WATER_FRAGMENT,
        }),
      );
      water.rotation.x = -Math.PI / 2;
      object.add(water);

      // Paper lanterns floating on the water, each a small glowing box with a dark cap.
      const count = 34;
      const paper = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.42, 0.5, 0.42),
        new THREE.MeshStandardMaterial({ color: "#ffd9a0", emissive: "#ff9a40", emissiveIntensity: 2.2, roughness: 0.6 }),
        count,
      );
      const caps = new THREE.InstancedMesh(new THREE.ConeGeometry(0.36, 0.22, 4), new THREE.MeshStandardMaterial({ color: "#3a2a2a", roughness: 0.9 }), count);
      const pads = new THREE.InstancedMesh(
        new THREE.CircleGeometry(0.7, 12, 0.3, Math.PI * 1.8),
        new THREE.MeshStandardMaterial({ color: "#20402f", roughness: 0.9, side: THREE.DoubleSide }),
        count * 2,
      );
      paper.castShadow = caps.castShadow = false;
      object.add(paper, caps, pads);
      Object.assign(l, { water, paper, caps, pads, count, dummy: new THREE.Object3D() });
    }
    l.water.material.uniforms.time.value = time;

    const dummy = l.dummy;
    for (let i = 0; i < l.count; i++) {
      // Around the route (local z is relative to the lake's centre), drifting slowly and bobbing.
      const side = hash(i) > 0.5 ? 1 : -1;
      const x = side * (5 + hash(i + 1) * 26) + Math.sin(time * 0.07 + i) * 1.5;
      const z = (hash(i + 2) - 0.5) * 100 + Math.cos(time * 0.05 + i * 2) * 1.5;
      const bob = Math.sin(time * 1.3 + i * 1.7) * 0.05;
      dummy.position.set(x, 0.25 + bob, z);
      dummy.rotation.set(Math.sin(time + i) * 0.05, hash(i + 3) * 3, Math.cos(time * 1.2 + i) * 0.05);
      dummy.scale.setScalar(0.8 + hash(i + 4) * 0.5);
      dummy.updateMatrix();
      l.paper.setMatrixAt(i, dummy.matrix);
      dummy.position.y += 0.33 * dummy.scale.x;
      dummy.updateMatrix();
      l.caps.setMatrixAt(i, dummy.matrix);
      for (let p = 0; p < 2; p++) {
        dummy.position.set(x + (hash(i * 2 + p + 7) - 0.5) * 3, 0.02, z + (hash(i * 2 + p + 9) - 0.5) * 3);
        dummy.rotation.set(-Math.PI / 2, 0, hash(i * 2 + p) * 6 + time * 0.03);
        dummy.scale.setScalar(0.6 + hash(i * 2 + p + 11) * 0.8);
        dummy.updateMatrix();
        l.pads.setMatrixAt(i * 2 + p, dummy.matrix);
      }
    }
    l.paper.instanceMatrix.needsUpdate = true;
    l.caps.instanceMatrix.needsUpdate = true;
    l.pads.instanceMatrix.needsUpdate = true;
  },
} satisfies Script;
