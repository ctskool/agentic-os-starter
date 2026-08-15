"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// ORB LAB — 10 "alive" behaviors for the dither sphere, one WebGL2 canvas.
// Single shader program, u_variant switches behavior; scissor renders each
// tile. Fake speech envelope (u_level) stands in for the phase-2 mic/TTS
// AnalyserNode. Mouse is live for the GAZE variant.
// Click a tile to isolate, Esc to return, keys 1–0.
// ---------------------------------------------------------------------------

const VERT = `#version 300 es
precision mediump float;
layout(location = 0) in vec4 a_position;
void main() { gl_Position = a_position; }
`;

const FRAG = `#version 300 es
precision highp float;

uniform float u_time;
uniform vec2 u_resolution;   // tile size in device px
uniform vec2 u_offset;       // tile origin in device px (gl_FragCoord space)
uniform vec4 u_colorBack;
uniform vec4 u_colorFront;
uniform float u_pxSize;
uniform int u_variant;
uniform float u_level;       // 0..1 speech envelope
uniform vec2 u_mouse;        // tile-normalized, center origin
uniform float u_seed;

out vec4 fragColor;

#define PI 3.14159265358979323846

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  float t = u_time + u_seed * 37.0;
  vec2 local = gl_FragCoord.xy - u_offset;

  // pixelize in tile space
  vec2 px = floor((local - 0.5 * u_resolution) / u_pxSize) * u_pxSize;
  float mn = min(u_resolution.x, u_resolution.y);
  vec2 p = px / mn * 2.2; // aspect-correct, sphere ~0.9 of min dim

  float lightT = 0.6 * t;
  vec3 lightPos = normalize(vec3(cos(lightT), 0.8, sin(lightT)));

  float m = 1.0;          // radius scale
  float bright = 1.0;     // shade multiplier
  float outside = 0.0;    // glow beyond the silhouette
  float ang = atan(p.y, p.x);
  vec2 angUv = vec2(cos(ang), sin(ang));

  if (u_variant == 1) {
    // BREATH — noise-modulated inhale/exhale
    float br = 0.5 + 0.5 * sin(t * 0.85 + snoise(vec2(t * 0.11, 3.7)) * 1.6);
    m = 1.0 + 0.055 * br;
    bright = 0.72 + 0.33 * br;

  } else if (u_variant == 2) {
    // TURBULENT — organic silhouette morph (elevenlabs-style)
    m = 1.0 + 0.10 * fbm(angUv * 1.4 + vec2(t * 0.35, -t * 0.22));
    bright = 0.85;

  } else if (u_variant == 3) {
    // PULSE — heartbeat lub-dub + expanding ring
    float ph = fract(t / 1.9);
    float pulse = exp(-60.0 * pow(ph - 0.10, 2.0)) + 0.6 * exp(-60.0 * pow(ph - 0.28, 2.0));
    m = 1.0 + 0.06 * pulse;
    bright = 0.7 + 0.5 * pulse;
    float l = length(p);
    float ringR = mix(1.0, 1.9, ph);
    outside = exp(-pow((l - ringR) * 10.0, 2.0)) * max(0.0, 1.0 - ph * 1.1) * 0.45;

  } else if (u_variant == 4) {
    // WAVEFORM — speech-reactive equator swell + ripples
    m = 1.0 + 0.13 * u_level * exp(-6.0 * p.y * p.y);
    bright = 0.6 + 0.55 * u_level;

  } else if (u_variant == 5) {
    // SCAN — sweep band climbs the sphere
    bright = 0.6;

  } else if (u_variant == 6) {
    // BINARY — two orbiting lights
    bright = 1.0;

  } else if (u_variant == 7) {
    // ERODE — dissolves to dust, re-condenses
    float vis = 0.5 + 0.5 * sin(t * 0.45 + snoise(vec2(t * 0.07, 8.2)) * 1.8);
    bright = 0.12 + 0.95 * vis;
    m = 1.0 + 0.05 * (1.0 - vis);

  } else if (u_variant == 8) {
    // CONTOUR — rotating topographic light bands
    bright = 1.0;

  } else if (u_variant == 9) {
    // CORONA — rim flares licking outward
    bright = 0.8;
    float l = length(p);
    float flare = fbm(angUv * 2.3 + vec2(t * 0.5, -t * 0.3));
    outside = max(0.0, flare - 0.05) * exp(-max(l - 1.0, 0.0) * 5.0) * step(1.0, l) * 0.9;

  } else if (u_variant == 10) {
    // GAZE — light follows cursor, occasional blink
    lightPos = normalize(vec3(u_mouse.x * 1.6, -u_mouse.y * 1.6 + 0.15, 0.75));
    float bl = exp(-pow(fract(t / 4.3) - 0.5, 2.0) * 900.0);
    p.y /= max(1.0 - 0.88 * bl, 0.12);
  }

  vec2 sp = p / m;
  float d = 1.0 - dot(sp, sp);
  float shape = 0.0;

  if (d > 0.0) {
    vec3 n = vec3(sp, sqrt(d));

    if (u_variant == 6) {
      vec3 l1 = normalize(vec3(cos(t * 1.1), 0.55, sin(t * 1.1)));
      vec3 l2 = normalize(vec3(cos(t * 1.1 + PI), -0.4, sin(t * 1.1 + PI)));
      shape = 0.62 * max(dot(l1, n), 0.0) + 0.62 * max(dot(l2, n), 0.0);
    } else {
      shape = 0.5 + 0.5 * dot(lightPos, n);
    }

    if (u_variant == 4) {
      // ripple rings riding the speech level
      shape += 0.18 * u_level * sin(14.0 * length(sp) - t * 7.0);
    }
    if (u_variant == 5) {
      float band = mix(-1.15, 1.15, fract(t * 0.22));
      shape = shape * 0.55 + exp(-pow((sp.y - band) * 8.0, 2.0)) * 0.75;
    }
    if (u_variant == 8) {
      float bands = fract(shape * 6.0 - t * 0.35);
      shape = shape * 0.5 + step(0.5, bands) * 0.35;
    }

    shape *= bright;
  } else {
    shape = outside;
  }

  // living grain — dither pattern re-rolls ~10fps
  vec2 noiseUv = px + floor(t * 10.0) * 13.7;
  float dither = step(hash21(noiseUv), shape) - 0.5;
  float res = step(0.5, shape + dither);

  vec3 fg = u_colorFront.rgb * u_colorFront.a;
  vec3 bg = u_colorBack.rgb * u_colorBack.a;
  vec3 color = fg * res + bg * (1.0 - u_colorFront.a * res);
  fragColor = vec4(color, 1.0);
}
`;

interface OrbVariant {
  name: string;
  blurb: string;
}

const VARIANTS: OrbVariant[] = [
  { name: "BREATH", blurb: "noise-timed inhale / exhale" },
  { name: "TURBULENT", blurb: "organic silhouette morph" },
  { name: "PULSE", blurb: "heartbeat thump + ring (runner heartbeat)" },
  { name: "WAVEFORM", blurb: "speech-reactive swell (mic / tts)" },
  { name: "SCAN", blurb: "sweep band climbing" },
  { name: "BINARY", blurb: "two orbiting lights" },
  { name: "ERODE", blurb: "dissolves to dust, re-condenses" },
  { name: "CONTOUR", blurb: "rotating topo light bands" },
  { name: "CORONA", blurb: "rim flares licking out" },
  { name: "GAZE", blurb: "follows your cursor · blinks" },
];

const EMBER: [number, number, number, number] = [0xd9 / 255, 0x77 / 255, 0x57 / 255, 1];
const BACK: [number, number, number, number] = [0x0b / 255, 0x08 / 255, 0x07 / 255, 1];

export default function OrbLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [solo, setSolo] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSolo(null);
      const n = parseInt(e.key, 10);
      if (!isNaN(n)) {
        const idx = n === 0 ? 9 : n - 1;
        if (idx >= 0 && idx < VARIANTS.length) setSolo(idx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      console.error("WebGL2 not supported");
      return;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);

    const U = (n: string) => gl.getUniformLocation(program, n);
    const loc = {
      time: U("u_time"),
      res: U("u_resolution"),
      off: U("u_offset"),
      back: U("u_colorBack"),
      front: U("u_colorFront"),
      px: U("u_pxSize"),
      variant: U("u_variant"),
      level: U("u_level"),
      mouse: U("u_mouse"),
      seed: U("u_seed"),
    };
    gl.uniform4fv(loc.back, BACK);
    gl.uniform4fv(loc.front, EMBER);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    fit();
    window.addEventListener("resize", fit);

    const mouse = { x: 0, y: 0 };
    const onMouse = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    window.addEventListener("mousemove", onMouse);

    gl.enable(gl.SCISSOR_TEST);

    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) * 0.001;

      // fake speech envelope — bursts of syllables, then silence
      const gate = Math.sin(t * 0.4) > -0.25 ? 1 : 0;
      const level = gate * Math.max(0, (0.45 + 0.55 * Math.sin(t * 6.1)) * (0.4 + 0.6 * Math.sin(t * 2.3)));

      gl.uniform1f(loc.time, t);
      gl.uniform1f(loc.level, level);

      tileRefs.current.forEach((el, i) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const x = Math.round(rect.left * dpr);
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        const y = canvas.height - Math.round(rect.bottom * dpr);

        gl.viewport(x, y, w, h);
        gl.scissor(x, y, w, h);
        gl.uniform2f(loc.res, w, h);
        gl.uniform2f(loc.off, x, y);
        gl.uniform1f(loc.px, 2 * dpr);
        gl.uniform1i(loc.variant, i + 1);
        gl.uniform1f(loc.seed, i * 0.137);
        // mouse in tile space, center origin, -1..1 by min dim
        const mn = Math.min(rect.width, rect.height);
        gl.uniform2f(
          loc.mouse,
          (mouse.x - rect.left - rect.width / 2) / mn,
          (mouse.y - rect.top - rect.height / 2) / mn
        );
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
      window.removeEventListener("mousemove", onMouse);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <main className="lab">
      <canvas ref={canvasRef} className="lab-canvas" />
      <header className="lab-head">
        <span className="lab-title">ORB LAB</span>
        <span className="lab-sub">
          dither sphere · 10 ways to feel alive · click to isolate · esc back · keys 1–0
        </span>
      </header>
      <div className="lab-grid">
        {VARIANTS.map((v, i) => (
          <div
            key={v.name}
            ref={(el) => {
              tileRefs.current[i] = el;
            }}
            className={`lab-tile ${solo === i ? "is-solo" : ""} ${
              solo !== null && solo !== i ? "is-hidden" : ""
            }`}
            onClick={() => setSolo(solo === i ? null : i)}
          >
            <div className="lab-label">
              <span className="idx">{String(i + 1).padStart(2, "0")}</span>
              <span className="nm">{v.name}</span>
              <span className="bl">{v.blurb}</span>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
