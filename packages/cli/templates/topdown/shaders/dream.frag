// A soft, dreamy finish: bloom that makes the lights bleed, a cool-shadow and
// warm-highlight grade, and a vignette.
// The engine declares u_image, u_resolution, u_time and v_uv, plus every
// uniform listed under "postfx.uniforms" in the scene.

void main() {
  vec2 pixel = 1.0 / u_resolution;
  vec3 color = texture2D(u_image, v_uv).rgb;

  // Gaussian-weighted taps: far taps count less, so thin bright text doesn't leave a dotted grid.
  vec3 glow = vec3(0.0);
  float total = 0.0;
  for (int i = -5; i <= 5; i++) {
    for (int j = -5; j <= 5; j++) {
      float weight = exp(-float(i * i + j * j) / 12.0);
      vec2 offset = vec2(float(i), float(j)) * pixel * 2.0;
      glow += max(texture2D(u_image, v_uv + offset).rgb - 0.35, 0.0) * weight;
      total += weight;
    }
  }
  color += glow / total * bloom;

  // Shadows lean blue, highlights lean gold.
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color * vec3(0.9, 0.97, 1.12), color * vec3(1.08, 1.0, 0.88), smoothstep(0.2, 0.8, luma) * warmth);

  vec2 centered = v_uv - 0.5;
  color *= 1.0 - vignette * dot(centered, centered) * 1.6;

  gl_FragColor = vec4(color, 1.0);
}
