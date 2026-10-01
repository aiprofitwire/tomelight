/**
 * Welcome screen light: a volumetric beam rising from the Tomelight mark,
 * with god rays, drifting dust, a mouse-following spotlight and film grain.
 * Plain WebGL1, one full-screen shader. Pauses whenever it isn't visible.
 */
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uOrigin;
uniform vec3 uBg;
uniform vec3 uA;
uniform vec3 uB;
uniform float uIntro;
uniform float uDark;
uniform float uHover;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

void main(){
  vec2 px = gl_FragCoord.xy;
  float S = uRes.y;
  vec2 o = vec2(uOrigin.x, uRes.y - uOrigin.y);
  vec2 m = vec2(uMouse.x, uRes.y - uMouse.y);
  vec2 d = (px - o) / S;

  // the beam leans gently toward the cursor
  float tilt = clamp((m.x - o.x) / uRes.x, -0.6, 0.6) * 0.42;
  float up = d.y;
  float h = max(up, 0.0);
  float x = d.x - tilt * h;

  float grow = smoothstep(uIntro * 1.35 + 0.02, uIntro * 1.35 - 0.3, h);
  float above = smoothstep(-0.004, 0.02, up);

  float width = 0.010 + h * 0.30;
  float beam = exp(-pow(x / width, 2.0)) * above * exp(-h * 1.05);
  float core = exp(-pow(x / (0.0022 + h * 0.018), 2.0)) * above * exp(-h * 2.4);

  // god rays: slow striations inside a wider cone
  float ang = atan(x, h + 0.06);
  float rays = smoothstep(0.38, 0.95, fbm(vec2(ang * 10.0, uTime * 0.10 + h * 0.6)));
  float cone = exp(-pow(ang / 0.62, 2.0)) * above * exp(-h * 0.75);

  // bloom where the light leaves the book
  float bloom = exp(-length(d * vec2(1.0, 1.5)) * 10.0);
  float halo = exp(-length(d * vec2(1.0, 1.2)) * 3.2);

  // dust motes drifting up through the light
  vec2 g = vec2(x * 30.0, (up - uTime * 0.022) * 30.0);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float rnd = hash(cell);
  vec2 jitter = (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.7;
  float mote = smoothstep(0.075, 0.0, length(f - jitter)) * step(0.84, rnd);
  mote *= (0.55 + 0.45 * sin(uTime * 1.7 + rnd * 40.0)) * exp(-pow(x / (width * 1.4), 2.0)) * above * exp(-h * 1.3);

  // background: deep base, soft vignette, slow living tint
  vec2 uv = px / uRes;
  vec3 col = uBg;
  float vig = smoothstep(1.3, 0.15, length((uv - vec2(0.5, 0.42)) * vec2(1.25, 1.0)));
  col *= mix(0.62, 1.0, vig);
  float n = fbm(uv * 2.0 + vec2(uTime * 0.018, -uTime * 0.012));
  col += (uA * 0.05 + uB * 0.06 * n) * vig * uDark;

  // cursor spotlight revealing a fine dot grid
  float md = length((px - m) / S);
  float spot = exp(-md * md * 16.0);
  vec2 gp = fract(px / 24.0) - 0.5;
  float dots = smoothstep(0.075, 0.0, length(gp));
  col += uA * dots * spot * (0.20 + uDark * 0.1);
  col += uA * spot * 0.02;

  vec3 white = vec3(1.0);
  vec3 light = uA * (beam * 0.62 + rays * cone * 0.30 + halo * 0.10)
             + mix(uA, white, 0.65) * (core * 0.95 + bloom * 0.45 * (1.0 + uHover * 0.6))
             + white * mote * 0.9;
  light *= grow * uIntro;
  if (uDark > 0.5) col += light;
  else col = mix(col, col * 0.9 + uA * 0.28, clamp(light, 0.0, 1.0) * 0.8);

  col += (hash(px + fract(uTime) * 91.7) - 0.5) * 0.016; // film grain
  gl_FragColor = vec4(col, 1.0);
}`;
const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

function toRgb(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = css;
  const hex = c.fillStyle;
  if (hex.startsWith('#')) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const m = hex.match(/[\d.]+/g) || [0, 0, 0];
  return m.slice(0, 3).map((v) => Number(v) / 255);
}

export function initWelcomeGL(canvas, { getOrigin, isActive }) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); } return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  ['uRes', 'uTime', 'uMouse', 'uOrigin', 'uBg', 'uA', 'uB', 'uIntro', 'uDark', 'uHover'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scale = 0.75; // render a touch below native resolution: the light is soft anyway
  let colors = null;
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  let intro = 0; let introTarget = 1; let introStart = 0; let hover = 0; let hoverT = 0;
  let raf = 0; let t0 = performance.now(); let running = false;

  const readColors = () => {
    const cs = getComputedStyle(document.body);
    colors = {
      bg: toRgb(cs.getPropertyValue('--bg').trim()),
      a: toRgb(cs.getPropertyValue('--accent').trim()),
      b: toRgb(cs.getPropertyValue('--accent-2').trim()),
      dark: document.body.classList.contains('theme-parchment') ? 0 : 1,
    };
  };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * scale));
    canvas.height = Math.max(1, Math.round(r.height * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  window.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.tx = (e.clientX - r.left) * scale;
    mouse.ty = (e.clientY - r.top) * scale;
    if (mouse.x < -999) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
  }, { passive: true });

  const frame = (now) => {
    raf = 0;
    if (!isActive() || document.hidden) { running = false; return; }
    if (!colors) readColors();
    const r = canvas.getBoundingClientRect();
    if (Math.abs(canvas.width - Math.round(r.width * scale)) > 1 || Math.abs(canvas.height - Math.round(r.height * scale)) > 1) resize();
    const t = (now - t0) / 1000;
    // ease the intro and the mouse
    const k = Math.min(1, (now - introStart) / (introTarget === 1 ? 1900 : 350));
    intro = introTarget === 1 ? 1 - Math.pow(1 - k, 3) : intro;
    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;
    hover += (hoverT - hover) * 0.08;
    const o = getOrigin();
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, reduce ? 12 : t);
    gl.uniform2f(U.uMouse, mouse.x < -999 ? canvas.width / 2 : mouse.x, mouse.y < -999 ? canvas.height * 0.2 : mouse.y);
    gl.uniform2f(U.uOrigin, (o.x - r.left) * scale, (o.y - r.top) * scale);
    gl.uniform3fv(U.uBg, colors.bg);
    gl.uniform3fv(U.uA, colors.a);
    gl.uniform3fv(U.uB, colors.b);
    gl.uniform1f(U.uIntro, intro);
    gl.uniform1f(U.uDark, colors.dark);
    gl.uniform1f(U.uHover, hover);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (reduce && k >= 1) { running = false; return; }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (running) return; running = true; resize(); raf = requestAnimationFrame(frame); };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  return {
    /** Play the ignition intro (first time) or a quick fade-in (afterwards). */
    play(first) { introTarget = 1; introStart = performance.now() - (first ? 0 : 1500); intro = first ? 0 : 0.6; start(); },
    refreshColors() { readColors(); },
    setHover(v) { hoverT = v ? 1 : 0; },
    start,
  };
}
