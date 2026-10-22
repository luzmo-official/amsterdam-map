import { formatter, getValueForFormatter } from '@luzmo/analytics-components-kit/utils';
import type { ItemQuery, ItemQueryDimension, ItemQueryMeasure, Slot } from '@luzmo/dashboard-contents-types';

export const ROW_CAP = 2000;
export const MAX_DETAILS = 8;

// Slot content as Luzmo sends it; older dashboards use set/column instead of datasetId/columnId.
export interface Content {
  datasetId?: string;
  columnId?: string;
  set?: string;
  column?: string;
  formulaId?: string;
  formula?: string;
  type?: string;
  subtype?: string;
  level?: number | null;
  aggregationFunc?: string;
  aggregationWeight?: { set?: string; column?: string; datasetId?: string; columnId?: string };
  label?: string | Record<string, string>;
  [key: string]: unknown;
}

const contentOf = (slots: Slot[] | undefined, name: string): Content[] =>
  ((slots ?? []).find((s) => s.name === name)?.content ?? []) as unknown as Content[];
const datasetOf = (c: Content): string | undefined => c.datasetId ?? c.set;
const columnOf = (c: Content): string | undefined => c.columnId ?? c.column;
export const isNumeric = (c: Content | undefined): boolean => !!c && (c.type === 'numeric' || (!!c.formulaId || !!c.formula) && c.type !== 'hierarchy' && c.type !== 'datetime');

function dimension(c: Content): ItemQueryDimension {
  return {
    dataset_id: datasetOf(c),
    column_id: columnOf(c),
    ...(c.level !== undefined && c.level !== null ? { level: c.level } : {})
  } as ItemQueryDimension;
}
function measure(c: Content, forceAggregation?: string): ItemQueryMeasure {
  const ref: Record<string, unknown> = { dataset_id: datasetOf(c) };
  if (c.formulaId) ref.formula_id = c.formulaId;
  else if (c.formula) ref.formula = c.formula;
  else ref.column_id = columnOf(c);
  const type = forceAggregation ?? c.aggregationFunc;
  if (type && !c.formulaId && !c.formula) {
    const agg: Record<string, unknown> = { type };
    const w = c.aggregationWeight;
    if (type === 'weightedaverage' && w) {
      agg.dataset_id = w.datasetId ?? w.set;
      agg.column_id = w.columnId ?? w.column;
    }
    ref.aggregation = agg;
  }
  return ref as unknown as ItemQueryMeasure;
}

/*
 * Row layout, fixed by the slot contents:
 *   dimensions: name, color (when categorical), text details
 *   measures:   latitude, longitude, measure, color (when numeric), numeric details
 * render() derives the same layout from the slots to read the rows.
 */
export interface Layout {
  name: Content;
  lat: Content;
  lng: Content;
  measure: Content;
  color?: Content;
  colorNumeric: boolean;
  details: { content: Content; numeric: boolean }[];
  idx: { name: number; color: number; lat: number; lng: number; measure: number; details: number[] };
}

export function layoutFor(slots: Slot[] | undefined): Layout | null {
  const [name] = contentOf(slots, 'name');
  const [lat, lng] = contentOf(slots, 'coordinates');
  const [m] = contentOf(slots, 'measure');
  if (!name || !lat || !lng || !m) return null;
  const [color] = contentOf(slots, 'color');
  const colorNumeric = isNumeric(color);
  const details = contentOf(slots, 'details').slice(0, MAX_DETAILS).map((content) => ({ content, numeric: isNumeric(content) }));
  const nDims = 1 + (color && !colorNumeric ? 1 : 0) + details.filter((d) => !d.numeric).length;
  let d = 1, k = nDims;
  const idx = { name: 0, color: -1, lat: k++, lng: k++, measure: k++, details: [] as number[] };
  if (color) idx.color = colorNumeric ? k++ : d++;
  for (const det of details) idx.details.push(det.numeric ? k++ : d++);
  return { name, lat, lng, measure: m, color, colorNumeric, details, idx };
}

export function buildQuery({ slots = [] }: { slots: Slot[] }): ItemQuery[] {
  const L = layoutFor(slots);
  if (!L) return [];
  const dimensions: ItemQueryDimension[] = [dimension(L.name)];
  const measures: ItemQueryMeasure[] = [measure(L.lat, 'average'), measure(L.lng, 'average'), measure(L.measure)];
  if (L.color) {
    if (L.colorNumeric) measures.push(measure(L.color));
    else dimensions.push(dimension(L.color));
  }
  for (const d of L.details) if (!d.numeric) dimensions.push(dimension(d.content));
  for (const d of L.details) if (d.numeric) measures.push(measure(d.content));
  // keeps the largest values when there are more rows than the cap
  const order = [{ ...measure(L.measure), order: 'desc' }] as unknown as ItemQuery['order'];
  return [{ dimensions, measures, order, limit: { by: ROW_CAP, offset: 0 } } as ItemQuery];
}

/* ---------- reading rows ---------- */
export interface Detail { label: string; text: string; href?: string }
export interface MapPoint {
  key: string;
  label: string;
  lat: number;
  lng: number;
  value: number | null;
  valueText: string;
  colorKey?: string;
  colorLabel?: string;
  colorValue?: number | null;
  colorHex?: string;
  details: Detail[];
}
export interface ParsedData {
  points: MapPoint[];
  measureLabel: string;
  colorLabel: string;
  colorNumeric: boolean;
  noCoords: number;
  capped: boolean;
  formatValue: (v: number) => string;
  formatColor: (v: number) => string;
}

export function labelOf(c: Content | undefined, language: string): string {
  if (!c) return '';
  const l = c.label;
  if (!l) return '';
  if (typeof l === 'string') return l;
  return l[language] ?? l.en ?? Object.values(l)[0] ?? '';
}

function textOf(raw: unknown, language: string): string {
  if (raw && typeof raw === 'object') {
    const o = raw as { id?: unknown; name?: unknown };
    if (o.name && typeof o.name === 'object') {
      const n = o.name as Record<string, string>;
      return n[language] ?? n.en ?? Object.values(n)[0] ?? String(o.id ?? '');
    }
    if (o.name !== undefined && o.name !== null) return String(o.name);
    return o.id !== undefined && o.id !== null ? String(o.id) : '';
  }
  return raw === undefined || raw === null ? '' : String(raw);
}
const idOf = (raw: unknown): string => {
  if (raw && typeof raw === 'object' && 'id' in (raw as object)) return String((raw as { id: unknown }).id);
  return raw === undefined || raw === null ? '' : String(raw);
};
const colorOf = (raw: unknown): string | undefined =>
  raw && typeof raw === 'object' && typeof (raw as { color?: unknown }).color === 'string' ? (raw as { color: string }).color : undefined;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

type Fmt = (v: any) => string;
function safeFormatter(c: Content, language: string): Fmt {
  try {
    const f = formatter(c as any, { level: (c.level as number) || 9, locale: language } as any) as Fmt;
    return (v) => {
      try {
        const s = f(v);
        return s === undefined || s === null ? String(v) : String(s);
      } catch {
        return String(v);
      }
    };
  } catch {
    return (v) => (typeof v === 'number' ? v.toLocaleString(language) : String(v));
  }
}
function dimensionText(raw: unknown, c: Content, f: Fmt, language: string, timezoneId?: string): string {
  if (c.type === 'datetime') {
    const v = getValueForFormatter(raw as any, c as any, timezoneId as any) ?? raw;
    return f(v);
  }
  if (c.type === 'numeric') {
    const n = num(raw);
    return n === null ? '' : f(n);
  }
  return textOf(raw, language);
}

export function parseRows(data: unknown, slots: Slot[] | undefined, language = 'en', timezoneId?: string): ParsedData | null {
  const L = layoutFor(slots);
  if (!L) return null;
  const rows = (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][0]) ? data[0] : data) as unknown[][];
  const fValue = safeFormatter(L.measure, language);
  const fName = safeFormatter(L.name, language);
  const fColor = L.color ? safeFormatter(L.color, language) : fValue;
  const fDetails = L.details.map((d) => safeFormatter(d.content, language));
  const points: MapPoint[] = [];
  let noCoords = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const lat = num(row[L.idx.lat]), lng = num(row[L.idx.lng]);
    if (lat === null || lng === null || (lat === 0 && lng === 0)) { noCoords++; continue; }
    const rawName = row[L.idx.name];
    const value = num(row[L.idx.measure]);
    const p: MapPoint = {
      key: idOf(rawName),
      label: dimensionText(rawName, L.name, fName, language, timezoneId) || idOf(rawName),
      lat, lng, value,
      valueText: value === null ? '–' : fValue(value),
      colorHex: colorOf(rawName),
      details: []
    };
    if (L.color) {
      const raw = row[L.idx.color];
      if (L.colorNumeric) {
        p.colorValue = num(raw);
        p.colorLabel = p.colorValue === null ? '–' : fColor(p.colorValue);
      } else {
        p.colorKey = idOf(raw);
        p.colorLabel = dimensionText(raw, L.color, fColor, language, timezoneId) || p.colorKey || '–';
        p.colorHex = colorOf(raw);
      }
    }
    L.details.forEach((d, i) => {
      const raw = row[L.idx.details[i]];
      const text = d.numeric ? (num(raw) === null ? '' : fDetails[i](num(raw))) : dimensionText(raw, d.content, fDetails[i], language, timezoneId);
      if (!text) return;
      const detail: Detail = { label: labelOf(d.content, language) || `Detail ${i + 1}`, text };
      const plain = textOf(raw, language).trim();
      if (!d.numeric && /^https?:\/\/\S+$/i.test(plain)) detail.href = plain;
      p.details.push(detail);
    });
    points.push(p);
  }
  return {
    points,
    measureLabel: labelOf(L.measure, language) || 'Value',
    colorLabel: labelOf(L.color, language),
    colorNumeric: L.colorNumeric,
    noCoords,
    capped: (Array.isArray(rows) ? rows.length : 0) >= ROW_CAP,
    formatValue: (v) => fValue(v),
    formatColor: (v) => fColor(v)
  };
}
