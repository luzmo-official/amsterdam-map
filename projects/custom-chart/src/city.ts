import * as THREE from 'three';
import cityGz from './data/city.bin.gz';
import { AREA, hash, sxz } from './geo';

type Section = Uint8Array | Uint16Array | Int16Array | Uint32Array;
export interface CityHead {
  q: [number, number, number];
  chunk: number;
  chunks: [number, number, number][];
  sections: [string, string, number, number][];
  waterLabels: [string, number, number, number][];
  roadLabels: [string, number, number, number, number][];
}
export interface City { head: CityHead; S: Record<string, Section> }

// The city is decoded once per page and kept, so a chart can be rebuilt (new instance, lost GPU context) without unpacking it again.
let cityPromise: Promise<City> | null = null;
export function loadCity(): Promise<City> {
  if (!cityPromise) {
    cityPromise = decode().catch((err) => {
      cityPromise = null;
      throw err;
    });
  }
  return cityPromise;
}
async function decode(): Promise<City> {
  let buf: Uint8Array = cityGz;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error("This browser can't unpack the map data. Try a current Chrome, Edge, Firefox or Safari.");
    }
    const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const hl = new DataView(ab).getUint32(0, true);
  const head: CityHead = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, hl)));
  const base = 4 + hl;
  const T: Record<string, any> = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array };
  const S: Record<string, Section> = {};
  head.sections.forEach(([n, t, o, l]) => { S[n] = new T[t](ab, base + o, l); });
  return { head, S };
}

function ringReader(Sa: Section, XY: Section) {
  let k = 0, p = 0;
  return (n: number): Float64Array => {
    let x = Sa[2 * k], y = Sa[2 * k + 1];
    k++;
    const o = new Float64Array(2 * n);
    o[0] = x; o[1] = y;
    for (let i = 1; i < n; i++) { x += XY[p++]; y += XY[p++]; o[2 * i] = x; o[2 * i + 1] = y; }
    return o;
  };
}
// Yields to the browser between chunks; a message isn't clamped like nested setTimeout calls are.
const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const yieldQueue: (() => void)[] = [];
if (yieldChannel) yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
export const tick = (): Promise<void> => new Promise((r) => {
  if (!yieldChannel) { setTimeout(r, 0); return; }
  yieldQueue.push(r);
  yieldChannel.port2.postMessage(0);
});

// Once a buffer is on the GPU its CPU copy is dead weight, so it's dropped on upload.
function dropArr(this: { array: unknown }): void { this.array = null; }
export function dropAfterUpload<G extends THREE.BufferGeometry>(g: G): G {
  if (!g.boundingSphere) g.computeBoundingSphere();
  for (const k in g.attributes) (g.attributes[k] as THREE.BufferAttribute).onUpload(dropArr);
  if (g.index) g.index.onUpload(dropArr);
  return g;
}

/* ---------- roof-height grid ---------- */
// Tallest roof per 10 m cell in decimetres, filled from the building footprints while the city loads.
// Pillars are seated on it with a few lookups, so new data never needs the building geometry again.
export const GRID_CELL = 10;
const GRID_N = Math.ceil((AREA.x1 - AREA.x0) / GRID_CELL);
let roofGrid: Uint16Array | null = null;
export function roofAt(X: number, Y: number): number {
  if (!roofGrid) return 0;
  const i = Math.floor((X - AREA.x0) / GRID_CELL), j = Math.floor((Y - AREA.y0) / GRID_CELL);
  if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_N) return 0;
  return roofGrid[j * GRID_N + i];
}
function rasterRoof(grid: Uint16Array, ring: Float64Array, hdm: number): void {
  const n = ring.length / 2;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ring[2 * i], y = ring[2 * i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const i0 = Math.max(0, Math.floor((x0 - AREA.x0) / GRID_CELL)), i1 = Math.min(GRID_N - 1, Math.floor((x1 - AREA.x0) / GRID_CELL));
  const j0 = Math.max(0, Math.floor((y0 - AREA.y0) / GRID_CELL)), j1 = Math.min(GRID_N - 1, Math.floor((y1 - AREA.y0) / GRID_CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * GRID_N + i;
      if (grid[k] >= hdm) continue;
      // a cell counts when the footprint covers its centre, or for footprints smaller than a cell, when it holds them
      const cx = AREA.x0 + (i + 0.5) * GRID_CELL, cy = AREA.y0 + (j + 0.5) * GRID_CELL;
      let inside = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ya = ring[2 * a + 1], yb = ring[2 * b + 1];
        if ((ya > cy) !== (yb > cy) && cx < ((ring[2 * b] - ring[2 * a]) * (cy - ya)) / (yb - ya) + ring[2 * a]) inside = !inside;
      }
      if (inside || (i0 === i1 && j0 === j1)) grid[k] = hdm;
    }
  }
}

/* ---------- buildings ---------- */
export function createBuildingMaterial(night: { value: number }): THREE.MeshStandardMaterial {
  // Flat-shaded LoD1.2 extrusions with procedural windows (floor/bay grid from world position, lit at night, faded with distance).
  const bMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, side: THREE.DoubleSide });
  bMat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH;varying float vH;varying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos=(modelMatrix*vec4(transformed,1.0)).xyz;vH=aH;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;varying float vH;varying vec3 vWPos;')
      .replace('#include <color_fragment>', `#include <color_fragment>
    vec3 fn=normalize(cross(dFdx(vWPos),dFdy(vWPos)));
    float vert=1.0-step(0.5,abs(fn.y));
    vec2 tg=normalize(vec2(-fn.z,fn.x)+1e-6);
    vec2 g=vec2(dot(vWPos.xz,tg)/0.0029,vWPos.y/0.0031);
    vec2 cell=floor(g);vec2 f=fract(g);
    float tall=step(4.5,vH);
    float win=step(0.25,f.x)*step(f.x,0.75)*step(0.28,f.y)*step(f.y,0.76)*vert*tall*step(0.0028,vWPos.y)*step(vWPos.y,vH*0.001-0.0009);
    float hsh=fract(sin(dot(cell,vec2(12.9898,78.233))+vH*1.37)*43758.5453);
    float fade=1.0-smoothstep(0.7,2.6,length(vWPos-cameraPosition));
    diffuseColor.rgb*=mix(0.6,1.0,smoothstep(0.0,0.008,vWPos.y));
    diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*0.42+vec3(0.05,0.06,0.08),win*fade*0.8);
    float bh=fract(sin(dot(vColor.rgb,vec3(12.9898,78.233,37.719))+vH*3.17)*43758.5453);
    float t=clamp(vWPos.y/max(vH*0.001,0.0004),0.0,1.0);
    float rim=vert*tall*smoothstep(0.82,1.0,t)*0.22;
    float far=smoothstep(1.0,5.0,length(vWPos-cameraPosition));
    float roofGlow=(1.0-vert)*step(3.0,vH)*(0.07+0.2*bh)*far;
    float agg=vert*tall*(0.3+0.42*bh)*(0.7+0.4*t);
    float winGlow=uNight*(mix(agg,win*step(0.5,hsh)*(0.75+0.55*hsh),fade)+rim*(1.0-fade*0.6)+roofGlow);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance+=winGlow*vec3(1.0,0.72,0.4)*1.15;');
  };
  return bMat;
}

// Wall colour by construction year; roofs by roof type.
const ERA: [number, string[]][] = [
  [1850, ['#6b3327', '#5a2b22', '#4a2a24', '#7d3f2e', '#3a3432', '#2d2c31', '#cfc2a6', '#8a4a35']],
  [1920, ['#8a4d39', '#9a5841', '#7a4232', '#b39a7c', '#a2654a', '#6f3b2d']],
  [1945, ['#9c5236', '#a85f40', '#8a4a33', '#7d4330', '#b47355']],
  [1975, ['#c9c4ba', '#b7b1a6', '#d5d0c6', '#bfb4a2', '#a9a39a']],
  [2000, ['#a99e90', '#9a8676', '#c0b5a5', '#8f8a85', '#b59b80']],
  [9999, ['#7f8f9c', '#9fb0bc', '#d7d9d6', '#5f6f7c', '#a8b5bf', '#c4b8a8']]];
const ROOF = { slanted: ['#4b3f3d', '#5a4a44', '#3f3a3c', '#6a4636'], flat: ['#8a8780', '#7b7872', '#96928a', '#6d6b68'] };
const hex2 = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ERA_RGB: [number, number[][]][] = ERA.map(([y, c]) => [y, c.map(hex2)]);
const ROOF_RGB = { s: ROOF.slanted.map(hex2), f: ROOF.flat.map(hex2) };

// Scratch buffers for one chunk, grown as needed and reused, so building the city doesn't churn through big JS arrays.
let sPos = new Int16Array(1 << 19), sCol = new Uint8Array(1 << 19), sHH = new Uint8Array(1 << 17), sIdx = new Uint32Array(1 << 19);
function grow<A extends Int16Array | Uint8Array | Uint32Array>(a: A, n: number): A {
  if (n <= a.length) return a;
  let m = a.length;
  while (m < n) m *= 2;
  const b = new (a.constructor as any)(m) as A;
  b.set(a);
  return b;
}

// Main-thread time spent building, without the yields in between (part of data-load-ms on the chart root).
export const buildStats = { work: 0 };

export async function buildBuildings(
  city: City, material: THREE.Material, add: (m: THREE.Object3D) => void,
  progress: (f: number) => void, alive: () => boolean
): Promise<number> {
  const { head, S } = city;
  const [QX, QY, RES] = head.q;
  const CH = head.chunk, rd2 = ringReader(S.bS, S.bXY);
  const fillGrid = !roofGrid;
  const grid = roofGrid ?? new Uint16Array(GRID_N * GRID_N);
  let b = 0, ri = 0, done = 0;
  const total = head.chunks.reduce((a, c) => a + c[2], 0);
  for (const [ci, cj, count] of head.chunks) {
    const t0 = performance.now();
    const cX = QX + ci * CH, cY = QY + cj * CH;
    let nv = 0, ni = 0;
    for (let k = 0; k < count; k++, b++) {
      const h = S.bH[b] / 10, yr = S.bYear[b], roof = S.bRoof[b], nr = S.bRings[b];
      const era = (ERA_RGB.find((e) => yr < e[0]) as [number, number[][]])[1];
      const r1 = hash(b * 7 + 1), r2 = hash(b * 13 + 5);
      let wc = era[(r1 * era.length) | 0];
      if (h > 40) wc = ERA_RGB[5][1][(r2 * 4) | 0];
      const rc = (roof === 1 ? ROOF_RGB.s : ROOF_RGB.f)[(r2 * 4) | 0];
      const sh = 0.9 + r2 * 0.2;
      const hdm = Math.round(h * 10), aH = Math.min(255, Math.round(h));
      const wr = Math.min(255, wc[0] * sh), wg = Math.min(255, wc[1] * sh), wb = Math.min(255, wc[2] * sh);
      const rr = Math.min(255, rc[0] * sh), rg = Math.min(255, rc[1] * sh), rb = Math.min(255, rc[2] * sh);
      const rings: Float32Array[] = [];
      let np = 0;
      for (let r = 0; r < nr; r++, ri++) {
        const q = rd2(S.bLen[ri]);
        const n = q.length / 2, pts = new Float32Array(2 * n);
        np += n;
        if (fillGrid && r === 0) {
          const world = new Float64Array(2 * n);
          for (let i = 0; i < 2 * n; i += 2) { world[i] = QX + q[i] * RES; world[i + 1] = QY + q[i + 1] * RES; }
          rasterRoof(grid, world, hdm);
        }
        for (let i = 0; i < n; i++) {
          pts[2 * i] = Math.round((QX + q[2 * i] * RES - cX) * 10);
          pts[2 * i + 1] = -Math.round((QY + q[2 * i + 1] * RES - cY) * 10);
        }
        rings.push(pts);
      }
      // 4 wall vertices and 1 roof vertex per ring point; 6 wall indices and at most 3 roof indices per point
      const vMax = nv + 5 * np;
      sPos = grow(sPos, 3 * vMax); sCol = grow(sCol, 3 * vMax); sHH = grow(sHH, vMax); sIdx = grow(sIdx, ni + 9 * np);
      for (const pts of rings) {
        const n = pts.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ax = pts[2 * i], az = pts[2 * i + 1], bx = pts[2 * j], bz = pts[2 * j + 1], p = 3 * nv;
          sPos[p] = ax; sPos[p + 1] = 0; sPos[p + 2] = az; sPos[p + 3] = bx; sPos[p + 4] = 0; sPos[p + 5] = bz;
          sPos[p + 6] = bx; sPos[p + 7] = hdm; sPos[p + 8] = bz; sPos[p + 9] = ax; sPos[p + 10] = hdm; sPos[p + 11] = az;
          for (let v = 0; v < 4; v++) { sCol[p + 3 * v] = wr; sCol[p + 3 * v + 1] = wg; sCol[p + 3 * v + 2] = wb; sHH[nv + v] = aH; }
          sIdx[ni] = nv; sIdx[ni + 1] = nv + 1; sIdx[ni + 2] = nv + 2; sIdx[ni + 3] = nv; sIdx[ni + 4] = nv + 2; sIdx[ni + 5] = nv + 3;
          ni += 6; nv += 4;
        }
      }
      const contour: THREE.Vector2[] = [], holes: THREE.Vector2[][] = [];
      rings.forEach((pts, r) => {
        const a: THREE.Vector2[] = [];
        for (let i = 0; i < pts.length; i += 2) a.push(new THREE.Vector2(pts[i], pts[i + 1]));
        if (r === 0) contour.push(...a); else holes.push(a);
      });
      let faces: number[][];
      try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { faces = []; }
      const all = contour.concat(...holes), r0 = nv;
      for (const v of all) {
        const p = 3 * nv;
        sPos[p] = v.x; sPos[p + 1] = hdm; sPos[p + 2] = v.y; sCol[p] = rr; sCol[p + 1] = rg; sCol[p + 2] = rb; sHH[nv] = 0;
        nv++;
      }
      sIdx = grow(sIdx, ni + 3 * faces.length);
      for (const f of faces) { sIdx[ni] = r0 + f[0]; sIdx[ni + 1] = r0 + f[1]; sIdx[ni + 2] = r0 + f[2]; ni += 3; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sPos.slice(0, 3 * nv), 3));
    g.setAttribute('color', new THREE.BufferAttribute(sCol.slice(0, 3 * nv), 3, true));
    g.setAttribute('aH', new THREE.BufferAttribute(sHH.slice(0, nv), 1, false));
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? sIdx.slice(0, ni) : new Uint16Array(sIdx.subarray(0, ni)), 1));
    g.computeBoundingSphere();
    (g.boundingSphere as THREE.Sphere).radius *= 1.05;
    dropAfterUpload(g);
    const m = new THREE.Mesh(g, material);
    const o = sxz(cX, cY);
    m.position.set(o[0], 0, o[1]);
    m.scale.setScalar(0.0001);
    add(m);
    done += count;
    progress(done / total);
    buildStats.work += performance.now() - t0;
    await tick();
    if (!alive()) break;
  }
  if (fillGrid && done === total) roofGrid = grid;
  return total;
}

export function buildPolys(
  city: City, pfx: string, y: number, meshFor: (c: number) => THREE.Material,
  add: (m: THREE.Object3D) => void, lamps?: number[], lampsFrom?: (c: number) => boolean
): void {
  const { head, S } = city;
  const [QX, QY, RES] = head.q;
  const C = S[pfx + 'C'], N = S[pfx + 'N'], L = S[pfx + 'Len'], rdr = ringReader(S[pfx + 'S'], S[pfx + 'XY']);
  const groups: Record<number, { pos: number[]; idx: number[]; nv: number }> = {};
  let li = 0;
  for (let k = 0; k < C.length; k++) {
    const c = C[k];
    const G = groups[c] || (groups[c] = { pos: [], idx: [], nv: 0 });
    const contour: THREE.Vector2[] = [], holes: THREE.Vector2[][] = [];
    for (let r = 0; r < N[k]; r++, li++) {
      const q = rdr(L[li]);
      const a: THREE.Vector2[] = [];
      for (let i = 0; i < q.length; i += 2) {
        const p = sxz(QX + q[i] * RES, QY + q[i + 1] * RES);
        a.push(new THREE.Vector2(p[0], p[1]));
      }
      if (r === 0) contour.push(...a); else holes.push(a);
    }
    let faces: number[][];
    try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { continue; }
    const all = contour.concat(...holes);
    all.forEach((v) => G.pos.push(v.x, y, v.y));
    faces.forEach((f) => G.idx.push(G.nv + f[0], G.nv + f[1], G.nv + f[2]));
    G.nv += all.length;
    if (lamps && lampsFrom && lampsFrom(c) && contour.length) {
      let sx = 0, sz = 0;
      contour.forEach((v) => { sx += v.x; sz += v.y; });
      lamps.push(sx / contour.length, 0.004, sz / contour.length);
    }
  }
  Object.entries(groups).forEach(([c, G]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
    g.setIndex(G.nv > 65535 ? new THREE.Uint32BufferAttribute(G.idx, 1) : new THREE.Uint16BufferAttribute(G.idx, 1));
    g.computeVertexNormals();
    dropAfterUpload(g);
    const m = new THREE.Mesh(g, meshFor(+c));
    m.renderOrder = -1;
    add(m);
  });
}

export function buildRails(city: City, mats: THREE.Material[], add: (m: THREE.Object3D) => void): void {
  const { head, S } = city;
  const [QX, QY, RES] = head.q;
  const C = S.lC, L = S.lLen, rdr = ringReader(S.lS, S.lXY);
  const g: number[][] = [[], [], []];
  for (let k = 0; k < C.length; k++) {
    const q = rdr(L[k]);
    for (let i = 0; i + 3 < q.length; i += 2) {
      const a = sxz(QX + q[i] * RES, QY + q[i + 1] * RES), b = sxz(QX + q[i + 2] * RES, QY + q[i + 3] * RES);
      g[C[k]].push(a[0], 0.0009, a[1], b[0], 0.0009, b[1]);
    }
  }
  g.forEach((p, c) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    add(new THREE.LineSegments(dropAfterUpload(geo), mats[c]));
  });
}

export function buildTrees(city: City, material: THREE.Material, lamps: number[]): THREE.InstancedMesh {
  const { head, S } = city;
  const [QX, QY, RES] = head.q;
  const n = S.tK.length, geo = new THREE.IcosahedronGeometry(1, 0).translate(0, 1.3, 0);
  const im = new THREE.InstancedMesh(geo, material, n);
  const o = new THREE.Object3D(), c = new THREE.Color();
  const TC = ['#4f7f43', '#5d8a4a', '#476f3c', '#6b9452', '#3f6a3a'];
  for (let i = 0; i < n; i++) {
    const p = sxz(QX + S.tXY[2 * i] * RES, QY + S.tXY[2 * i + 1] * RES), k = S.tK[i], r = hash(i * 3 + 11);
    const s = (k === 1 ? 0.0036 : 0.003) + r * 0.0024;
    o.position.set(p[0], 0, p[1]);
    o.rotation.set(0, r * 6, 0);
    o.scale.set(s, s * 1.2, s);
    o.updateMatrix();
    im.setMatrixAt(i, o.matrix);
    c.set(TC[(r * 5) | 0]).multiplyScalar(0.8 + hash(i) * 0.4);
    im.setColorAt(i, c);
    if (k === 1 && i % 3 === 0) lamps.push(p[0], 0.004, p[1]);
  }
  im.instanceMatrix.onUpload(dropArr);
  (im.instanceColor as THREE.InstancedBufferAttribute).onUpload(dropArr);
  return im;
}
