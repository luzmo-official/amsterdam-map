import * as THREE from 'three';

// All pillars share one InstancedMesh per part (column, outline, halo, cap, floor plate, ground ring) plus one
// Points object for the beacons, so the draw-call count stays the same for 10 or 2,000 points.
export interface PillarState {
  x: number;
  z: number;
  lift: number;
  h: number | null;
  color: THREE.Color;
  pillar: boolean;
  ring: boolean;
  ringScale: number;
  beaconScale: number;
  capWhite: boolean;
}

const W = 0.018;
const WHITE = new THREE.Color(0xffffff);
const DARK = 0x04070d;

function beaconTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Pillars {
  readonly group = new THREE.Group();
  readonly beaconUniforms = { uSize: { value: 0.05 }, uHalfH: { value: 400 }, uMap: { value: null as THREE.Texture | null } };
  private meshes: THREE.InstancedMesh[] = [];
  private col!: THREE.InstancedMesh;
  private outline!: THREE.InstancedMesh;
  private halo!: THREE.InstancedMesh;
  private cap!: THREE.InstancedMesh;
  private plate!: THREE.InstancedMesh;
  private ring!: THREE.InstancedMesh;
  private beacons!: THREE.Points;
  private beaconGeo!: THREE.BufferGeometry;
  private n = 0;
  private readonly geos: THREE.BufferGeometry[];
  private readonly mats: THREE.Material[];
  private readonly beaconMat: THREE.ShaderMaterial;
  private readonly o = new THREE.Object3D();
  private readonly c = new THREE.Color();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    const colGeo = new THREE.BoxGeometry(W, 1, W).translate(0, 0.5, 0);
    const shade: number[] = [];
    const pa = colGeo.attributes.position;
    for (let k = 0; k < pa.count; k++) {
      const t = pa.getY(k);
      const s = 0.78 + 0.3 * t;
      shade.push(s, s, s);
    }
    colGeo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
    this.geos = [
      colGeo,
      new THREE.BoxGeometry(W * 1.55, 1, W * 1.55).translate(0, 0.5, 0),
      new THREE.BoxGeometry(W * 3.2, 1, W * 3.2).translate(0, 0.5, 0),
      new THREE.PlaneGeometry(W, W).rotateX(-Math.PI / 2),
      new THREE.PlaneGeometry(W * 1.55, W * 1.55).rotateX(-Math.PI / 2),
      new THREE.RingGeometry(0.016, 0.022, 40).rotateX(-Math.PI / 2)
    ];
    // The column brightens towards the top: its grey vertex shade is multiplied by the instance colour, then lifted towards white.
    const colMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    colMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\nvColor.xyz=mix(vColor.xyz,vec3(1.0),max(0.0,position.y-0.7)*0.9);');
    };
    this.mats = [
      colMat,
      new THREE.MeshBasicMaterial({ color: DARK, side: THREE.BackSide, fog: false }),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      new THREE.MeshBasicMaterial({ fog: false }),
      new THREE.MeshBasicMaterial({ color: DARK, fog: false }),
      // Ground ring: drawn right after the city with no depth test, so buildings never hide it,
      // while the outline and column (drawn after it) still cover it where they stand in front.
      new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, fog: false })
    ];
    this.beaconUniforms.uMap.value = beaconTexture();
    // Beacons keep a minimum on-screen size when zoomed out, like the sprites they replace.
    this.beaconMat = new THREE.ShaderMaterial({
      uniforms: this.beaconUniforms,
      vertexShader: `attribute float aScale;attribute vec3 aColor;varying vec3 vC;uniform float uSize;uniform float uHalfH;
        void main(){vC=aColor;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
        gl_PointSize=aScale*uSize*projectionMatrix[1][1]*uHalfH/max(-mv.z,1e-4);}`,
      fragmentShader: `uniform sampler2D uMap;varying vec3 vC;void main(){vec4 t=texture2D(uMap,gl_PointCoord);gl_FragColor=vec4(vC*t.rgb,t.a);}`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
  }

  setCount(n: number): void {
    if (n === this.n && this.meshes.length) return;
    this.clear();
    this.n = n;
    const cap = Math.max(1, n);
    const order = [3, 2, 5, 3, 1.5, 1];
    this.meshes = this.geos.map((g, i) => {
      const m = new THREE.InstancedMesh(g, this.mats[i], cap);
      m.count = n;
      m.frustumCulled = false;
      m.renderOrder = order[i];
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (i !== 1 && i !== 4) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.group.add(m);
      return m;
    });
    [this.col, this.outline, this.halo, this.cap, this.plate, this.ring] = this.meshes;
    this.beaconGeo = new THREE.BufferGeometry();
    this.beaconGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(cap * 3), 3));
    this.beaconGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(new Float32Array(cap * 3), 3));
    this.beaconGeo.setAttribute('aScale', new THREE.Float32BufferAttribute(new Float32Array(cap), 1));
    this.beaconGeo.setDrawRange(0, n);
    this.beacons = new THREE.Points(this.beaconGeo, this.beaconMat);
    this.beacons.frustumCulled = false;
    this.beacons.renderOrder = 6;
    this.group.add(this.beacons);
  }

  update(states: PillarState[]): void {
    const { o, c, zero } = this;
    const bPos = this.beaconGeo.attributes.position as THREE.BufferAttribute;
    const bCol = this.beaconGeo.attributes.aColor as THREE.BufferAttribute;
    const bScale = this.beaconGeo.attributes.aScale as THREE.BufferAttribute;
    states.forEach((s, i) => {
      const h = s.h ?? 0;
      const show = s.pillar && h > 0;
      const set = (m: THREE.InstancedMesh, y: number, sy: number, sxz = 1): void => {
        o.position.set(s.x, y, s.z);
        o.scale.set(sxz, sy, sxz);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      };
      if (show) {
        set(this.col, s.lift, h);
        set(this.outline, s.lift + 0.0003, h);
        set(this.halo, s.lift, h);
        set(this.cap, s.lift + h + 0.0002, 1);
        set(this.plate, s.lift + 0.0004, 1);
      } else {
        for (const m of [this.col, this.outline, this.halo, this.cap, this.plate]) m.setMatrixAt(i, zero);
      }
      if (s.ring) set(this.ring, s.lift + 0.002, 1, s.ringScale);
      else this.ring.setMatrixAt(i, zero);
      this.col.setColorAt(i, s.color);
      this.halo.setColorAt(i, s.color);
      this.cap.setColorAt(i, s.capWhite ? WHITE : c.copy(s.color).lerp(WHITE, 0.65));
      this.ring.setColorAt(i, c.copy(s.color).lerp(WHITE, 0.2));
      bPos.setXYZ(i, s.x, s.lift + h + 0.002, s.z);
      c.copy(s.color).lerp(WHITE, 0.35);
      bCol.setXYZ(i, c.r, c.g, c.b);
      bScale.setX(i, show ? s.beaconScale : 0);
    });
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    bPos.needsUpdate = bCol.needsUpdate = bScale.needsUpdate = true;
  }

  private clear(): void {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.meshes = [];
    if (this.beacons) { this.group.remove(this.beacons); this.beaconGeo.dispose(); }
  }

  dispose(): void {
    this.clear();
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
    this.beaconMat.dispose();
    this.beaconUniforms.uMap.value?.dispose();
  }
}
