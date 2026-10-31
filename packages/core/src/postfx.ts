import type { PostFxDef } from "./types.ts";

/** Declared by the engine for every postfx shader, so shaders only write `main`. */
const ENGINE_HEADER = `precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;
varying vec2 v_uv;
`;

const VERTEX_SHADER = `attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/**
 * Runs a scene's GLSL fragment shader over each rendered frame. The game draws
 * into an offscreen 2D canvas; this uploads it as a texture and draws it
 * through the shader onto a WebGL canvas.
 */
/** No WebGL on this machine: not the game's fault, and a finish a game can go without. */
export class NoWebGL extends Error {}

export class PostFx {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly uniforms: Array<{ location: WebGLUniformLocation | null; value: number }>;
  private readonly time: WebGLUniformLocation | null;

  /** Throws with the GLSL compiler's message if the shader doesn't compile. */
  constructor(width: number, height: number, source: string, def: PostFxDef) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    // preserveDrawingBuffer keeps the frame readable for screenshots.
    const gl = this.canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new NoWebGL("postfx needs WebGL, which this browser doesn't provide.");
    this.gl = gl;

    const custom = Object.keys(def.uniforms ?? {});
    // #line 1 makes compiler errors point at lines of the shader file itself.
    const header = ENGINE_HEADER + custom.map((name) => `uniform float ${name};\n`).join("") + "#line 1\n";
    this.program = link(gl, VERTEX_SHADER, header + stripDeclarations(source, ["u_image", "u_resolution", "u_time", "v_uv", ...custom]), def.shader);
    gl.useProgram(this.program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const [key, value] of [
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, key, value);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.uniform1i(gl.getUniformLocation(this.program, "u_image"), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_resolution"), width, height);
    this.time = gl.getUniformLocation(this.program, "u_time");
    this.uniforms = custom.map((name) => ({ location: gl.getUniformLocation(this.program, name), value: def.uniforms![name]! }));
  }

  /** Draws `source` (the frame the game just rendered) through the shader. */
  render(source: HTMLCanvasElement, time: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1f(this.time, time);
    for (const u of this.uniforms) gl.uniform1f(u.location, u.value);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/** Drops the shader's own declarations of names the engine already declares, so either style compiles. */
function stripDeclarations(source: string, names: string[]): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(uniform|varying)\b/.test(line) && names.some((name) => new RegExp(`\\b${name}\\b`).test(line)) ? "" : line))
    .join("\n");
}

function link(gl: WebGLRenderingContext, vertex: string, fragment: string, path: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex, "the engine's vertex shader"));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment, path));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${path} failed to link: ${gl.getProgramInfoLog(program)}`);
  return program;
}

function compile(gl: WebGLRenderingContext, type: number, source: string, path: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = String(gl.getShaderInfoLog(shader)).trim();
    throw new Error(`${path} failed to compile: ${log}`);
  }
  return shader;
}
