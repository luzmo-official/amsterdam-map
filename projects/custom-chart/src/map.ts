import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildBuildings, buildStats, buildPolys, buildRails, buildTrees, createBuildingMaterial, dropAfterUpload, loadCity, roofAt, tick } from './city';
import { buildColoring, DEFAULT_RANGE, heightFn, type ColorOptions, type Coloring, type HeightScale } from './encode';
import { clamp, esc, hash, inArea, rd, sxz, V3 } from './geo';
import { Pillars, type PillarState } from './pillars';
import { DISTRICTS, LANDMARKS, LINES } from './places';
import type { Content, MapPoint, ParsedData } from './query';
import { TEMPLATE } from './template';

export interface MapOptions {
  panelShow: boolean;
  panelTitle: string;
  panelSubtitle: string;
  heightScale: HeightScale;
  heightMax: number | null;
  color: ColorOptions;
  labelDensity: 'none' | 'top' | 'all';
  labelTopN: number;
  labelValue: boolean;
  cardRank: boolean;
  rankOrder: 'desc' | 'asc';
  cardLinkText: string;
  cardNote: string;
  footerSource: string;
  cameraStart: 'fit' | 'city' | 'centrum';
  cameraTilt: boolean;
  filter: boolean;
  metro: boolean;
  streets: boolean;
  districts: boolean;
  trees: boolean;
  animation: boolean;
  themeColors: string[];
}

export interface MapInput {
  parsed: ParsedData | null;
  nameContent?: Content;
  options: MapOptions;
}

interface Item {
  p: MapPoint;
  i: number;
  x: number;
  z: number;
  X: number;
  Y: number;
  h: number | null;
  lift: number;
  hex: string;
  col: THREE.Color;
  rank: number;
  el?: HTMLButtonElement;
  tempLabel?: boolean;
  w?: number;
  anchor: THREE.Vector3;
}
interface Place { n: string; kind: string; p: THREE.Vector3; d: number }
type LabelEl = HTMLElement & { _v?: boolean; _w?: number };

const LABEL_CAP = 200;
const NARROW = 700;
const TILT3D = 0.95;
const FLOAT_GAP = 0.003;
const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
const P = {
  bg: 0x0a111c, ground: 0x101722, water: 0x14304d, waterE: 0x0b223f, grass: 0x13261d, wood: 0x0f2018, rail: 0x161c26, sand: 0x1b1d22,
  roads: [0x18202c, 0x2c1f28, 0x222c3b, 0x2f3848, 0x5e4a2c], track: [0x3b4352, 0x34404e, 0x3d3f55], tree: 0x1a3325,
  hemi: [0x6f86b8, 0x1a1420, 0.42] as [number, number, number], sun: [0xbfd0ff, 0.26] as [number, number], fog: 0.04
};
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reduceMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let fontsRequested = false;

interface CamState { t: THREE.Vector3; d: number; phi: number; theta: number }

export class AmsterdamMap {
  readonly root: HTMLElement;
  private readonly $ = <T extends Element = HTMLElement>(s: string): T => this.root.querySelector(s) as T;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.0015, 120);
  private readonly controls: MapControls;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly night = { value: 1 };
  private readonly M = {
    ground: new THREE.MeshStandardMaterial({ roughness: 1 }),
    water: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2, side: THREE.DoubleSide }),
    green: [null, 1, 2, 3, 4].map((v) => v && new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide })) as THREE.MeshStandardMaterial[],
    roads: [0, 1, 2, 3, 4].map(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
    track: [0, 1, 2].map(() => new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 })),
    tree: new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
    buildings: createBuildingMaterial(this.night)
  };
  private readonly pillars = new Pillars();
  private trees: THREE.InstancedMesh | null = null;
  private readonly metro: { L: (typeof LINES)[number]; curve: THREE.CatmullRomCurve3; len: number; tu: number; dir: number; mat: THREE.MeshBasicMaterial; train: THREE.Group; stations: THREE.Group; mesh?: THREE.Mesh; car: number }[] = [];
  private metroR: number | null = null;

  private opts!: MapOptions;
  private parsed: ParsedData | null = null;
  private nameContent?: Content;
  private items: Item[] = [];
  private coloring: Coloring = { colorOf: () => '#ff5468', legend: [] };
  private hiddenKeys = new Set<string>();
  private outside = 0;
  private selected: Item | null = null;
  private hovered: Item | null = null;
  private filterSent = false;
  private pillarsOn = true;
  private layerOverride: Partial<Record<'metro' | 'streets' | 'districts' | 'trees', boolean>> = {};
  private firstData = true;
  private lastCamKey = '';

  private ready = false;
  private destroyed = false;
  private dirty = true;
  private pillarsDirty = true;
  private labelsDirty = true;
  private trainsSeen = false;
  private raf = 0;
  private last = performance.now();
  private W = 1;
  private H = 1;
  private bounds = { x0: -7, x1: 8, z0: -6, z1: 9 };
  private tilted = true;
  private anim: { a: CamState; b: CamState; t0: number; dur: number } | null = null;
  private zoomPending = 0;
  private readonly zoomPt = new THREE.Vector3();
  private readonly off = { x: 0, y: 0 };
  private hud = { w: '', t: '', r: '' };
  private readonly camSig = new Float64Array(26);
  private readonly camNow = new Float64Array(26);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly sph = new THREE.Spherical();
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly carS = new THREE.Sphere();
  private readonly ray = new THREE.Raycaster();
  private readonly ptr = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private readonly labelsEl: HTMLElement;
  private lmLabels: { name: string; pos: THREE.Vector3; el: LabelEl }[] = [];
  private distLabels: { el: LabelEl; pos: THREE.Vector3 }[] = [];
  private stLabels: { name: string; el: LabelEl; pos: THREE.Vector3 }[] = [];
  private waterLabels: { name: string; area: number; pos: THREE.Vector3; el: LabelEl }[] = [];
  private roadLabels: { name: string; area: number; pos: THREE.Vector3; dir: THREE.Vector3; el: LabelEl; w?: number }[] = [];
  private places: Place[] = [];
  private qRows: ({ it: Item } | { pl: Place })[] = [];
  private qSel = 0;
  private down: [number, number] | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(container: HTMLElement, private readonly onContextRestored: () => void) {
    if (!fontsRequested && typeof document !== 'undefined') {
      fontsRequested = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
      document.head.appendChild(link);
    }
    this.root = document.createElement('div');
    this.root.className = 'am3d';
    this.root.tabIndex = 0;
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);
    this.canvas = this.$<HTMLCanvasElement>('canvas.gl');
    this.labelsEl = this.$('.labels');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.FogExp2(0, 0.03);
    this.scene.add(this.hemi);
    this.sun.position.set(-5, 9, 7);
    this.scene.add(this.sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), this.M.ground);
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.scene.add(this.pillars.group);
    this.applyPalette();
    this.buildMetro();
    this.buildStaticLabels();

    this.controls = new MapControls(this.camera, this.canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.09, zoomSpeed: 1.1, rotateSpeed: 0.55, panSpeed: 1, minDistance: 0.05, maxDistance: 16, minPolarAngle: 0, maxPolarAngle: 1.3 });
    // wheel zoom is handled below (towards the cursor); MapControls only keeps pinch zoom
    this.controls.enableZoom = true;
    this.setCam(V3(52.37, 4.893), 11, 0.3, -0.3);

    this.bindUi();
    this.raf = requestAnimationFrame(this.frame);
    this.boot();
  }

  /* ---------- public API ---------- */
  update(input: MapInput): void {
    const prev = this.opts;
    this.opts = input.options;
    this.parsed = input.parsed;
    this.nameContent = input.nameContent;
    this.applyLayers();
    this.root.classList.toggle('panel-on', this.opts.panelShow);
    this.$('.ttl-h').textContent = this.opts.panelTitle || 'Amsterdam';
    this.$('.ttl-p').textContent = this.opts.panelSubtitle || this.parsed?.measureLabel || '';
    this.root.querySelectorAll('.src').forEach((el) => { el.textContent = this.opts.footerSource ? this.opts.footerSource + ' ' : ''; });
    this.rebuildItems();
    const camKey = `${this.opts.cameraStart}|${this.opts.cameraTilt}`;
    if (this.ready && (this.firstData && this.items.length || (prev && camKey !== this.lastCamKey))) {
      this.firstData = !this.items.length;
      this.setTilt(this.opts.cameraTilt);
      this.animateTo(this.startView(), 1200);
    }
    this.lastCamKey = camKey;
    this.wake();
  }

  resize(width?: number, height?: number): void {
    const W = Math.max(1, Math.round(width || this.root.clientWidth || 1));
    const H = Math.max(1, Math.round(height || this.root.clientHeight || 1));
    this.W = W;
    this.H = H;
    this.root.style.width = W + 'px';
    this.root.style.height = H + 'px';
    const narrow = W <= NARROW;
    this.root.classList.toggle('narrow', narrow);
    this.root.classList.toggle('short', narrow && H <= 560);
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.fov = narrow ? 55 : 42;
    this.camera.updateProjectionMatrix();
    this.pillars.beaconUniforms.uHalfH.value = (H * this.renderer.getPixelRatio()) / 2;
    this.remeasure();
    this.wake();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.controls.dispose();
    this.pillars.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    Object.values(this.M).flat().forEach((m) => (m as THREE.Material | null)?.dispose?.());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
  }

  /* ---------- boot: unpack and build the city ---------- */
  private async boot(): Promise<void> {
    const msg = this.$('.loader .msg'), bar = this.$<HTMLElement>('.loader .bar i');
    const add = (o: THREE.Object3D): void => { this.scene.add(o); };
    const alive = (): boolean => !this.destroyed;
    const t0 = performance.now();
    try {
      msg.textContent = 'Unpacking the city…';
      const city = await loadCity();
      const tUnpacked = performance.now();
      if (!alive()) return;
      const [QX, QY] = city.head.q;
      const a = sxz(QX, QY), b = sxz(QX + 14000, QY + 14000);
      this.bounds = { x0: Math.min(a[0], b[0]) + 0.3, x1: Math.max(a[0], b[0]) - 0.3, z0: Math.min(a[1], b[1]) + 0.3, z1: Math.max(a[1], b[1]) - 0.3 };
      msg.textContent = 'Laying out water, parks and streets…';
      await tick();
      if (!alive()) return;
      const lamps: number[] = [];
      buildPolys(city, 'g', 0.00015, (c) => this.M.green[c], add);
      buildPolys(city, 'r', 0.0003, (c) => this.M.roads[c], add, lamps, (c) => c >= 2);
      buildPolys(city, 'w', 0.0005, () => this.M.water, add);
      buildRails(city, this.M.track, add);
      this.trees = buildTrees(city, this.M.tree, lamps);
      this.trees.frustumCulled = false;
      add(this.trees);
      const tFlat = performance.now();
      msg.textContent = 'Raising buildings…';
      const nB = await buildBuildings(city, this.M.buildings, add, (f) => {
        bar.style.width = (f * 100).toFixed(1) + '%';
        msg.textContent = `Raising buildings… ${Math.round(f * 100)}%`;
      }, alive);
      if (!alive()) return;
      const lampPts = new THREE.Points(
        dropAfterUpload(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3))),
        new THREE.PointsMaterial({ color: 0xffc879, size: 0.0035, transparent: true, opacity: 0.85, depthWrite: false })
      );
      add(lampPts);
      this.waterLabels = city.head.waterLabels.map(([n, x, y, area]) => {
        const p = sxz(x, y);
        return { name: n, area, pos: new THREE.Vector3(p[0], 0.002, p[1]), el: this.mk('wl', esc(n)) };
      }).sort((a, b) => b.area - a.area);
      this.roadLabels = city.head.roadLabels.map(([n, x, y, area, ang]) => {
        const p = sxz(x, y);
        return { name: n, area, pos: new THREE.Vector3(p[0], 0.002, p[1]), dir: new THREE.Vector3(Math.cos(ang) * 0.02, 0, -Math.sin(ang) * 0.02), el: this.mk('rl', esc(n)) };
      });
      const seen = new Set(this.places.map((p) => p.n));
      this.places = this.places
        .concat(this.waterLabels.filter((l) => !seen.has(l.name) && seen.add(l.name)).map((l) => ({ n: l.name, kind: 'Water', p: l.pos.clone().setY(0), d: 0.5 })))
        .concat(this.roadLabels.filter((l) => !seen.has(l.name) && seen.add(l.name)).map((l) => ({ n: l.name, kind: 'Street', p: l.pos.clone().setY(0), d: 0.35 })));
      void nB;
      this.applyLayers();
      this.seat();
      this.updateNotice();
      // upload the city and compile the shaders while the loader still covers the map
      const tFirst = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.root.dataset.loadMs = [tUnpacked - t0, tFlat - tUnpacked, buildStats.work, performance.now() - tFirst, performance.now() - t0].map((x) => x.toFixed(0)).join(',');
      this.ready = true;
      this.dirty = true;
      this.updateNotice();
      this.$('.loader').classList.add('done');
      this.setTilt(this.opts?.cameraTilt ?? true);
      const start = this.startView();
      if (this.opts && !this.opts.animation) this.setCam(start.t, start.d, start.phi, start.theta);
      else this.animateTo(start, reduceMotion() ? 1 : 2400);
      if (this.items.length) this.firstData = false;
    } catch (err) {
      msg.textContent = (err as Error)?.message || 'The map could not be loaded.';
      this.$('.loader').classList.add('error');
      console.error(err);
    }
  }

  /* ---------- scene palette, metro, static labels ---------- */
  private applyPalette(): void {
    const { M, scene } = this;
    (scene.background as THREE.Color).setHex(P.bg);
    const fog = scene.fog as THREE.FogExp2;
    fog.color.setHex(P.bg);
    fog.density = P.fog;
    M.ground.color.setHex(P.ground);
    M.water.color.setHex(P.water);
    M.water.emissive.setHex(P.waterE);
    M.water.emissiveIntensity = 1;
    M.green[1].color.setHex(P.grass); M.green[2].color.setHex(P.wood); M.green[3].color.setHex(P.rail); M.green[4].color.setHex(P.sand);
    M.roads.forEach((m, i) => m.color.setHex(P.roads[i]));
    M.track.forEach((m, i) => m.color.setHex(P.track[i]));
    M.tree.color.setHex(0xffffff).lerp(new THREE.Color(P.tree), 0.8);
    this.hemi.color.setHex(P.hemi[0]); this.hemi.groundColor.setHex(P.hemi[1]); this.hemi.intensity = P.hemi[2];
    this.sun.color.setHex(P.sun[0]); this.sun.intensity = P.sun[1];
    this.night.value = 1;
  }

  private buildMetro(): void {
    LINES.forEach((L, k) => {
      const curve = new THREE.CatmullRomCurve3(L.st.map((s) => V3(s[1], s[2], 0.003)), false, 'catmullrom', 0.3);
      const mat = new THREE.MeshBasicMaterial({ color: L.color, transparent: true, opacity: 0.95, depthWrite: false });
      const train = new THREE.Group();
      for (let i = 0; i < 4; i++) train.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 0.45), new THREE.MeshBasicMaterial({ color: L.color })));
      const stations = new THREE.Group();
      L.st.forEach((s) => {
        const d = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        d.position.copy(V3(s[1], s[2], 0.003));
        stations.add(d);
      });
      this.scene.add(train, stations);
      this.metro.push({ L, curve, len: curve.getLength(), tu: hash(k + 3), dir: 1, mat, train, stations, car: 0.01 });
    });
  }

  private updateMetro(d: number, dt: number): void {
    const on = this.layer('metro');
    const r = clamp(d * 0.0014, 0.002, 0.018), q = Math.round(Math.log(r) / Math.log(1.25));
    if (q !== this.metroR) {
      this.metroR = q;
      const R = Math.pow(1.25, q);
      this.metro.forEach((m) => {
        if (m.mesh) { this.scene.remove(m.mesh); m.mesh.geometry.dispose(); }
        m.mesh = new THREE.Mesh(new THREE.TubeGeometry(m.curve, 300, R, 5, false), m.mat);
        m.mesh.renderOrder = 2;
        this.scene.add(m.mesh);
        m.stations.children.forEach((s) => s.scale.setScalar(R * 2.2));
        m.car = R * 6;
      });
    }
    this.metro.forEach((m) => {
      if (m.mesh) m.mesh.visible = on;
      m.train.visible = on;
      m.stations.visible = on;
      if (this.opts?.animation !== false) {
        m.tu += m.dir * dt * 0.25 / m.len;
        if (m.tu > 1) { m.tu = 1; m.dir = -1; }
        if (m.tu < 0) { m.tu = 0; m.dir = 1; }
      }
      m.train.children.forEach((car, i) => {
        const u = clamp(m.tu - m.dir * i * m.car * 1.1 / m.len, 0, 1);
        const p = m.curve.getPointAt(u), q2 = m.curve.getPointAt(Math.min(1, u + 0.002));
        car.scale.setScalar(m.car);
        car.position.set(p.x, 0.003 + m.car * 0.3, p.z);
        car.lookAt(q2.x, car.position.y, q2.z);
        car.rotateY(Math.PI / 2);
      });
    });
  }

  private mk(cls: string, html: string): LabelEl {
    const d = document.createElement('div') as LabelEl;
    d.className = cls;
    d.innerHTML = html;
    d._v = true;
    this.labelsEl.appendChild(d);
    return d;
  }

  private buildStaticLabels(): void {
    this.lmLabels = LANDMARKS.map(([n, a, b]) => ({ name: n, pos: V3(a, b, 0.02), el: this.mk('lm', `<i></i>${esc(n)}`) }));
    this.distLabels = DISTRICTS.map((a) => ({ el: this.mk('ar', esc(a[0])), pos: V3(a[1], a[2], 0.01) }));
    LINES.forEach((L) => L.st.forEach((s) => {
      if (this.stLabels.some((x) => x.name === s[0])) return;
      this.stLabels.push({ el: this.mk('st', `<i style="background:${L.color}"></i>${esc(s[0])}`), name: s[0], pos: V3(s[1], s[2], 0.004) });
    }));
    this.places = DISTRICTS.map((d) => ({ n: d[0], kind: 'Neighbourhood', p: V3(d[1], d[2]), d: 1.4 }))
      .concat(this.lmLabels.map((l) => ({ n: l.name, kind: 'Landmark', p: l.pos.clone().setY(0), d: 0.35 })))
      .concat(this.stLabels.map((s) => ({ n: s.name, kind: 'Metro station', p: s.pos.clone().setY(0), d: 0.4 })));
  }

  /* ---------- data → items ---------- */
  private rebuildItems(): void {
    const o = this.opts;
    const parsed = this.parsed;
    const prevSel = this.selected?.p.key;
    this.items.forEach((it) => it.el?.remove());
    this.items = [];
    this.outside = 0;
    this.selected = null;
    this.hovered = null;
    if (parsed) {
      const hOf = heightFn(parsed.points.map((p) => p.value), o.heightScale, o.heightMax);
      this.coloring = buildColoring(parsed, o.color, o.themeColors);
      for (const p of parsed.points) {
        if (!inArea(p.lat, p.lng)) { this.outside++; continue; }
        const [X, Y] = rd(p.lat, p.lng);
        const [x, z] = sxz(X, Y);
        const hex = this.coloring.colorOf(p);
        this.items.push({ p, i: this.items.length, x, z, X, Y, h: hOf(p.value), lift: 0, hex, col: new THREE.Color(hex), rank: 0, anchor: new THREE.Vector3(x, 0, z) });
      }
      const ranked = this.items.filter((it) => it.p.value !== null)
        .sort((a, b) => (o.rankOrder === 'asc' ? 1 : -1) * ((a.p.value as number) - (b.p.value as number)));
      ranked.forEach((it, k) => { it.rank = k + 1; });
    } else {
      this.coloring = { colorOf: () => '#ff5468', legend: [] };
    }
    const keys = new Set(this.coloring.legend.map((l) => l.key));
    this.hiddenKeys = new Set([...this.hiddenKeys].filter((k) => keys.has(k)));
    this.pillars.setCount(this.items.length);
    this.seat();
    this.buildPointLabels();
    this.renderLegend();
    this.renderRank();
    this.updateNotice();
    const keep = prevSel !== undefined ? this.items.find((it) => it.p.key === prevSel) : undefined;
    if (keep) { this.selected = keep; this.renderCard(); }
    else this.closeCard(false);
    this.pillarsDirty = true;
    this.labelsDirty = true;
  }

  // Lift each pillar to just above the tallest roof within ~23 m, so it floats over the houses around it.
  private seat(): void {
    for (const it of this.items) {
      let top = 0;
      for (let k = 0; k < 17; k++) {
        const r = k === 0 ? 0 : k < 9 ? 12 : 23, a = k * Math.PI / 4;
        top = Math.max(top, roofAt(it.X + Math.cos(a) * r, it.Y + Math.sin(a) * r));
      }
      it.lift = top > 0 ? top * 0.0001 + FLOAT_GAP : 0;
    }
    this.pillarsDirty = true;
    this.labelsDirty = true;
  }

  private isShown(it: Item): boolean {
    return !(it.p.colorKey !== undefined && this.hiddenKeys.has(it.p.colorKey));
  }

  private syncPillars(now: number, d: number): void {
    const bs = clamp(d * 0.022, 0.035, 0.3);
    this.pillars.beaconUniforms.uSize.value = bs;
    const pulse = this.opts?.animation !== false;
    const states: PillarState[] = this.items.map((it) => {
      const shown = this.isShown(it);
      const sel = it === this.selected;
      return {
        x: it.x, z: it.z, lift: it.lift, h: it.h, color: it.col,
        pillar: shown && this.pillarsOn,
        ring: shown,
        ringScale: sel ? 1.4 * (pulse ? 1 + 0.18 * Math.sin(now / 260) : 1) : 1,
        beaconScale: it === this.hovered || sel ? 1.5 : 1,
        capWhite: it === this.hovered
      };
    });
    this.pillars.update(states);
    this.pillarsDirty = false;
  }

  /* ---------- labels ---------- */
  private vis(el: LabelEl, on: boolean): void {
    if (el._v !== on) { el._v = on; el.style.visibility = on ? 'visible' : 'hidden'; }
  }
  // A label's width only changes with its text or the fonts, so it's measured once rather than every frame.
  private wOf(el: LabelEl): number { return el._w ?? (el._w = el.offsetWidth); }
  private remeasure(): void {
    for (const el of Array.from(this.labelsEl.children) as LabelEl[]) el._w = undefined;
    this.roadLabels.forEach((l) => { l.w = undefined; });
    this.items.forEach((it) => { it.w = undefined; });
    this.labelsDirty = true;
  }

  private buildPointLabels(): void {
    const o = this.opts;
    const byValue = this.items.filter((it) => it.p.value !== null)
      .sort((a, b) => (b.p.value as number) - (a.p.value as number));
    const n = o.labelDensity === 'none' ? 0 : o.labelDensity === 'all' ? LABEL_CAP : clamp(Math.round(o.labelTopN) || 0, 0, LABEL_CAP);
    const labelled = new Set(byValue.slice(0, n));
    for (const it of this.items) {
      if (!labelled.has(it)) continue;
      it.el = this.makePointLabel(it);
    }
  }
  private makePointLabel(it: Item): HTMLButtonElement {
    const d = document.createElement('button') as HTMLButtonElement & LabelEl;
    d.type = 'button';
    d.className = 'lab';
    d.innerHTML = `<i style="background:${it.hex}"></i><span>${esc(it.p.label)}</span>${this.opts.labelValue ? `<em>${esc(it.p.valueText)}</em>` : ''}`;
    d.addEventListener('click', (e) => { e.stopPropagation(); this.openItem(it, true); });
    d._v = true;
    this.labelsEl.appendChild(d);
    return d;
  }

  private scr(v: THREE.Vector3): [number, number] | null {
    const t = this.tmp.copy(v).project(this.camera);
    if (t.z > 1 || t.x < -1.08 || t.x > 1.08 || t.y < -1.08 || t.y > 1.08) return null;
    return [(t.x * 0.5 + 0.5) * this.W, (-t.y * 0.5 + 0.5) * this.H];
  }
  private place(el: LabelEl, v: THREE.Vector3, offY = 0, mode = 'b', rot = 0): [number, number] | null {
    const r = this.scr(v);
    if (!r) { this.vis(el, false); return null; }
    this.vis(el, true);
    r[1] += offY;
    el.style.transform = `translate(${r[0] | 0}px,${r[1] | 0}px) translate(-50%,${mode === 'b' ? '-100%' : '-50%'})${rot ? ` rotate(${rot.toFixed(3)}rad)` : ''}`;
    return r;
  }

  private updateLabels(d: number): void {
    const placed: number[][] = [];
    const hits = (b: number[]): boolean => placed.some((p) => !(b[2] < p[0] || b[0] > p[2] || b[3] < p[1] || b[1] > p[3]));
    const sel = this.selected;
    if (sel && !sel.el) { sel.el = this.makePointLabel(sel); sel.tempLabel = true; }
    const order = this.items.filter((it) => it.el).sort((a, b) => Number(b === sel) - Number(a === sel) || (b.h ?? 0) - (a.h ?? 0));
    for (const it of order) {
      const el = it.el as LabelEl;
      if (!this.isShown(it)) { this.vis(el, false); continue; }
      const h = it.h ?? 0;
      it.anchor.y = it.lift + (this.pillarsOn && h > 0 ? Math.min(h + 0.003, Math.max(0.02, d * 0.3)) : 0.008);
      const r = this.place(el, it.anchor, -6);
      if (!r) continue;
      const bw = this.wOf(el) || 90, b = [r[0] - bw / 2, r[1] - 26, r[0] + bw / 2, r[1]];
      if (it !== sel && hits(b)) { this.vis(el, false); continue; }
      placed.push(b);
      el.classList.toggle('hot', it === sel || it === this.hovered);
    }
    const simple = (list: { el: LabelEl; pos: THREE.Vector3 }[], on: boolean, offY: number, mode: string, half: number, fallback: number): void => {
      for (const l of list) {
        if (!on) { this.vis(l.el, false); continue; }
        const r = this.place(l.el, l.pos, offY, mode);
        if (!r) continue;
        const w = this.wOf(l.el) || fallback;
        const b = mode === 'b' ? [r[0] - w / 2, r[1] - half, r[0] + w / 2, r[1]] : [r[0] - w / 2, r[1] - half, r[0] + w / 2, r[1] + half];
        if (hits(b)) this.vis(l.el, false); else placed.push(b);
      }
    };
    simple(this.lmLabels, d < 3.2, -2, 'b', 18, 80);
    simple(this.stLabels, this.layer('metro') && d < 1.8, -4, 'b', 18, 80);
    const wMin = 4000 * d * d;
    for (const l of this.waterLabels) {
      if (l.area < wMin || d > 9) { this.vis(l.el, false); continue; }
      const r = this.place(l.el, l.pos, 0, 'c');
      if (!r) continue;
      const w = this.wOf(l.el) || 60, b = [r[0] - w / 2, r[1] - 9, r[0] + w / 2, r[1] + 9];
      if (hits(b)) this.vis(l.el, false); else placed.push(b);
    }
    const rOn = this.layer('streets') && d < 1.25, rMin = 1600 * d * d;
    for (const l of this.roadLabels) {
      if (!rOn || l.area < rMin) { this.vis(l.el, false); continue; }
      this.tmp2.copy(l.pos).add(l.dir);
      const a = this.scr(l.pos), bb = this.scr(this.tmp2);
      if (!a || !bb) { this.vis(l.el, false); continue; }
      let ang = Math.atan2(bb[1] - a[1], bb[0] - a[0]);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const w = l.w || (l.w = l.el.offsetWidth || 70);
      const hw = Math.abs(Math.cos(ang)) * w / 2 + 6, hh = Math.abs(Math.sin(ang)) * w / 2 + 6, b = [a[0] - hw, a[1] - hh, a[0] + hw, a[1] + hh];
      if (hits(b)) { this.vis(l.el, false); continue; }
      placed.push(b);
      this.place(l.el, l.pos, 0, 'c', ang);
    }
    simple(this.distLabels, this.layer('districts') && d > 1.6 && d < 12, 0, 'c', 10, 80);
    this.labelsDirty = false;
  }

  /* ---------- legend, ranking, search ---------- */
  private renderLegend(): void {
    const c = this.coloring;
    let html = '';
    if (c.legend.length) {
      html = c.legend.map((l) => `<button type="button" class="chip" data-k="${esc(l.key)}" aria-pressed="${!this.hiddenKeys.has(l.key)}"><i style="background:${l.color}"></i>${esc(l.label)}<span>${l.count}</span></button>`).join('');
    } else if (c.gradient) {
      const g = c.gradient;
      const lbl = this.opts.color.mode === 'measure' ? this.parsed?.measureLabel : this.parsed?.colorLabel;
      html = `<div class="grad"><span class="gl-t">${esc(lbl || '')}</span><span class="gl-b" style="background:linear-gradient(90deg,${g.stops.map((s) => s.color).join(',')})"></span><span class="gl-v"><span>${esc(g.min)}</span><span>${esc(g.max)}</span></span></div>`;
    }
    for (const host of [this.$('.legend-in'), this.$('.float-legend')]) {
      host.innerHTML = html;
      host.toggleAttribute('hidden', !html);
      host.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.k as string;
        if (this.hiddenKeys.has(k)) this.hiddenKeys.delete(k); else this.hiddenKeys.add(k);
        this.renderLegend();
        this.renderRank();
        this.pillarsDirty = this.labelsDirty = true;
        this.wake();
      }));
    }
  }

  private renderRank(): void {
    if (!this.opts?.panelShow) return;
    const rows = this.items.filter((it) => it.p.value !== null && this.isShown(it)).sort((a, b) => a.rank - b.rank);
    const max = rows.reduce((m, it) => Math.max(m, Math.abs(it.p.value as number)), 0) || 1;
    const list = this.$('.rank-list');
    list.innerHTML = rows.map((it, k) => `<li><button type="button" data-i="${it.i}" aria-current="${it === this.selected}"><span class="n">${k + 1}</span><span class="nm"><b>${esc(it.p.label)}</b>${it.p.colorLabel ? `<small>${esc(it.p.colorLabel)}</small>` : ''}<span class="bar"><span style="width:${(Math.max(0, it.p.value as number) / max * 100).toFixed(1)}%;background:${it.hex}"></span></span></span><span class="v">${esc(it.p.valueText)}</span></button></li>`).join('')
      || '<li class="empty">Nothing to rank yet.</li>';
    list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.openItem(this.items[+(b.dataset.i as string)], true)));
    this.$('.rank-label').textContent = this.parsed?.measureLabel ?? '';
    this.$('.rank-count').textContent = rows.length ? `${rows.length}` : '';
  }

  private renderSearch(): void {
    const q = this.$<HTMLInputElement>('.q'), list = this.$('.results'), side = this.$('.side');
    const s = q.value.trim().toLowerCase();
    side.classList.toggle('searching', !!s);
    if (!s) { this.qRows = []; list.innerHTML = ''; return; }
    const hay = (it: Item): string => [it.p.label, it.p.colorLabel ?? '', ...it.p.details.map((d) => d.text)].join(' ').toLowerCase();
    const pts = this.items.filter((it) => this.isShown(it) && hay(it).includes(s)).sort((a, b) => (b.p.value ?? -Infinity) - (a.p.value ?? -Infinity)).slice(0, 50).map((it) => ({ it }));
    const starts = this.places.filter((p) => p.n.toLowerCase().startsWith(s));
    const rest = this.places.filter((p) => !p.n.toLowerCase().startsWith(s) && p.n.toLowerCase().includes(s));
    this.qRows = [...pts, ...starts.concat(rest).slice(0, 8).map((pl) => ({ pl }))];
    this.qSel = 0;
    list.innerHTML = this.qRows.map((r, i) => 'it' in r
      ? `<li><button type="button" role="option" data-i="${i}" aria-selected="${i === this.qSel}"><i style="background:${r.it.hex}"></i><span class="t"><b>${esc(r.it.p.label)}</b><small>${esc(r.it.p.details[0]?.text ?? r.it.p.colorLabel ?? '')}</small></span><span class="v">${esc(r.it.p.valueText)}</span></button></li>`
      : `<li><button type="button" role="option" data-i="${i}" aria-selected="${i === this.qSel}"><i class="pin"></i><span class="t"><b>${esc(r.pl.n)}</b><small>${r.pl.kind}</small></span></button></li>`).join('')
      || `<li class="empty">Nothing matches “${esc(q.value)}”.</li>`;
    list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.choose(this.qRows[+(b.dataset.i as string)])));
  }
  private choose(r: { it: Item } | { pl: Place } | undefined): void {
    if (!r) return;
    const q = this.$<HTMLInputElement>('.q');
    q.value = '';
    this.renderSearch();
    q.blur();
    if ('it' in r) this.openItem(r.it, true);
    else { this.closeCard(); this.animateTo({ t: r.pl.p, d: r.pl.d || 0.5 }); }
  }
  private openSearch(): void {
    if (!this.opts?.panelShow) return;
    this.$('.side').classList.add('open');
    this.$<HTMLInputElement>('.q').focus();
  }

  /* ---------- detail card & dashboard filter ---------- */
  private openItem(it: Item, fly: boolean): void {
    this.selected = it;
    this.renderCard();
    this.$('.side').classList.remove('open');
    this.renderRank();
    if (fly) this.animateTo({ t: new THREE.Vector3(it.x, 0, it.z), d: clamp((it.h ?? 0) * 2.2 + 0.3, 0.5, 1.8) });
    this.sendFilter(it);
    this.labelsDirty = this.pillarsDirty = true;
    this.wake();
  }

  private closeCard(clearFilter = true): void {
    const card = this.$('.card');
    const wasOpen = !card.hidden;
    card.hidden = true;
    this.root.classList.remove('has-card');
    const sel = this.selected;
    this.selected = null;
    if (sel?.el && sel.tempLabel) { sel.el.remove(); sel.el = undefined; sel.tempLabel = false; }
    if (wasOpen) this.renderRank();
    if (clearFilter && this.filterSent) {
      window.parent.postMessage({ type: 'setFilter', filters: [] }, '*');
      this.filterSent = false;
    }
    this.labelsDirty = this.pillarsDirty = true;
    this.wake();
  }

  private sendFilter(it: Item): void {
    const c = this.nameContent;
    if (!this.opts.filter || !c) return;
    const column_id = c.columnId ?? c.column, dataset_id = c.datasetId ?? c.set;
    if (!column_id || !dataset_id) return;
    const ref: Record<string, unknown> = { column_id, dataset_id };
    if (c.level !== undefined && c.level !== null) ref.level = c.level;
    window.parent.postMessage({ type: 'setFilter', filters: [{ expression: '? = ?', parameters: [ref, it.p.key] }] }, '*');
    this.filterSent = true;
  }

  private renderCard(): void {
    const it = this.selected;
    const card = this.$('.card');
    if (!it) return;
    const o = this.opts, p = it.p;
    const total = this.items.filter((x) => x.p.value !== null).length;
    const links = p.details.filter((d) => d.href);
    const rows = p.details.filter((d) => !d.href);
    const tag = p.colorLabel !== undefined ? `<span class="sector"><i style="background:${it.hex}"></i>${esc(p.colorLabel)}</span>` : '';
    card.innerHTML = `<header><div class="ttl">${tag}<h2>${esc(p.label)}</h2></div><button class="iconbtn close" type="button" aria-label="Close details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
      <div class="kpi"><div><span class="lbl">${esc(this.parsed?.measureLabel ?? '')}</span><span class="big">${esc(p.valueText)}</span></div>${o.cardRank && it.rank ? `<span class="rankpill">#${it.rank} of ${total}</span>` : ''}</div>
      ${rows.length ? `<dl class="dets">${rows.map((d) => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.text)}</dd></div>`).join('')}</dl>` : ''}
      ${links.map((d) => `<a class="lnk" href="${esc(d.href)}" target="_blank" rel="noopener">${esc(links.length > 1 ? `${o.cardLinkText || 'Open link'} · ${d.label}` : o.cardLinkText || 'Open link')}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg></a>`).join('')}
      ${o.cardNote ? `<p class="note">${esc(o.cardNote)}</p>` : ''}`;
    card.querySelector('.close')?.addEventListener('click', () => this.closeCard());
    card.hidden = false;
    this.root.classList.add('has-card');
  }

  private updateNotice(): void {
    const parts: string[] = [];
    if (this.outside) parts.push(`${this.outside} point${this.outside === 1 ? '' : 's'} outside the map area`);
    if (this.parsed?.noCoords) parts.push(`${this.parsed.noCoords} without coordinates`);
    if (this.parsed?.capped) parts.push('showing the top 2,000 rows');
    this.$('.stat').textContent = parts.join(' · ');
    const notice = this.$('.notice');
    let msg = '';
    if (!this.parsed) msg = 'Add a Label, Latitude & longitude and a Measure to place pillars on the map.';
    else if (!this.items.length) msg = this.parsed.points.length ? 'None of the points fall inside the 3D map area.' : 'No rows to show.';
    notice.textContent = msg;
    notice.hidden = !msg || !this.ready;
  }

  /* ---------- layers ---------- */
  private layer(k: 'metro' | 'streets' | 'districts' | 'trees'): boolean {
    return this.layerOverride[k] ?? this.opts?.[k] ?? true;
  }
  private applyLayers(): void {
    if (this.trees) this.trees.visible = this.layer('trees');
    this.root.querySelectorAll<HTMLInputElement>('.layers input').forEach((inp) => {
      const k = inp.dataset.l as string;
      inp.checked = k === 'pillars' ? this.pillarsOn : this.layer(k as 'metro');
    });
    this.labelsDirty = true;
  }

  /* ---------- camera ---------- */
  private camState(): CamState {
    this.sph.setFromVector3(new THREE.Vector3().subVectors(this.camera.position, this.controls.target));
    return { t: this.controls.target.clone(), d: this.sph.radius, phi: this.sph.phi, theta: this.sph.theta };
  }
  private setCam(t: THREE.Vector3, d: number, phi: number, theta: number): void {
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(new THREE.Vector3().setFromSphericalCoords(d, phi, theta));
    this.camera.lookAt(t);
  }
  private animateTo(o: Partial<CamState>, dur = 1100): void {
    const a = this.camState();
    const b = { t: o.t ? o.t.clone() : a.t, d: o.d ?? a.d, phi: o.phi ?? a.phi, theta: o.theta ?? a.theta };
    let dth = b.theta - a.theta;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    b.theta = a.theta + dth;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = 1.3;
    const instant = reduceMotion() || this.opts?.animation === false && dur > 1000;
    this.anim = { a, b, t0: performance.now(), dur: instant ? 1 : dur };
    this.wake();
  }
  private stepAnim(now: number): boolean {
    if (!this.anim) return false;
    const { a: A, b: B } = this.anim;
    const u = ease(Math.min(1, (now - this.anim.t0) / this.anim.dur));
    const lift = 1 + Math.sin(u * Math.PI) * Math.min(0.8, A.t.distanceTo(B.t) / Math.max(A.d, B.d) * 0.5);
    this.setCam(A.t.clone().lerp(B.t, u), Math.exp(THREE.MathUtils.lerp(Math.log(A.d), Math.log(B.d), u)) * lift, THREE.MathUtils.lerp(A.phi, B.phi, u), THREE.MathUtils.lerp(A.theta, B.theta, u));
    if (u >= 1) { this.anim = null; this.lockTilt(); }
    return true;
  }
  private lockTilt(): void {
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = this.tilted ? 1.3 : 0.0001;
  }
  private setTilt(on: boolean): void {
    this.tilted = on;
    const b = this.$('.b-tilt');
    b.textContent = on ? '2D' : '3D';
    b.setAttribute('aria-label', on ? 'Switch to top-down view' : 'Switch to 3D view');
  }
  private startView(): CamState {
    const phi = this.tilted ? TILT3D : 0.0001, theta = this.tilted ? 0.32 : 0;
    const mode = this.opts?.cameraStart ?? 'fit';
    const shown = this.items.filter((it) => this.isShown(it));
    if (mode === 'fit' && shown.length) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const it of shown) { x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x); z0 = Math.min(z0, it.z); z1 = Math.max(z1, it.z); }
      const ext = Math.max(x1 - x0, (z1 - z0) * (this.W / this.H || 1), 0.3);
      return { t: new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), d: clamp(ext * 1.25 + 0.6, 0.6, 12), phi, theta };
    }
    if (mode === 'city') return { t: V3(52.364, 4.9), d: 9, phi, theta };
    return { t: V3(52.37, 4.893), d: 2.7, phi, theta };
  }
  private zoomBy(f: number): void {
    const s = this.camState();
    this.animateTo({ d: clamp(s.d * f, this.controls.minDistance, this.controls.maxDistance) }, 380);
  }
  private stepZoom(): void {
    if (Math.abs(this.zoomPending) < 1e-4) { this.zoomPending = 0; return; }
    const step = reduceMotion() ? this.zoomPending : this.zoomPending * 0.28;
    this.zoomPending -= step;
    const { camera, controls, zoomPt } = this;
    const d = camera.position.distanceTo(controls.target), nd = clamp(d * Math.exp(step), controls.minDistance, controls.maxDistance), k = nd / d;
    if (Math.abs(k - 1) < 1e-6) { this.zoomPending = 0; return; }
    controls.target.sub(zoomPt).multiplyScalar(k).add(zoomPt);
    camera.position.sub(zoomPt).multiplyScalar(k).add(zoomPt);
    controls.target.y = 0;
  }

  /* ---------- picking ---------- */
  // Screen-space pick against each pillar's axis, so pillars, ground rings and zero-height points are all clickable.
  private pick(e: { clientX: number; clientY: number }): Item | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const d = this.camera.position.distanceTo(this.controls.target);
    let best: Item | null = null, bestD = Infinity;
    for (const it of this.items) {
      if (!this.isShown(it)) continue;
      const a = this.scr(this.tmp2.set(it.x, it.lift, it.z));
      if (!a) continue;
      const h = this.pillarsOn ? it.h ?? 0 : 0;
      const b = this.scr(this.tmp2.set(it.x, it.lift + h, it.z)) ?? a;
      const tol = clamp(9 / Math.max(d, 0.2), 5, 14);
      const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
      const t = len2 > 0 ? clamp(((mx - a[0]) * vx + (my - a[1]) * vy) / len2, 0, 1) : 0;
      const dist = Math.hypot(mx - (a[0] + vx * t), my - (a[1] + vy * t));
      if (dist < tol) {
        const depth = this.tmp.set(it.x, it.lift, it.z).distanceTo(this.camera.position);
        if (depth < bestD) { bestD = depth; best = it; }
      }
    }
    return best;
  }

  /* ---------- events ---------- */
  private on<K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn, opts);
    this.cleanup.push(() => el.removeEventListener(type, fn, opts));
  }

  private bindUi(): void {
    const { canvas, root } = this;
    const tip = this.$('.tip');
    const q = this.$<HTMLInputElement>('.q');
    // Wake the loop on any interaction inside the chart; Luzmo's render/resize wake it too.
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'click', 'input', 'change']
      .forEach((t) => this.on(root, t, () => this.wake(), { capture: true, passive: true }));
    if (document.fonts) this.on(document.fonts, 'loadingdone', () => { this.remeasure(); this.wake(); });

    this.on(canvas, 'webglcontextlost', (e: Event) => e.preventDefault());
    // The CPU copies of the city are gone once uploaded, so a restored context means building the chart again.
    this.on(canvas, 'webglcontextrestored', () => this.onContextRestored());

    this.on(canvas, 'pointerdown', (e: PointerEvent) => { this.down = [e.clientX, e.clientY]; this.anim = null; this.lockTilt(); });
    this.on(canvas, 'pointerup', (e: PointerEvent) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]);
      this.down = null;
      if (moved > 5) return;
      const it = this.pick(e);
      if (it) this.openItem(it, true);
      else { this.closeCard(); this.$('.side').classList.remove('open'); }
    });
    this.on(canvas, 'pointermove', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const it = this.pick(e);
      if (it !== this.hovered) {
        this.hovered = it;
        canvas.style.cursor = it ? 'pointer' : '';
        this.pillarsDirty = this.labelsDirty = true;
      }
      if (it) {
        const r = root.getBoundingClientRect();
        const dets = it.p.details.filter((d) => !d.href).slice(0, 3);
        tip.hidden = false;
        tip.innerHTML = `<b>${esc(it.p.label)}</b><span>${esc(it.p.valueText)}${it.p.colorLabel !== undefined ? ` · ${esc(it.p.colorLabel)}` : ''}</span>${dets.map((d) => `<span>${esc(d.label)}: ${esc(d.text)}</span>`).join('')}`;
        const x = Math.min(e.clientX - r.left + 14, this.W - (tip.offsetWidth || 160) - 8);
        const y = Math.min(e.clientY - r.top + 14, this.H - (tip.offsetHeight || 60) - 8);
        tip.style.transform = `translate(${x}px,${y}px)`;
      } else tip.hidden = true;
    });
    this.on(canvas, 'pointerleave', () => { tip.hidden = true; });

    // Wheel zooms toward the ground point under the cursor (the built-in controls only zoom to the screen centre).
    this.on(root, 'wheel', (e: WheelEvent) => {
      const t = e.target as Element;
      if (t !== canvas && !t.closest?.('.labels')) return;
      e.preventDefault();
      e.stopPropagation();
      this.anim = null;
      this.lockTilt();
      const r = canvas.getBoundingClientRect();
      this.ptr.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(this.ptr, this.camera);
      if (!this.ray.ray.intersectPlane(this.groundPlane, this.zoomPt) || this.zoomPt.distanceTo(this.camera.position) > this.controls.maxDistance * 3) this.zoomPt.copy(this.controls.target);
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1);
      this.zoomPending += clamp(dy, -240, 240) * 0.0016;
    }, { passive: false, capture: true });

    this.on(root, 'keydown', (e: KeyboardEvent) => {
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && document.activeElement !== q)) {
        if (this.opts?.panelShow) { e.preventDefault(); this.openSearch(); }
        return;
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') {
        const layers = this.$('.layers');
        if (!layers.hidden) layers.hidden = true; else this.closeCard();
      }
      if (e.key === '+' || e.key === '=') this.zoomBy(0.6);
      if (e.key === '-' || e.key === '_') this.zoomBy(1 / 0.6);
    });

    this.on(q, 'input', () => this.renderSearch());
    this.on(q, 'keydown', (e: KeyboardEvent) => {
      const side = this.$('.side'), list = this.$('.results');
      if (e.key === 'Escape') { q.value = ''; this.renderSearch(); q.blur(); if (root.classList.contains('narrow')) side.classList.remove('open'); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.qRows.length) {
        e.preventDefault();
        this.qSel = clamp(this.qSel + (e.key === 'ArrowDown' ? 1 : -1), 0, this.qRows.length - 1);
        list.querySelectorAll('button').forEach((b, i) => { b.setAttribute('aria-selected', String(i === this.qSel)); if (i === this.qSel) b.scrollIntoView({ block: 'nearest' }); });
      }
      if (e.key === 'Enter') this.choose(this.qRows[this.qSel]);
    });
    this.on(q, 'focus', () => this.$('.side').classList.add('open'));
    this.on(this.$('.handle'), 'click', () => this.$('.side').classList.toggle('open'));
    this.on(this.$('.b-search'), 'click', () => this.openSearch());

    this.on(this.$('.b-zin'), 'click', () => this.zoomBy(0.6));
    this.on(this.$('.b-zout'), 'click', () => this.zoomBy(1 / 0.6));
    this.on(this.$('.b-compass'), 'click', () => this.animateTo({ theta: 0 }, 600));
    this.on(this.$('.b-tilt'), 'click', () => { this.setTilt(!this.tilted); this.animateTo({ phi: this.tilted ? TILT3D : 0.0001 }, 700); });
    this.on(this.$('.b-home'), 'click', () => { this.closeCard(); this.setTilt(this.opts?.cameraTilt ?? true); this.animateTo(this.startView(), 1200); });
    const layersBtn = this.$('.b-layers'), layersEl = this.$('.layers');
    this.on(layersBtn, 'click', (e: Event) => { e.stopPropagation(); layersEl.hidden = !layersEl.hidden; layersBtn.setAttribute('aria-expanded', String(!layersEl.hidden)); });
    this.on(root, 'click', (e: Event) => {
      if (!layersEl.hidden && !(e.target as Element).closest('.layers,.b-layers')) { layersEl.hidden = true; layersBtn.setAttribute('aria-expanded', 'false'); }
    });
    layersEl.querySelectorAll<HTMLInputElement>('input').forEach((inp) => this.on(inp, 'change', () => {
      const k = inp.dataset.l as string;
      if (k === 'pillars') this.pillarsOn = inp.checked;
      else this.layerOverride[k as 'metro'] = inp.checked;
      this.applyLayers();
      this.pillarsDirty = true;
    }));
  }

  wake = (): void => { this.dirty = true; };

  /* ---------- loop ---------- */
  private camChanged(): boolean {
    const p = this.camera.position, q = this.camera.quaternion, t = this.controls.target;
    this.camNow.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, t.x, t.y, t.z]);
    this.camNow.set(this.camera.projectionMatrix.elements, 10);
    for (let i = 0; i < 26; i++) {
      if (Math.abs(this.camNow[i] - this.camSig[i]) > 1e-9) { this.camSig.set(this.camNow); return true; }
    }
    return false;
  }
  private trainsInView(): boolean {
    if (!this.layer('metro') || this.opts?.animation === false) return false;
    this.camera.updateMatrixWorld();
    this.pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    return this.metro.some((m) => m.train.children.some((car) => this.frustum.intersectsSphere(this.carS.set(car.position, m.car * 1.5))));
  }
  private updateOffset(): void {
    const desk = !this.root.classList.contains('narrow'), card = this.root.classList.contains('has-card'), side = !!this.opts?.panelShow;
    const tx = desk ? (-(side ? 364 : 0) + (card ? 384 : 0)) / 2 : 0;
    const ty = desk ? 0 : card ? this.H * 0.26 : side && !this.root.classList.contains('short') ? 60 : 0;
    this.off.x += (tx - this.off.x) * 0.12;
    this.off.y += (ty - this.off.y) * 0.12;
    if (Math.abs(this.off.x) < 0.5 && Math.abs(this.off.y) < 0.5 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5) {
      if (this.camera.view && this.camera.view.enabled) this.camera.clearViewOffset();
      return;
    }
    this.camera.setViewOffset(this.W, this.H, this.off.x, this.off.y, this.W, this.H);
  }
  // Runs every frame, but only touches the DOM on a change.
  private updateHud(d: number): void {
    const kmPerPx = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.H;
    let km = NICE[0];
    for (const n of NICE) if (n / kmPerPx <= 120) km = n;
    const w = (km / kmPerPx).toFixed(0) + 'px', t = km < 1 ? Math.round(km * 1000) + ' m' : km + ' km', r = `rotate(${this.controls.getAzimuthalAngle()}rad)`;
    if (w !== this.hud.w) this.$('.scale span').style.width = this.hud.w = w;
    if (t !== this.hud.t) this.$('.scale b').textContent = this.hud.t = t;
    if (r !== this.hud.r) this.$('.needle').style.transform = this.hud.r = r;
  }

  // Draw only when the picture can have changed: the camera moved, something changed, the selected pillar is pulsing
  // or a metro train is in view. Nothing is drawn while the loader still covers the map.
  private frame = (now: number): void => {
    if (this.destroyed) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.stepAnim(now)) {
      this.stepZoom();
      this.controls.update();
      const t = this.controls.target, B = this.bounds;
      const cx = clamp(t.x, B.x0, B.x1), cz = clamp(t.z, B.z0, B.z1);
      if (cx !== t.x || cz !== t.z) { this.camera.position.x += cx - t.x; this.camera.position.z += cz - t.z; t.set(cx, 0, cz); }
    }
    const d = this.camera.position.distanceTo(this.controls.target);
    this.updateMetro(d, dt);
    this.updateOffset();
    if (this.ready) {
      const moved = this.camChanged(), trains = this.trainsInView();
      const pulsing = !!this.selected && this.opts?.animation !== false;
      if (this.pillarsDirty || pulsing || moved) this.syncPillars(now, d);
      if (this.dirty || moved || pulsing || trains || this.trainsSeen) this.renderer.render(this.scene, this.camera);
      if (this.dirty || moved || this.labelsDirty) this.updateLabels(d);
      this.updateHud(d);
      this.dirty = false;
      this.trainsSeen = trains;
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
