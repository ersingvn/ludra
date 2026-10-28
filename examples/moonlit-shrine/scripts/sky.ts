import type { Script } from "@ludra/core";

/** A stable pseudo-random number per index, so the sky is the same every run. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A texture computed pixel by pixel: fn(u, v) gives [r, g, b, a] in 0..1, u and v in -1..1. */
function paint(THREE: any, size: number, fn: (u: number, v: number) => [number, number, number, number]): any {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rgba = fn((x / (size - 1)) * 2 - 1, (y / (size - 1)) * 2 - 1);
      rgba.forEach((value, c) => (data[(y * size + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, value)) * 255)));
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The moon's face: a pale disc, lit from the upper left, with soft maria and a few craters. */
function moonTexture(THREE: any): any {
  const craters = Array.from({ length: 24 }, (_, i) => {
    const a = hash(i + 40) * Math.PI * 2;
    const d = hash(i + 80) * 0.72;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.04 + hash(i) * (i < 5 ? 0.3 : 0.1), dark: i < 5 ? 0.16 : 0.22 };
  });
  const texture = paint(THREE, 256, (u, v) => {
    const r = Math.hypot(u, v);
    let shade = 1 - 0.18 * Math.hypot(u + 0.2, v + 0.25);
    for (const c of craters) {
      const d = Math.hypot(u - c.x, v - c.y) / c.r;
      if (d < 1) shade -= c.dark * (1 - d * d * 0.6);
    }
    const alpha = Math.min(1, Math.max(0, (1 - r) * 80));
    return [shade, shade * 0.97, shade * 0.9, alpha];
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft round glow for the moon's halo. */
function glowTexture(THREE: any): any {
  return paint(THREE, 128, (u, v) => {
    const r = Math.min(1, Math.hypot(u, v));
    const glow = Math.pow(1 - r, 2.2) * 0.45 + Math.pow(1 - r, 8) * 0.5;
    return [0.85, 0.89, 1, glow];
  });
}

const STAR_VERTEX = `
  attribute float seed;
  uniform float time;
  varying float vBright;
  varying vec3 vTint;
  void main() {
    vBright = 0.55 + 0.45 * sin(time * (0.8 + seed * 2.5) + seed * 40.0);
    vTint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.75), step(0.8, fract(seed * 7.0)));
    gl_PointSize = (1.2 + fract(seed * 13.0) * 2.4) * (0.7 + 0.5 * vBright);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const STAR_FRAGMENT = `
  varying float vBright;
  varying vec3 vTint;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vTint * (0.6 + vBright), a * vBright);
  }`;

/**
 * The night: twinkling stars, the moon with its halo, far mountains standing in the haze,
 * and the bloom that makes every lantern, shard and rune glow (params.bloom).
 * The sky follows the camera, so it is always at the horizon.
 */
export default {
  render({ THREE, object, local, camera, scene, renderer, view, time, params, addon, setRender }) {
    const l = local as Record<string, any>;
    if (!l.dome) {
      const dome = new THREE.Group();

      const count = 1600;
      const positions = new Float32Array(count * 3);
      const seeds = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        // Points on the upper part of a big sphere, thinning toward the horizon.
        const u = hash(i * 3 + 1) * Math.PI * 2;
        const v = Math.pow(hash(i * 3 + 2), 0.7) * 0.92 + 0.04;
        const r = 600;
        positions[i * 3] = Math.cos(u) * Math.sqrt(1 - v * v) * r;
        positions[i * 3 + 1] = v * r;
        positions[i * 3 + 2] = Math.sin(u) * Math.sqrt(1 - v * v) * r;
        seeds[i] = hash(i + 9000);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
      const stars = new THREE.Points(
        geometry,
        new THREE.ShaderMaterial({ uniforms: { time: { value: 0 } }, vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      stars.frustumCulled = false;

      // The moon rises low behind the shrine, at the end of the path.
      const direction = new THREE.Vector3(-0.2, 0.11, -1).normalize();
      const moon = new THREE.Mesh(new THREE.CircleGeometry(24, 64), new THREE.MeshBasicMaterial({ map: moonTexture(THREE), transparent: true, fog: false, depthWrite: false }));
      moon.position.copy(direction.clone().multiplyScalar(560));
      moon.lookAt(0, 0, 0);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
      halo.position.copy(direction.clone().multiplyScalar(580));
      halo.scale.set(300, 300, 1);

      // Low mountains on the horizon all around, darkest in front, hazier behind.
      const ridge = new THREE.Group();
      const rock = new THREE.MeshBasicMaterial({ color: "#14142e", fog: false });
      const far = new THREE.MeshBasicMaterial({ color: "#221f4a", fog: false });
      for (let i = 0; i < 60; i++) {
        const angle = (i / 60) * Math.PI * 2 + hash(i) * 0.08;
        const back = hash(i + 5) > 0.45;
        const radius = back ? 420 : 340;
        const height = 14 + hash(i + 17) * (back ? 34 : 20);
        const peak = new THREE.Mesh(new THREE.ConeGeometry(28 + hash(i + 23) * 34, height, 5), back ? far : rock);
        peak.position.set(Math.cos(angle) * radius, height / 2 - 14, Math.sin(angle) * radius);
        peak.rotation.y = hash(i + 31) * 3;
        peak.renderOrder = -1;
        ridge.add(peak);
      }

      dome.add(stars, halo, moon, ridge);
      scene.add(dome);
      Object.assign(l, { dome, stars });

      // Bloom: everything bright (moon, lanterns, shards, runes) spills a little light.
      void Promise.all([addon("postprocessing/EffectComposer.js"), addon("postprocessing/RenderPass.js"), addon("postprocessing/UnrealBloomPass.js"), addon("postprocessing/OutputPass.js")]).then(
        ([{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }]) => {
          const composer = new EffectComposer(renderer);
          composer.setSize(view.width, view.height);
          composer.addPass(new RenderPass(scene, camera));
          composer.addPass(new UnrealBloomPass(new THREE.Vector2(view.width, view.height), Number(params.bloom ?? 0.6), 0.5, 0.78));
          composer.addPass(new OutputPass());
          l.composer = composer;
          setRender(() => {
            // Follow the canvas if the window changes size.
            const { width, height } = renderer.domElement;
            if (l.width !== width || l.height !== height) {
              composer.setSize(width, height);
              l.width = width;
              l.height = height;
            }
            composer.render();
          });
        },
      );
    }
    l.dome.position.copy(camera.position);
    l.stars.material.uniforms.time.value = time;
  },
} satisfies Script;
