// Neon CRT: bloom on bright pixels, chromatic aberration toward the edges,
// scanlines, a slight tube curve and a vignette.
// The engine declares u_image, u_resolution, u_time and v_uv, plus every
// uniform listed under "postfx.uniforms" in the scene.

vec3 sampleAt(vec2 uv) {
  return texture2D(u_image, uv).rgb;
}

void main() {
  vec2 centered = v_uv - 0.5;
  vec2 uv = 0.5 + centered * (1.0 + curve * dot(centered, centered));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 pixel = 1.0 / u_resolution;
  vec2 shift = centered * aberration * pixel * 6.0;
  vec3 color = vec3(sampleAt(uv + shift).r, sampleAt(uv).g, sampleAt(uv - shift).b);

  // Bloom: a Gaussian-weighted average of the bright parts around this pixel.
  // Far taps count less, so thin bright text doesn't leave a dotted grid.
  vec3 glow = vec3(0.0);
  float total = 0.0;
  for (int i = -5; i <= 5; i++) {
    for (int j = -5; j <= 5; j++) {
      float weight = exp(-float(i * i + j * j) / 12.0);
      glow += max(sampleAt(uv + vec2(float(i), float(j)) * pixel * 2.0) - 0.5, 0.0) * weight;
      total += weight;
    }
  }
  color += glow / total * bloom;

  float line = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159);
  color *= 1.0 - scanlines * line * 0.35;
  color *= 1.0 - vignette * dot(centered, centered) * 1.8;
  // A barely visible flicker, like a tube.
  color *= 0.985 + 0.015 * sin(u_time * 50.0);

  gl_FragColor = vec4(color, 1.0);
}
