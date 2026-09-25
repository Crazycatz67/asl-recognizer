// =============================================================================
// js/fluid.js — small GPU stable-fluids core (visual layer v2, B2 + later B3)
// =============================================================================
// WHAT: Jos Stam's "Stable Fluids" as in GPU Gems ch. 38, in hand-written
//   WebGL2 (no dependencies): advect -> curl/vorticity confinement ->
//   divergence -> 20 Jacobi pressure iterations -> gradient subtract, on
//   half-float ping-pong textures. Velocity lives on a coarse grid (128 on the
//   short side), dye on a finer one (256-512 — NOT the usual 1024: MediaPipe's
//   GPU delegate shares this GPU). No bloom/sunrays passes, no readPixels or
//   getError in the frame path.
//
// USED BY: js/hero.js (landing screen, stirred by the pointer and by tracked
//   fingertips). Reward ink-bloom (B3) is meant to reuse it at 1/4 res.
//
// PUBLIC API:
//   const fl = createFluid(canvas, { simRes = 128, dyeRes = 512, background });
//     -> null when WebGL2 or float render targets are unavailable
//   fl.splat(x, y, dx, dy, [r,g,b], radius?)  // x,y in 0..1 (y down); dx,dy
//                                           // velocity in sim units; rgb 0..1
//   fl.step(dt)          // seconds (clamped to 1/30)
//   fl.render()          // composite dye over `background` into the canvas
//   fl.resize()          // after the canvas's CSS size changes
//   fl.setResolution(simRes, dyeRes)
//   fl.dispose()

const VERT = `#version 300 es
precision highp float;
uniform vec2 texelSize;
out vec2 vUv, vL, vR, vT, vB;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision mediump float;
precision mediump sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
`;

const FRAG = {
  splat: `${HEAD}
uniform sampler2D uTarget;
uniform float aspectRatio, radius;
uniform vec3 color;
uniform vec2 point;
void main() {
  vec2 p = vUv - point; p.x *= aspectRatio;
  vec3 s = exp(-dot(p, p) / radius) * color;
  o = vec4(texture(uTarget, vUv).xyz + s, 1.0);
}`,
  advection: `${HEAD}
uniform sampler2D uVelocity, uSource;
uniform vec2 simTexel;
uniform float dt, dissipation;
void main() {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * simTexel;
  o = texture(uSource, coord) / (1.0 + dissipation * dt);
}`,
  divergence: `${HEAD}
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: `${HEAD}
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
  o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,
  vorticity: `${HEAD}
uniform sampler2D uVelocity, uCurl;
uniform float curl, dt;
void main() {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * dt;
  o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: `${HEAD}
uniform sampler2D uPressure, uDivergence;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  float d = texture(uDivergence, vUv).x;
  o = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}`,
  gradient: `${HEAD}
uniform sampler2D uPressure, uVelocity;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  o = vec4(v, 0.0, 1.0);
}`,
  clear: `${HEAD}
uniform sampler2D uTexture;
uniform float value;
void main() { o = value * texture(uTexture, vUv); }`,
  display: `${HEAD}
uniform sampler2D uTexture;
uniform vec3 bg;
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  c = 1.0 - exp(-c * 1.35);          // soft tone map: dye never clips to white
  o = vec4(bg + c * (1.0 - bg), 1.0);
}`,
};

export function createFluid(canvas, { simRes = 128, dyeRes = 512, background = [0.043, 0.059, 0.098] } = {}) {
  let gl;
  try {
    gl = canvas.getContext("webgl2", { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  } catch {}
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;

  const progs = {};
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  if (!vs) return null;
  for (const [name, src] of Object.entries(FRAG)) {
    const fs = compile(gl, gl.FRAGMENT_SHADER, src);
    if (!fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    progs[name] = { p, u };
  }
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.BLEND);

  const cfg = { velDiss: 0.25, dyeDiss: 0.9, pressure: 0.8, curl: 22, iters: 20 };
  let vel, dye, divergence, curlT, pressure;
  let simW, simH, dyeW, dyeH;

  function target(w, h, internal, format) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  function pair(w, h, internal, format) {
    let a = target(w, h, internal, format), b = target(w, h, internal, format);
    return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; }, all: () => [a, b] };
  }
  const freeT = (t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); };
  function freeAll() {
    if (!vel) return;
    [...vel.all(), ...dye.all(), ...pressure.all(), divergence, curlT].forEach(freeT);
    vel = null;
  }
  const res = (r) => {
    const a = canvas.clientWidth / Math.max(1, canvas.clientHeight) || 1;
    const long = Math.round(r * (a < 1 ? 1 / a : a));
    return a >= 1 ? [long, r] : [r, long];
  };
  function allocate() {
    freeAll();
    [simW, simH] = res(simRes);
    [dyeW, dyeH] = res(dyeRes);
    vel = pair(simW, simH, gl.RG16F, gl.RG);
    dye = pair(dyeW, dyeH, gl.RGBA16F, gl.RGBA);
    pressure = pair(simW, simH, gl.R16F, gl.RED);
    divergence = target(simW, simH, gl.R16F, gl.RED);
    curlT = target(simW, simH, gl.R16F, gl.RED);
  }

  let unit = 0;
  const bindTex = (t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); return unit++; };
  function use(name, texelW, texelH) {
    const pr = progs[name];
    gl.useProgram(pr.p);
    unit = 0;
    if (pr.u.texelSize) gl.uniform2f(pr.u.texelSize, 1 / texelW, 1 / texelH);
    return pr.u;
  }
  function blit(t) {
    if (t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * Math.min(1, window.devicePixelRatio || 1)));
    const h = Math.max(1, Math.round(canvas.clientHeight * Math.min(1, window.devicePixelRatio || 1)));
    if (canvas.width !== w || canvas.height !== h || !vel) {
      canvas.width = w;
      canvas.height = h;
      allocate();
    }
  }
  resize();

  return {
    get gl() { return gl; },
    splat(x, y, dx, dy, rgb, radius = 0.0025) {
      const ar = canvas.clientWidth / Math.max(1, canvas.clientHeight) || 1;
      const r = ar > 1 ? radius * ar : radius;
      let u = use("splat", simW, simH);
      gl.uniform1i(u.uTarget, bindTex(vel.read));
      gl.uniform1f(u.aspectRatio, ar);
      gl.uniform2f(u.point, x, 1 - y);
      gl.uniform3f(u.color, dx, -dy, 0);
      gl.uniform1f(u.radius, r);
      blit(vel.write); vel.swap();
      u = use("splat", dyeW, dyeH);
      gl.uniform1i(u.uTarget, bindTex(dye.read));
      gl.uniform1f(u.aspectRatio, ar);
      gl.uniform2f(u.point, x, 1 - y);
      gl.uniform3f(u.color, rgb[0], rgb[1], rgb[2]);
      gl.uniform1f(u.radius, r);
      blit(dye.write); dye.swap();
    },
    step(dt) {
      dt = Math.min(dt, 1 / 30);
      let u = use("curl", simW, simH);
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      blit(curlT);
      u = use("vorticity", simW, simH);
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      gl.uniform1i(u.uCurl, bindTex(curlT));
      gl.uniform1f(u.curl, cfg.curl);
      gl.uniform1f(u.dt, dt);
      blit(vel.write); vel.swap();
      u = use("divergence", simW, simH);
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      blit(divergence);
      u = use("clear", simW, simH);
      gl.uniform1i(u.uTexture, bindTex(pressure.read));
      gl.uniform1f(u.value, cfg.pressure);
      blit(pressure.write); pressure.swap();
      u = use("pressure", simW, simH);
      gl.uniform1i(u.uDivergence, bindTex(divergence));
      const pu = unit;
      for (let i = 0; i < cfg.iters; i++) {
        unit = pu;
        gl.uniform1i(u.uPressure, bindTex(pressure.read));
        blit(pressure.write); pressure.swap();
      }
      u = use("gradient", simW, simH);
      gl.uniform1i(u.uPressure, bindTex(pressure.read));
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      blit(vel.write); vel.swap();
      u = use("advection", simW, simH);
      gl.uniform2f(u.simTexel, 1 / simW, 1 / simH);
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      gl.uniform1i(u.uSource, bindTex(vel.read));
      gl.uniform1f(u.dt, dt);
      gl.uniform1f(u.dissipation, cfg.velDiss);
      blit(vel.write); vel.swap();
      u = use("advection", dyeW, dyeH);
      gl.uniform2f(u.simTexel, 1 / simW, 1 / simH);
      gl.uniform1i(u.uVelocity, bindTex(vel.read));
      gl.uniform1i(u.uSource, bindTex(dye.read));
      gl.uniform1f(u.dt, dt);
      gl.uniform1f(u.dissipation, cfg.dyeDiss);
      blit(dye.write); dye.swap();
    },
    render() {
      const u = use("display", gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1i(u.uTexture, bindTex(dye.read));
      gl.uniform3f(u.bg, background[0], background[1], background[2]);
      blit(null);
    },
    resize,
    setResolution(s, d) {
      if (s === simRes && d === dyeRes) return;
      simRes = s;
      dyeRes = d;
      allocate();
    },
    get resolution() { return { simW, simH, dyeW, dyeH }; },
    dispose() {
      freeAll();
      for (const { p } of Object.values(progs)) gl.deleteProgram(p);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("fluid shader:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}
