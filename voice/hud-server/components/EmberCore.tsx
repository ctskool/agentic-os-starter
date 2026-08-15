"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// EMBER CORE v5 — structured reactor.
// Four layers replace the old undifferentiated blob:
//   nucleus   white-hot dense particle heart (the energy source)
//   shell     particle sphere with rim-light falloff (the containment field)
//   ring      Kepler accretion disc — inner particles orbit faster (the motion)
//   skeleton  faint icosahedron wireframe (the machine inside)
// UnrealBloom does the glow for real; no baked halo sprites.
// Color = state. uAudio (0..1) live-wired for phase 2 TTS amplitude.
// ---------------------------------------------------------------------------

export type CoreMode = "idle" | "working" | "listening" | "speaking" | "error";

interface Palette {
  cold: string;
  hot: string;
  white: string;
  shimmer: number;
  agitation: number;
}

const PALETTES: Record<CoreMode, Palette> = {
  idle: { cold: "#5c1d0c", hot: "#e8703a", white: "#ffe3bd", shimmer: 0.14, agitation: 0 },
  working: { cold: "#8a3410", hot: "#ffb347", white: "#fff4e0", shimmer: 0.28, agitation: 0.55 },
  listening: { cold: "#0c2160", hot: "#4a6cfa", white: "#cfe0ff", shimmer: 0.2, agitation: 0.25 },
  speaking: { cold: "#6e430c", hot: "#ffc94a", white: "#fff2cc", shimmer: 0.45, agitation: 0.35 },
  error: { cold: "#5e0808", hot: "#ff4d3d", white: "#ffd9d4", shimmer: 0.06, agitation: 0.7 },
};

const SHELL_R = 1.42;
const NUCLEUS_R = 0.52;

// Ashima 3D simplex noise (public domain / MIT)
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// --- nucleus: dense white-hot heart -----------------------------------------

const NUCLEUS_VERT = /* glsl */ `
${SIMPLEX}
uniform float uTime;
uniform float uActivity;
uniform float uAudio;
attribute float aSeed;
varying float vHeat;
varying float vSeed;
void main() {
  float rr = length(position) / ${NUCLEUS_R.toFixed(2)};
  float t = uTime * (0.25 + uActivity * 0.6);
  float n = snoise(position * 4.0 + vec3(t, t * 0.7, -t * 0.4));
  vec3 p = position * (1.0 + n * 0.10 * (0.5 + uActivity));
  p *= 1.0 + uAudio * 0.30 * rr;
  vHeat = clamp(1.1 - rr, 0.0, 1.0);
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (1.1 + vHeat * 1.3 + uAudio * 1.4) * (62.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const NUCLEUS_FRAG = /* glsl */ `
uniform vec3 uHot;
uniform vec3 uWhite;
uniform float uTime;
varying float vHeat;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float alpha = smoothstep(0.5, 0.12, d);
  vec3 col = mix(uHot, uWhite, vHeat * vHeat);
  alpha *= 0.35 + 0.65 * fract(vSeed * 17.13 + uTime * 0.02);
  gl_FragColor = vec4(col, alpha * 0.55);
}
`;

// --- shell: containment sphere, rim-lit -------------------------------------

const SHELL_VERT = /* glsl */ `
${SIMPLEX}
uniform float uTime;
uniform float uActivity;
uniform float uAudio;
attribute float aSeed;
varying float vRim;
varying float vSeed;
varying float vBand;
void main() {
  vec3 nrm = normalize(position);
  float t = uTime * (0.1 + uActivity * 0.35);
  float n = snoise(nrm * 2.2 + vec3(t, t * 0.6, -t * 0.3));
  // breathe along the normal — silhouette holds, surface shimmers
  float r = ${SHELL_R.toFixed(2)} * (1.0 + n * 0.035 * (0.5 + uActivity) + uAudio * 0.08);
  vec3 p = nrm * r;
  // latitude bands give the sphere visible machine structure
  vBand = 0.55 + 0.45 * sin(nrm.y * 18.0 + n * 2.0);
  vec3 viewN = normalize(normalMatrix * nrm);
  vRim = 1.0 - abs(viewN.z); // 1 at silhouette edge, 0 facing camera
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.8 + vRim * 1.1 + step(0.93, fract(aSeed * 5.3)) * 1.3) * (64.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = /* glsl */ `
uniform vec3 uCold;
uniform vec3 uHot;
uniform float uTime;
uniform float uShimmer;
varying float vRim;
varying float vSeed;
varying float vBand;
vec3 spectral(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float alpha = smoothstep(0.45, 0.18, d);
  float rim = pow(vRim, 2.2);
  vec3 col = mix(uCold, uHot, rim);
  col += spectral(vSeed + uTime * 0.04) * uShimmer * rim * 0.4;
  alpha *= (0.12 + rim * 0.8) * vBand;
  alpha *= 0.4 + 0.6 * fract(vSeed * 13.7);
  gl_FragColor = vec4(col, alpha * 0.5);
}
`;

// --- ring: Kepler accretion disc ---------------------------------------------

const RING_VERT = /* glsl */ `
uniform float uTime;
uniform float uActivity;
attribute float aRadius;
attribute float aAngle;
attribute float aY;
attribute float aSeed;
varying float vInner;
varying float vSeed;
void main() {
  // Kepler shear: angular velocity ~ r^-1.5
  float w = 0.55 * pow(aRadius, -1.5) * (0.6 + uActivity * 0.9);
  float ang = aAngle + uTime * w;
  vec3 p = vec3(cos(ang) * aRadius, aY, sin(ang) * aRadius);
  vInner = 1.0 - smoothstep(1.7, 2.9, aRadius);
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.6 + vInner * 0.9 + fract(aSeed * 3.7) * 0.6) * (62.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uCold;
uniform vec3 uHot;
varying float vInner;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float alpha = smoothstep(0.5, 0.15, length(c));
  vec3 col = mix(uCold, uHot, vInner * vInner);
  alpha *= 0.25 + 0.75 * fract(vSeed * 11.31);
  alpha *= 0.18 + vInner * 0.5;
  gl_FragColor = vec4(col, alpha);
}
`;

// --- dust far field -----------------------------------------------------------

const DUST_VERT = /* glsl */ `
uniform float uTime;
attribute float aSeed;
varying float vA;
void main() {
  vec3 p = position;
  float t = uTime * 0.04;
  float ca = cos(t), sa = sin(t);
  p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);
  vA = 0.25 + 0.75 * fract(aSeed * 7.31);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.4 + fract(aSeed * 3.7) * 0.7) * (62.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float alpha = smoothstep(0.5, 0.1, length(c)) * vA * 0.12;
  gl_FragColor = vec4(uColor, alpha);
}
`;

// --- geometry builders ---------------------------------------------------------

function volumeCloud(n: number, radius: number, falloff: number): Float32Array {
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cosT = Math.random() * 2 - 1;
    const sinT = Math.sqrt(1 - cosT * cosT);
    const phi = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), falloff) * radius;
    pts[i * 3] = sinT * Math.cos(phi) * r;
    pts[i * 3 + 1] = cosT * r;
    pts[i * 3 + 2] = sinT * Math.sin(phi) * r;
  }
  return pts;
}

function sphereSurface(n: number, radius: number): Float32Array {
  // fibonacci sphere — even coverage, no pole clumping
  const pts = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    pts[i * 3] = Math.cos(theta) * r * radius;
    pts[i * 3 + 1] = y * radius;
    pts[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return pts;
}

function seeds(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.random();
  return s;
}

export default function EmberCore({
  activity = 0.15,
  mode = "idle",
  audioLevel = 0,
}: {
  activity?: number;
  mode?: CoreMode;
  audioLevel?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef(activity);
  const modeRef = useRef<CoreMode>(mode);
  const audioRef = useRef(audioLevel);
  activityRef.current = activity;
  modeRef.current = mode;
  audioRef.current = audioLevel;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0807");

    const camera = new THREE.PerspectiveCamera(
      42,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100
    );
    camera.position.set(0, 0.3, 5.4);

    const startPal = PALETTES[modeRef.current];
    const sharedUniforms = () => ({
      uTime: { value: 0 },
      uActivity: { value: activityRef.current },
      uAudio: { value: 0 },
      uShimmer: { value: startPal.shimmer },
      uCold: { value: new THREE.Color(startPal.cold) },
      uHot: { value: new THREE.Color(startPal.hot) },
      uWhite: { value: new THREE.Color(startPal.white) },
    });

    const pointsMat = (vert: string, frag: string) =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: sharedUniforms(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

    // nucleus
    const NN = 3200;
    const nucleusGeo = new THREE.BufferGeometry();
    nucleusGeo.setAttribute("position", new THREE.BufferAttribute(volumeCloud(NN, NUCLEUS_R, 0.65), 3));
    nucleusGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(NN), 1));
    const nucleusMat = pointsMat(NUCLEUS_VERT, NUCLEUS_FRAG);
    scene.add(new THREE.Points(nucleusGeo, nucleusMat));

    // shell
    const SN = 4200;
    const shellGeo = new THREE.BufferGeometry();
    shellGeo.setAttribute("position", new THREE.BufferAttribute(sphereSurface(SN, SHELL_R), 3));
    shellGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(SN), 1));
    const shellMat = pointsMat(SHELL_VERT, SHELL_FRAG);
    const shell = new THREE.Points(shellGeo, shellMat);
    scene.add(shell);

    // accretion ring — tilted group, Kepler shear in the shader
    const RN = 3600;
    const ringGeo = new THREE.BufferGeometry();
    const ringPos = new Float32Array(RN * 3); // placeholder; shader computes from attrs
    const aRadius = new Float32Array(RN);
    const aAngle = new Float32Array(RN);
    const aY = new Float32Array(RN);
    for (let i = 0; i < RN; i++) {
      // density falls off outward; slight gap behind the shell
      const u = Math.random();
      aRadius[i] = 1.75 + Math.pow(u, 1.6) * 1.25;
      aAngle[i] = Math.random() * Math.PI * 2;
      // gaussian-ish thinness
      aY[i] = (Math.random() + Math.random() + Math.random() - 1.5) * 0.045;
      ringPos[i * 3] = Math.cos(aAngle[i]) * aRadius[i];
      ringPos[i * 3 + 1] = aY[i];
      ringPos[i * 3 + 2] = Math.sin(aAngle[i]) * aRadius[i];
    }
    ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPos, 3));
    ringGeo.setAttribute("aRadius", new THREE.BufferAttribute(aRadius, 1));
    ringGeo.setAttribute("aAngle", new THREE.BufferAttribute(aAngle, 1));
    ringGeo.setAttribute("aY", new THREE.BufferAttribute(aY, 1));
    ringGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(RN), 1));
    ringGeo.computeBoundingSphere();
    const ringMat = pointsMat(RING_VERT, RING_FRAG);
    const ringGroup = new THREE.Group();
    ringGroup.add(new THREE.Points(ringGeo, ringMat));
    ringGroup.rotation.set(0.42, 0, -0.14);
    scene.add(ringGroup);

    // skeleton — the machine inside
    const skelGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.98, 1));
    const skelMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(startPal.hot),
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const skeleton = new THREE.LineSegments(skelGeo, skelMat);
    scene.add(skeleton);

    // dust far field
    const DN = 900;
    const dustGeo = new THREE.BufferGeometry();
    const dustPts = new Float32Array(DN * 3);
    for (let i = 0; i < DN; i++) {
      const r = 3.2 + Math.random() * 4.5;
      const phi = Math.random() * Math.PI * 2;
      const cos = Math.random() * 2 - 1;
      const sin = Math.sqrt(1 - cos * cos);
      dustPts[i * 3] = r * sin * Math.cos(phi);
      dustPts[i * 3 + 1] = r * cos * 0.5;
      dustPts[i * 3 + 2] = r * sin * Math.sin(phi);
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPts, 3));
    dustGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(DN), 1));
    const dustMat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color("#d97757") },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Points(dustGeo, dustMat));

    // post pipeline — bloom does the glow honestly
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight),
      0.9, // strength
      0.65, // radius
      0.0 // threshold — additive particles are dim individually, bright in aggregate
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // mouse parallax
    const target = { x: 0, y: 0 };
    const onMouse = (e: MouseEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 0.5;
      target.y = (e.clientY / window.innerHeight - 0.5) * 0.35;
    };
    window.addEventListener("mousemove", onMouse);

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    const tCold = new THREE.Color();
    const tHot = new THREE.Color();
    const tWhite = new THREE.Color();
    const stateMats = [nucleusMat, shellMat, ringMat];

    const clock = new THREE.Clock();
    let smoothedActivity = activityRef.current;
    let smoothedAudio = 0;
    let raf = 0;
    const tick = () => {
      const t = clock.getElapsedTime();
      const pal = PALETTES[modeRef.current];

      const targetActivity = Math.min(activityRef.current + pal.agitation, 1);
      smoothedActivity += (targetActivity - smoothedActivity) * 0.03;
      smoothedAudio += (audioRef.current - smoothedAudio) * 0.25;

      const strobe =
        modeRef.current === "error" ? 0.45 + 0.55 * Math.max(Math.sin(t * 9), 0) : 1;

      tCold.set(pal.cold);
      tHot.set(pal.hot);
      tWhite.set(pal.white);
      for (const m of stateMats) {
        (m.uniforms.uCold.value as THREE.Color).lerp(tCold, 0.04);
        (m.uniforms.uHot.value as THREE.Color).lerp(tHot, 0.04);
        (m.uniforms.uWhite.value as THREE.Color).lerp(tWhite, 0.04);
        m.uniforms.uShimmer.value += (pal.shimmer - m.uniforms.uShimmer.value) * 0.04;
        m.uniforms.uTime.value = t;
        m.uniforms.uActivity.value = smoothedActivity;
        m.uniforms.uAudio.value = smoothedAudio;
      }
      dustMat.uniforms.uTime.value = t;
      (skelMat.color as THREE.Color).lerp(tHot, 0.04);

      shell.rotation.y = t * 0.04;
      skeleton.rotation.y = -t * 0.07;
      skeleton.rotation.x = Math.sin(t * 0.11) * 0.18;
      ringGroup.rotation.z = -0.14 + Math.sin(t * 0.05) * 0.04;

      bloom.strength = (0.85 + smoothedActivity * 0.5 + smoothedAudio * 0.8) * strobe;

      camera.position.x += (target.x * 1.2 - camera.position.x) * 0.04;
      camera.position.y += (0.3 - target.y * 0.8 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, 0);

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("resize", onResize);
      for (const g of [nucleusGeo, shellGeo, ringGeo, dustGeo, skelGeo]) g.dispose();
      for (const m of [nucleusMat, shellMat, ringMat, dustMat, skelMat]) m.dispose();
      composer.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="ember-core" aria-hidden="true" />;
}
