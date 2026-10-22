import type { MapPoint, ParsedData } from './query';

/* ---------- pillar height ---------- */
export const MAX_H = 0.88;
export const MIN_H = 0.012;
export type HeightScale = 'linear' | 'sqrt' | 'log';

// Linear from zero by default: the largest value reaches MAX_H. Tiny non-zero values are lifted to MIN_H (a floor,
// not a shifted zero). Null means no pillar; zero and negative values get a ground ring only.
export function heightFn(values: (number | null)[], scale: HeightScale, fixedMax: number | null): (v: number | null) => number | null {
  let max = fixedMax && fixedMax > 0 ? fixedMax : 0;
  if (!max) for (const v of values) if (v !== null && v > max) max = v;
  const f = scale === 'sqrt' ? Math.sqrt : scale === 'log' ? Math.log1p : (x: number) => x;
  const fMax = max > 0 ? f(max) : 0;
  return (v) => {
    if (v === null) return null;
    if (!(v > 0) || !(fMax > 0)) return 0;
    return Math.max(MIN_H, Math.min(1, f(v) / fMax) * MAX_H);
  };
}

/* ---------- colours ---------- */
// Categorical palettes offered by the editor's palette picker; unknown names fall back to DEFAULT.
const DEFAULT = ['#ec7f9f', '#8fb3ff', '#f29a5b', '#5cc8b8', '#e8c26a', '#b8d86b', '#c39bff', '#ff8a7a', '#6fd3ff', '#f5d76e', '#9be3a8', '#ffb3d9'];
export const PALETTES: Record<string, string[]> = {
  Default: DEFAULT,
  Set1: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999'],
  Set3: ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'],
  Paired: ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'],
  Spectrum: ['#ff5468', '#ff9f43', '#feca57', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#ff9ff3'],
  Plasma: ['#0d0887', '#5302a3', '#8b0aa5', '#b83289', '#db5c68', '#f48849', '#febd2a', '#f0f921'],
  Ocean: ['#023858', '#045a8d', '#0570b0', '#3690c0', '#74a9cf', '#a6bddb', '#d0d1e6', '#ece7f2']
};
export const DEFAULT_RANGE = [
  { color: '#3b5bdb', value: 0 },
  { color: '#e8c26a', value: 50 },
  { color: '#ff5468', value: 100 }
];

export interface ColorOptions {
  mode: 'slot' | 'measure' | 'single';
  source: 'hierarchy' | 'theme' | 'palette';
  palette: string;
  range: { color: string; value: number }[];
  single: string;
}
export interface LegendItem { key: string; label: string; color: string; count: number }
export interface Coloring {
  colorOf: (p: MapPoint) => string;
  legend: LegendItem[];
  gradient?: { min: string; max: string; stops: { color: string; value: number }[] };
}

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})/i.exec(h.trim());
  if (!m) {
    const rgb = /rgba?\(([^)]+)\)/i.exec(h);
    if (rgb) {
      const [r, g, b] = rgb[1].split(',').map((x) => parseFloat(x));
      return [r || 0, g || 0, b || 0];
    }
    return [255, 255, 255];
  }
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');

function rampColor(stops: { color: string; value: number }[], t: number): string {
  const s = [...stops].sort((a, b) => a.value - b.value);
  if (!s.length) return '#ffffff';
  const lo = s[0].value, hi = s[s.length - 1].value;
  const v = lo + (hi - lo) * Math.max(0, Math.min(1, t));
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i].value) {
      const a = s[i - 1], b = s[i], k = b.value === a.value ? 0 : (v - a.value) / (b.value - a.value);
      const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
      return rgbToHex(ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k);
    }
  }
  return s[s.length - 1].color;
}

export function buildColoring(parsed: ParsedData, o: ColorOptions, themeColors: string[]): Coloring {
  const points = parsed.points;
  const pal = (name: string): string[] => PALETTES[name] ?? PALETTES.Default;
  const listFor = (): string[] => {
    if (o.source === 'palette') return pal(o.palette);
    return themeColors.length ? themeColors : PALETTES.Default;
  };
  const numeric = (get: (p: MapPoint) => number | null | undefined, fmt: (v: number) => string): Coloring => {
    let min = Infinity, max = -Infinity;
    for (const p of points) {
      const v = get(p);
      if (v !== null && v !== undefined) { min = Math.min(min, v); max = Math.max(max, v); }
    }
    const stops = o.range?.length >= 2 ? o.range : DEFAULT_RANGE;
    const span = max - min;
    return {
      colorOf: (p) => {
        const v = get(p);
        if (v === null || v === undefined || !Number.isFinite(min)) return '#7d8796';
        return rampColor(stops, span > 0 ? (v - min) / span : 1);
      },
      legend: [],
      gradient: Number.isFinite(min) ? { min: fmt(min), max: fmt(max), stops: [...stops].sort((a, b) => a.value - b.value) } : undefined
    };
  };

  if (o.mode === 'measure') return numeric((p) => p.value, parsed.formatValue);
  const hasColorSlot = points.some((p) => p.colorKey !== undefined || p.colorValue !== undefined);
  if (o.mode === 'single' || !hasColorSlot) {
    const c = o.single || '#ff5468';
    return { colorOf: () => c, legend: [] };
  }
  if (parsed.colorNumeric) return numeric((p) => p.colorValue, parsed.formatColor);

  const list = listFor();
  const byKey = new Map<string, LegendItem>();
  for (const p of points) {
    const key = p.colorKey ?? '';
    let item = byKey.get(key);
    if (!item) {
      const fromHierarchy = o.source === 'hierarchy' ? p.colorHex : undefined;
      item = { key, label: p.colorLabel ?? key, color: fromHierarchy || '', count: 0 };
      byKey.set(key, item);
    }
    item.count++;
  }
  let i = 0;
  for (const item of byKey.values()) if (!item.color) item.color = list[i++ % list.length];
  return {
    colorOf: (p) => byKey.get(p.colorKey ?? '')?.color ?? list[0],
    legend: [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  };
}
