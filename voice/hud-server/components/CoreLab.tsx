"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// CORE LAB — 10 centerpiece candidates, one shared renderer.
// Each variant is a self-contained scene; a single WebGL canvas scissor-renders
// every visible tile (10 separate contexts would exhaust the browser).
// Click a tile to isolate it fullscreen, Esc to return.
// ---------------------------------------------------------------------------

const BG = "#0b0807";
const EMBER = "#d97757";
const EMBER_HOT = "#ff9d52";
const EMBER_DEEP = "#5c1d0c";
const WHITE_HOT = "#ffe3bd";

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

const SOFT_DOT = /* glsl */ `
float softDot(vec2 pc) {
  return smoothstep(0.5, 0.16, length(pc - 0.5));
}
`;

function seeds(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.random();
  return s;
}

function glowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function pointsMat(
  vert: string,
  frag: string,
  uniforms: Record<string, THREE.IUniform>
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, ...uniforms },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

interface Built {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update: (t: number) => void;
  mats: THREE.ShaderMaterial[]; // receive uTime + uPx each frame
}

interface Variant {
  name: string;
  blurb: string;
  build: () => Built;
}

function baseScene(camZ: number, camY = 0): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, camY, camZ);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

// --- 01 HELIOS — structured reactor (nucleus + shell + Kepler ring) ----------

function buildHelios(): Built {
  const { scene, camera } = baseScene(5.0, 0.25);
  const mats: THREE.ShaderMaterial[] = [];

  const NN = 2000;
  const nGeo = new THREE.BufferGeometry();
  const nPts = new Float32Array(NN * 3);
  for (let i = 0; i < NN; i++) {
    const c = Math.random() * 2 - 1;
    const s = Math.sqrt(1 - c * c);
    const phi = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.65) * 0.45;
    nPts.set([s * Math.cos(phi) * r, c * r, s * Math.sin(phi) * r], i * 3);
  }
  nGeo.setAttribute("position", new THREE.BufferAttribute(nPts, 3));
  nGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(NN), 1));
  const nMat = pointsMat(
    /* glsl */ `
    ${SIMPLEX}
    uniform float uTime; uniform float uPx;
    attribute float aSeed;
    varying float vHeat;
    void main() {
      float rr = length(position) / 0.45;
      float n = snoise(position * 5.0 + vec3(uTime * 0.3));
      vec3 p = position * (1.0 + n * 0.12);
      vHeat = clamp(1.1 - rr, 0.0, 1.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (1.0 + vHeat * 1.4) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uHot; uniform vec3 uWhite;
    varying float vHeat;
    void main() {
      vec3 col = mix(uHot, uWhite, vHeat * vHeat);
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * 0.6);
    }`,
    {
      uHot: { value: new THREE.Color(EMBER_HOT) },
      uWhite: { value: new THREE.Color(WHITE_HOT) },
    }
  );
  mats.push(nMat);
  scene.add(new THREE.Points(nGeo, nMat));

  const SN = 2600;
  const sGeo = new THREE.BufferGeometry();
  const sPts = new Float32Array(SN * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SN; i++) {
    const y = 1 - (i / (SN - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    sPts.set([Math.cos(th) * r * 1.12, y * 1.12, Math.sin(th) * r * 1.12], i * 3);
  }
  sGeo.setAttribute("position", new THREE.BufferAttribute(sPts, 3));
  sGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(SN), 1));
  const sMat = pointsMat(
    /* glsl */ `
    ${SIMPLEX}
    uniform float uTime; uniform float uPx;
    attribute float aSeed;
    varying float vRim;
    void main() {
      vec3 nrm = normalize(position);
      float n = snoise(nrm * 2.2 + vec3(uTime * 0.1));
      vec3 p = nrm * 1.12 * (1.0 + n * 0.04);
      vec3 viewN = normalize(normalMatrix * nrm);
      vRim = 1.0 - abs(viewN.z);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.7 + vRim * 1.2) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uCold; uniform vec3 uHot;
    varying float vRim;
    void main() {
      float rim = pow(vRim, 2.2);
      vec3 col = mix(uCold, uHot, rim);
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.1 + rim * 0.65));
    }`,
    {
      uCold: { value: new THREE.Color(EMBER_DEEP) },
      uHot: { value: new THREE.Color(EMBER_HOT) },
    }
  );
  mats.push(sMat);
  const shell = new THREE.Points(sGeo, sMat);
  scene.add(shell);

  const RN = 2200;
  const rGeo = new THREE.BufferGeometry();
  const rPos = new Float32Array(RN * 3);
  const aRadius = new Float32Array(RN);
  const aAngle = new Float32Array(RN);
  for (let i = 0; i < RN; i++) {
    aRadius[i] = 1.4 + Math.pow(Math.random(), 1.6) * 1.0;
    aAngle[i] = Math.random() * Math.PI * 2;
    const yy = (Math.random() + Math.random() - 1) * 0.04;
    rPos.set([Math.cos(aAngle[i]) * aRadius[i], yy, Math.sin(aAngle[i]) * aRadius[i]], i * 3);
  }
  rGeo.setAttribute("position", new THREE.BufferAttribute(rPos, 3));
  rGeo.setAttribute("aRadius", new THREE.BufferAttribute(aRadius, 1));
  rGeo.setAttribute("aAngle", new THREE.BufferAttribute(aAngle, 1));
  rGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(RN), 1));
  const rMat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aRadius; attribute float aAngle; attribute float aSeed;
    varying float vInner;
    void main() {
      float ang = aAngle + uTime * 0.5 * pow(aRadius, -1.5);
      vec3 p = vec3(cos(ang) * aRadius, position.y, sin(ang) * aRadius);
      vInner = 1.0 - smoothstep(1.4, 2.4, aRadius);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.6 + vInner * 0.9) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uCold; uniform vec3 uHot;
    varying float vInner;
    void main() {
      vec3 col = mix(uCold, uHot, vInner * vInner);
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.15 + vInner * 0.5));
    }`,
    {
      uCold: { value: new THREE.Color(EMBER_DEEP) },
      uHot: { value: new THREE.Color(EMBER_HOT) },
    }
  );
  mats.push(rMat);
  const ring = new THREE.Group();
  ring.add(new THREE.Points(rGeo, rMat));
  ring.rotation.set(0.42, 0, -0.14);
  scene.add(ring);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      shell.rotation.y = t * 0.05;
    },
  };
}

// --- 02 SINGULARITY — black hole with lensed accretion -----------------------

function buildSingularity(): Built {
  const { scene, camera } = baseScene(4.8, 0.35);
  const mats: THREE.ShaderMaterial[] = [];

  const hole = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 48, 32),
    new THREE.MeshBasicMaterial({ color: "#000000" })
  );
  scene.add(hole);

  // photon ring — thin halo hugging the silhouette, faces camera
  const photon = new THREE.Mesh(
    new THREE.RingGeometry(0.565, 0.6, 128),
    new THREE.MeshBasicMaterial({
      color: "#ffedd0",
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  scene.add(photon);

  const DN = 3000;
  const dGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DN * 3);
  const aRadius = new Float32Array(DN);
  const aAngle = new Float32Array(DN);
  for (let i = 0; i < DN; i++) {
    aRadius[i] = 0.68 + Math.pow(Math.random(), 1.8) * 1.5;
    aAngle[i] = Math.random() * Math.PI * 2;
    const yy = (Math.random() + Math.random() - 1) * 0.025;
    dPos.set([Math.cos(aAngle[i]) * aRadius[i], yy, Math.sin(aAngle[i]) * aRadius[i]], i * 3);
  }
  dGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
  dGeo.setAttribute("aRadius", new THREE.BufferAttribute(aRadius, 1));
  dGeo.setAttribute("aAngle", new THREE.BufferAttribute(aAngle, 1));
  const dMat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aRadius; attribute float aAngle;
    varying float vInner;
    void main() {
      float ang = aAngle + uTime * 0.7 * pow(aRadius, -1.5);
      vec3 p = vec3(cos(ang) * aRadius, position.y, sin(ang) * aRadius);
      vInner = 1.0 - smoothstep(0.68, 2.0, aRadius);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.6 + vInner * 1.4) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uCold; uniform vec3 uHot;
    varying float vInner;
    void main() {
      vec3 col = mix(uCold, uHot, pow(vInner, 1.5));
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.12 + vInner * 0.85));
    }`,
    {
      uCold: { value: new THREE.Color("#7a3a14") },
      uHot: { value: new THREE.Color("#fff3d8") },
    }
  );
  mats.push(dMat);
  const disc = new THREE.Group();
  disc.add(new THREE.Points(dGeo, dMat));
  disc.rotation.x = 1.32;
  scene.add(disc);

  // lensed halo — the disc's light bent over the poles
  const lens = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.015, 8, 120),
    new THREE.MeshBasicMaterial({
      color: "#e8b87a",
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(lens);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      photon.material.opacity = 0.75 + Math.sin(t * 2.3) * 0.1;
    },
  };
}

// --- 03 LATTICE — constellation graph ----------------------------------------

function buildLattice(): Built {
  const { scene, camera } = baseScene(4.6);
  const mats: THREE.ShaderMaterial[] = [];

  const ico = new THREE.IcosahedronGeometry(1.3, 1);
  const edges = new THREE.EdgesGeometry(ico);
  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color: EMBER,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(lines);

  // unique vertices as pulsing nodes
  const pos = ico.getAttribute("position");
  const seen = new Set<string>();
  const nodes: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    if (!seen.has(k)) {
      seen.add(k);
      nodes.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
  }
  const nGeo = new THREE.BufferGeometry();
  nGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nodes), 3));
  nGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(nodes.length / 3), 1));
  const nMat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aSeed;
    varying float vPulse;
    void main() {
      vPulse = 0.5 + 0.5 * sin(uTime * 1.6 + aSeed * 6.2832);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = (2.4 + vPulse * 1.6) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uHot; uniform vec3 uWhite;
    varying float vPulse;
    void main() {
      vec3 col = mix(uHot, uWhite, vPulse);
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.4 + vPulse * 0.6));
    }`,
    {
      uHot: { value: new THREE.Color(EMBER_HOT) },
      uWhite: { value: new THREE.Color(WHITE_HOT) },
    }
  );
  mats.push(nMat);
  const nodePts = new THREE.Points(nGeo, nMat);
  scene.add(nodePts);

  const inner = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.55, 0)),
    new THREE.LineBasicMaterial({
      color: EMBER_HOT,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(inner);

  const group = new THREE.Group();
  group.add(lines, nodePts);
  scene.add(group);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      group.rotation.y = t * 0.12;
      group.rotation.x = Math.sin(t * 0.2) * 0.25;
      inner.rotation.y = -t * 0.3;
      inner.rotation.z = t * 0.18;
    },
  };
}

// --- 04 ANNULUS — rotating data-disc arcs -------------------------------------

function buildAnnulus(): Built {
  const { scene, camera } = baseScene(4.8, 0.4);
  const mats: THREE.ShaderMaterial[] = [];
  const group = new THREE.Group();
  group.rotation.x = -1.02;
  scene.add(group);

  const arcs: { obj: THREE.Line; speed: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const radius = 0.45 + (i / 26) * 1.6 + Math.random() * 0.05;
    const len = 0.5 + Math.random() * 3.2;
    const start = Math.random() * Math.PI * 2;
    const segs = 72;
    const pts: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const a = start + (j / segs) * len;
      pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    const hot = i % 5 === 0;
    const line = new THREE.Line(
      g,
      new THREE.LineBasicMaterial({
        color: hot ? WHITE_HOT : EMBER,
        transparent: true,
        opacity: hot ? 1 : 0.5 + Math.random() * 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    group.add(line);
    arcs.push({ obj: line, speed: (Math.random() - 0.5) * 0.5 + (hot ? 0.25 : 0) });
  }

  // center pip
  const tex = glowTexture();
  const pip = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      color: WHITE_HOT,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  pip.scale.setScalar(0.35);
  scene.add(pip);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      for (const a of arcs) a.obj.rotation.y = t * a.speed;
      group.rotation.z = Math.sin(t * 0.1) * 0.1;
    },
  };
}

// --- 05 UPLINK — vertical particle beam ----------------------------------------

function buildUplink(): Built {
  const { scene, camera } = baseScene(5.2);
  const mats: THREE.ShaderMaterial[] = [];

  const N = 2600;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const aSpd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = Math.abs((Math.random() + Math.random() - 1)) * 0.45;
    const phi = Math.random() * Math.PI * 2;
    pos.set([Math.cos(phi) * r, Math.random() * 3.4 - 1.7, Math.sin(phi) * r], i * 3);
    aSpd[i] = 0.4 + Math.random() * 1.2;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSpd", new THREE.BufferAttribute(aSpd, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(N), 1));
  const mat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aSpd; attribute float aSeed;
    varying float vCore;
    varying float vSeed;
    void main() {
      vec3 p = position;
      p.y = mod(p.y + 1.7 + uTime * aSpd, 3.4) - 1.7;
      float r = length(p.xz);
      vCore = 1.0 - smoothstep(0.0, 0.45, r);
      vSeed = aSeed;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.4 + vCore * 0.9) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uCold; uniform vec3 uHot;
    varying float vCore;
    varying float vSeed;
    void main() {
      vec3 col = mix(uCold, uHot, vCore * vCore);
      float a = softDot(gl_PointCoord) * (0.1 + vCore * 0.8);
      a *= 0.4 + 0.6 * fract(vSeed * 13.7);
      gl_FragColor = vec4(col, a);
    }`,
    {
      uCold: { value: new THREE.Color(EMBER_DEEP) },
      uHot: { value: new THREE.Color(WHITE_HOT) },
    }
  );
  mats.push(mat);
  scene.add(new THREE.Points(geo, mat));

  // hoops climbing the beam
  const hoops: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.008, 8, 80),
      new THREE.MeshBasicMaterial({
        color: EMBER_HOT,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    hoop.rotation.x = Math.PI / 2;
    scene.add(hoop);
    hoops.push(hoop);
  }

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      hoops.forEach((h, i) => {
        const y = ((t * 0.25 + i / 3) % 1) * 3.2 - 1.6;
        h.position.y = y;
        (h.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - Math.abs(y) / 1.7);
      });
    },
  };
}

// --- 06 FILAMENT — light flowing along a trefoil knot ----------------------------

function buildFilament(): Built {
  const { scene, camera } = baseScene(5.0);
  const mats: THREE.ShaderMaterial[] = [];

  const N = 4200;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const aU = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = (i / N) * Math.PI * 2;
    const r = 2 + Math.cos(3 * u);
    const x = r * Math.cos(2 * u);
    const y = r * Math.sin(2 * u);
    const z = Math.sin(3 * u) * 1.4;
    const jit = 0.045;
    pos.set(
      [
        x * 0.42 + (Math.random() - 0.5) * jit,
        z * 0.42 + (Math.random() - 0.5) * jit,
        y * 0.42 + (Math.random() - 0.5) * jit,
      ],
      i * 3
    );
    aU[i] = u;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(N), 1));
  const mat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aU; attribute float aSeed;
    varying float vFlow;
    void main() {
      vFlow = pow(0.5 + 0.5 * sin(aU * 9.0 - uTime * 2.6), 3.0);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = (0.5 + vFlow * 1.0) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uCold; uniform vec3 uHot;
    varying float vFlow;
    void main() {
      vec3 col = mix(uCold, uHot, vFlow);
      gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.12 + vFlow * 0.8));
    }`,
    {
      uCold: { value: new THREE.Color("#8a3410") },
      uHot: { value: new THREE.Color(WHITE_HOT) },
    }
  );
  mats.push(mat);
  const knot = new THREE.Points(geo, mat);
  scene.add(knot);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      knot.rotation.y = t * 0.18;
      knot.rotation.x = Math.sin(t * 0.14) * 0.35;
    },
  };
}

// --- 07 EMBERS — fire rising from below --------------------------------------------

function buildEmbers(): Built {
  const { scene, camera } = baseScene(5.0, 0.1);
  const mats: THREE.ShaderMaterial[] = [];

  const N = 2400;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const aSpd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = Math.abs(Math.random() + Math.random() - 1) * 0.7;
    const phi = Math.random() * Math.PI * 2;
    pos.set([Math.cos(phi) * r, Math.random() * 3.0, Math.sin(phi) * r], i * 3);
    aSpd[i] = 0.12 + Math.random() * 0.4;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSpd", new THREE.BufferAttribute(aSpd, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(N), 1));
  const mat = pointsMat(
    /* glsl */ `
    ${SIMPLEX}
    uniform float uTime; uniform float uPx;
    attribute float aSpd; attribute float aSeed;
    varying float vHeat;
    varying float vSeed;
    void main() {
      vec3 p = position;
      float yy = mod(p.y + uTime * aSpd, 3.0);
      float h = yy / 3.0;
      p.y = yy - 1.6;
      p.x += snoise(vec3(aSeed * 40.0, yy * 0.7, uTime * 0.12)) * 0.4 * h;
      p.z += snoise(vec3(yy * 0.7, aSeed * 40.0, uTime * 0.12)) * 0.4 * h;
      vHeat = 1.0 - h;
      vSeed = aSeed;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.5 + vHeat * 1.8) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform float uTime;
    uniform vec3 uCold; uniform vec3 uHot; uniform vec3 uWhite;
    varying float vHeat;
    varying float vSeed;
    void main() {
      vec3 col = mix(uCold, mix(uHot, uWhite, vHeat * vHeat), vHeat);
      float a = softDot(gl_PointCoord) * (0.08 + vHeat * 0.75);
      a *= 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (2.0 + vSeed * 5.0) + vSeed * 40.0));
      gl_FragColor = vec4(col, a);
    }`,
    {
      uCold: { value: new THREE.Color("#3d130a") },
      uHot: { value: new THREE.Color(EMBER_HOT) },
      uWhite: { value: new THREE.Color(WHITE_HOT) },
    }
  );
  mats.push(mat);
  scene.add(new THREE.Points(geo, mat));

  const tex = glowTexture();
  const hearth = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      color: EMBER_HOT,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  hearth.position.y = -1.55;
  hearth.scale.set(2.2, 0.8, 1);
  scene.add(hearth);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      hearth.material.opacity = 0.42 + Math.sin(t * 1.7) * 0.08;
    },
  };
}

// --- 08 MONOLITH — fresnel crystal ----------------------------------------------------

function buildMonolith(): Built {
  const { scene, camera } = baseScene(4.8);
  const mats: THREE.ShaderMaterial[] = [];

  const geo = new THREE.OctahedronGeometry(1.0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vView;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uBase; uniform vec3 uEdge; uniform vec3 uWhite;
      varying vec3 vPos;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
        float fres = pow(1.0 - abs(dot(n, vView)), 2.4);
        float facet = 0.5 + 0.5 * dot(n, normalize(vec3(0.6, 1.0, 0.4)));
        vec3 col = uBase * (0.7 + facet * 1.2);
        col += uEdge * fres * (1.6 + 0.3 * sin(uTime * 1.2));
        col += uWhite * pow(fres, 4.0) * 1.3;
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: {
      uTime: { value: 0 },
      uPx: { value: 1 },
      uBase: { value: new THREE.Color("#4a2a18") },
      uEdge: { value: new THREE.Color(EMBER) },
      uWhite: { value: new THREE.Color(WHITE_HOT) },
    },
  });
  mats.push(mat);
  const crystal = new THREE.Mesh(geo, mat);
  crystal.scale.set(0.72, 1.3, 0.72);
  scene.add(crystal);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({
      color: EMBER_HOT,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  edges.scale.copy(crystal.scale).multiplyScalar(1.002);
  scene.add(edges);

  // sparse orbit dust
  const DN = 500;
  const dGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DN * 3);
  for (let i = 0; i < DN; i++) {
    const r = 1.6 + Math.random() * 1.6;
    const phi = Math.random() * Math.PI * 2;
    const c = Math.random() * 2 - 1;
    const s = Math.sqrt(1 - c * c);
    dPos.set([r * s * Math.cos(phi), r * c * 0.6, r * s * Math.sin(phi)], i * 3);
  }
  dGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
  dGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(DN), 1));
  const dMat = pointsMat(
    /* glsl */ `
    uniform float uTime; uniform float uPx;
    attribute float aSeed;
    varying float vA;
    void main() {
      vec3 p = position;
      float t = uTime * 0.04;
      float ca = cos(t), sa = sin(t);
      p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);
      vA = 0.3 + 0.7 * fract(aSeed * 7.31);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (0.5 + fract(aSeed * 3.7) * 0.7) * uPx * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    ${SOFT_DOT}
    uniform vec3 uHot;
    varying float vA;
    void main() {
      gl_FragColor = vec4(uHot, softDot(gl_PointCoord) * vA * 0.25);
    }`,
    { uHot: { value: new THREE.Color(EMBER) } }
  );
  mats.push(dMat);
  scene.add(new THREE.Points(dGeo, dMat));

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      crystal.rotation.y = t * 0.25;
      crystal.position.y = Math.sin(t * 0.6) * 0.08;
      edges.rotation.copy(crystal.rotation);
      edges.position.copy(crystal.position);
    },
  };
}

// --- 09 PROMINENCE — molten star surface ------------------------------------------------

function buildProminence(): Built {
  const { scene, camera } = baseScene(4.6);
  const mats: THREE.ShaderMaterial[] = [];

  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vNrm;
      varying vec3 vViewN;
      void main() {
        vNrm = normalize(position);
        vViewN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${SIMPLEX}
      uniform float uTime;
      uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uHot; uniform vec3 uWhite;
      varying vec3 vNrm;
      varying vec3 vViewN;
      float fbm(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * snoise(p);
          p *= 2.1;
          a *= 0.5;
        }
        return v;
      }
      void main() {
        vec3 p = vNrm * 2.1 + vec3(uTime * 0.05, uTime * 0.03, -uTime * 0.04);
        float n = fbm(p) * 0.5 + 0.5;
        // cell-like hot filaments
        float fil = pow(1.0 - abs(fbm(p * 1.6) ), 6.0);
        vec3 col = mix(uDeep, uMid, smoothstep(0.2, 0.6, n));
        col = mix(col, uHot, smoothstep(0.55, 0.85, n));
        col += uWhite * fil * 0.7;
        float facing = clamp(abs(vViewN.z), 0.0, 1.0);
        col *= 0.45 + 0.55 * pow(facing, 0.65); // limb darkening
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: {
      uTime: { value: 0 },
      uPx: { value: 1 },
      uDeep: { value: new THREE.Color("#2e0d05") },
      uMid: { value: new THREE.Color("#8a3410") },
      uHot: { value: new THREE.Color(EMBER_HOT) },
      uWhite: { value: new THREE.Color("#fff3d8") },
    },
  });
  mats.push(mat);
  const star = new THREE.Mesh(new THREE.SphereGeometry(1.15, 96, 64), mat);
  scene.add(star);

  const tex = glowTexture();
  const corona = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      color: EMBER_HOT,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  corona.scale.setScalar(3.6);
  scene.add(corona);

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      star.rotation.y = t * 0.05;
      corona.material.opacity = 0.36 + Math.sin(t * 1.1) * 0.05;
    },
  };
}

// --- 10 ORBITAL — electron trails -----------------------------------------------------

function buildOrbital(): Built {
  const { scene, camera } = baseScene(5.2);
  const mats: THREE.ShaderMaterial[] = [];

  const tex = glowTexture();
  const nucleus = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      color: WHITE_HOT,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  nucleus.scale.setScalar(0.7);
  scene.add(nucleus);

  const orbits: { head: THREE.Sprite; mat: THREE.ShaderMaterial; speed: number; group: THREE.Group; a: number; b: number }[] = [];
  const root = new THREE.Group();
  scene.add(root);

  for (let k = 0; k < 4; k++) {
    const group = new THREE.Group();
    group.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    root.add(group);
    const a = 1.45 + Math.random() * 0.3;
    const b = 0.8 + Math.random() * 0.35;

    const N = 700;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const aU = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = (i / N) * Math.PI * 2;
      pos.set([Math.cos(u) * a, 0, Math.sin(u) * b], i * 3);
      aU[i] = u;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
    const mat = pointsMat(
      /* glsl */ `
      uniform float uTime; uniform float uPx; uniform float uHead;
      attribute float aU;
      varying float vTrail;
      void main() {
        float ph = fract((uHead - aU) / 6.28318);
        vTrail = pow(1.0 - ph, 5.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (0.5 + vTrail * 1.3) * uPx * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      ${SOFT_DOT}
      uniform vec3 uCold; uniform vec3 uHot;
      varying float vTrail;
      void main() {
        vec3 col = mix(uCold, uHot, vTrail);
        gl_FragColor = vec4(col, softDot(gl_PointCoord) * (0.05 + vTrail * 0.9));
      }`,
      {
        uHead: { value: 0 },
        uCold: { value: new THREE.Color(EMBER_DEEP) },
        uHot: { value: new THREE.Color(k === 0 ? WHITE_HOT : EMBER_HOT) },
      }
    );
    mats.push(mat);
    group.add(new THREE.Points(geo, mat));

    const head = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color: WHITE_HOT,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    head.scale.setScalar(0.16);
    group.add(head);

    orbits.push({ head, mat, speed: 0.5 + Math.random() * 0.7, group, a, b });
  }

  return {
    scene,
    camera,
    mats,
    update: (t) => {
      root.rotation.y = t * 0.06;
      for (const o of orbits) {
        const head = t * o.speed;
        o.mat.uniforms.uHead.value = head;
        o.head.position.set(Math.cos(head) * o.a, 0, Math.sin(head) * o.b);
      }
      nucleus.material.opacity = 0.85 + Math.sin(t * 2.4) * 0.1;
    },
  };
}

// ---------------------------------------------------------------------------

const VARIANTS: Variant[] = [
  { name: "HELIOS", blurb: "structured reactor · shell + kepler ring", build: buildHelios },
  { name: "SINGULARITY", blurb: "black hole · lensed accretion", build: buildSingularity },
  { name: "LATTICE", blurb: "constellation graph · machine geometry", build: buildLattice },
  { name: "ANNULUS", blurb: "data disc · rotating arc rings", build: buildAnnulus },
  { name: "UPLINK", blurb: "energy column · particle beam", build: buildUplink },
  { name: "FILAMENT", blurb: "trefoil knot · light flowing a ribbon", build: buildFilament },
  { name: "EMBERS", blurb: "rising fire · organic drift", build: buildEmbers },
  { name: "MONOLITH", blurb: "fresnel crystal · quiet luxury", build: buildMonolith },
  { name: "PROMINENCE", blurb: "molten star · live fbm surface", build: buildProminence },
  { name: "ORBITAL", blurb: "electron trails · gyroscope", build: buildOrbital },
];

export default function CoreLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [solo, setSolo] = useState<number | null>(null);
  const soloRef = useRef<number | null>(null);
  soloRef.current = solo;

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

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(new THREE.Color(BG));

    const built = VARIANTS.map((v) => v.build());

    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    };
    window.addEventListener("resize", onResize);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const t = clock.getElapsedTime();
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissorTest(true);

      built.forEach((b, i) => {
        const el = tileRefs.current[i];
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const bottom = window.innerHeight - rect.bottom;

        b.camera.aspect = rect.width / rect.height;
        b.camera.updateProjectionMatrix();

        const px = rect.height / 640;
        for (const m of b.mats) {
          m.uniforms.uTime.value = t;
          if (m.uniforms.uPx) m.uniforms.uPx.value = Math.max(px, 0.35) * 0.6;
        }
        b.update(t);

        renderer.setViewport(rect.left, bottom, rect.width, rect.height);
        renderer.setScissor(rect.left, bottom, rect.width, rect.height);
        renderer.render(b.scene, b.camera);
      });

      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      for (const b of built) {
        b.scene.traverse((o) => {
          const obj = o as THREE.Mesh;
          if (obj.geometry) obj.geometry.dispose();
          const m = obj.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else if (m) m.dispose();
        });
      }
      renderer.dispose();
    };
  }, []);

  return (
    <main className={`lab ${solo !== null ? "lab-solo" : ""}`}>
      <canvas ref={canvasRef} className="lab-canvas" />
      <header className="lab-head">
        <span className="lab-title">CORE LAB</span>
        <span className="lab-sub">
          centerpiece candidates · click to isolate · esc to return · keys 1–0
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
