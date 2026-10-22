import type { ItemThemeConfig, Slot, SlotConfig } from '@luzmo/dashboard-contents-types';
import { DEFAULT_RANGE, type HeightScale } from './encode';
import { AmsterdamMap, type MapOptions } from './map';
import { layoutFor, parseRows } from './query';

export { buildQuery } from './query';

interface ChartParams {
  container: HTMLElement;
  data: unknown;
  slots: Slot[];
  slotConfigurations: SlotConfig[];
  options: Record<string, any> & { theme?: ItemThemeConfig };
  timezoneId?: string;
  language: string;
  dimensions: { width: number; height: number };
}

// One map per container; render() creates or updates it and resize() resizes it.
const maps = new WeakMap<HTMLElement, AmsterdamMap>();
const lastParams = new WeakMap<HTMLElement, ChartParams>();

const get = (o: Record<string, any> | undefined, path: string): unknown =>
  path.split('.').reduce<any>((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const str = (o: Record<string, any>, path: string, def: string): string => {
  let v = get(o, path);
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = (v as Record<string, string>).en ?? Object.values(v)[0];
  return typeof v === 'string' ? v : def;
};
const bool = (o: Record<string, any>, path: string, def: boolean): boolean => {
  const v = get(o, path);
  return typeof v === 'boolean' ? v : def;
};
const num = (o: Record<string, any>, path: string, def: number): number => {
  const raw = get(o, path);
  const v = Number(raw);
  return raw !== null && raw !== '' && raw !== undefined && Number.isFinite(v) ? v : def;
};
function pick<T extends string>(o: Record<string, any>, path: string, allowed: readonly T[], def: T): T {
  const v = str(o, path, def);
  return (allowed as readonly string[]).includes(v) ? (v as T) : def;
}
const localized = (o: Record<string, any>, path: string, language: string): string => {
  const v = get(o, path);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const m = v as Record<string, string>;
    return m[language] ?? m.en ?? Object.values(m)[0] ?? '';
  }
  return typeof v === 'string' ? v : '';
};

export function readOptions(o: Record<string, any> = {}, language = 'en'): MapOptions {
  const range = get(o, 'color.range');
  const themeColors = ((o.theme as ItemThemeConfig | undefined)?.colors ?? []).filter((c): c is string => typeof c === 'string' && !!c);
  const fixed = num(o, 'height.fixedMax', 0);
  return {
    panelShow: bool(o, 'panel.show', false),
    panelTitle: localized(o, 'panel.title', language),
    panelSubtitle: localized(o, 'panel.subtitle', language),
    heightScale: pick<HeightScale>(o, 'height.scale', ['linear', 'sqrt', 'log'], 'linear'),
    heightMax: pick(o, 'height.max', ['auto', 'fixed'] as const, 'auto') === 'fixed' && fixed > 0 ? fixed : null,
    color: {
      mode: pick(o, 'color.mode', ['slot', 'measure', 'single'] as const, 'slot'),
      source: pick(o, 'color.source', ['hierarchy', 'theme', 'palette'] as const, 'hierarchy'),
      palette: str(o, 'color.palette', 'Set1'),
      range: Array.isArray(range) && range.length >= 2 ? range : DEFAULT_RANGE,
      single: str(o, 'color.single', '#ff5468')
    },
    labelDensity: pick(o, 'labels.density', ['none', 'top', 'all'] as const, 'top'),
    labelTopN: num(o, 'labels.topN', 12),
    labelValue: bool(o, 'labels.value', true),
    cardRank: bool(o, 'card.rank', true),
    rankOrder: pick(o, 'rank.order', ['desc', 'asc'] as const, 'desc'),
    cardLinkText: localized(o, 'card.linkText', language) || 'Open link',
    cardNote: localized(o, 'card.note', language),
    footerSource: localized(o, 'footer.source', language),
    cameraStart: pick(o, 'camera.start', ['fit', 'city', 'centrum'] as const, 'fit'),
    cameraTilt: bool(o, 'camera.tilt', true),
    filter: bool(o, 'interaction.filter', true),
    metro: bool(o, 'map.metro', true),
    streets: bool(o, 'map.streets', true),
    districts: bool(o, 'map.districts', true),
    trees: bool(o, 'map.trees', true),
    animation: bool(o, 'map.animation', true),
    themeColors
  };
}

function mapFor(container: HTMLElement): AmsterdamMap {
  let map = maps.get(container);
  if (!map) {
    const created: AmsterdamMap = new AmsterdamMap(container, () => {
      // A lost GPU context can't be rebuilt in place: replace this map with a fresh one and redraw it.
      if (maps.get(container) !== created) return;
      created.destroy();
      maps.delete(container);
      const p = lastParams.get(container);
      if (p) render(p);
    });
    maps.set(container, created);
    map = created;
  }
  return map;
}

export const render = (params: ChartParams): void => {
  const { container, data = [], slots = [], options = {}, timezoneId, language = 'en', dimensions } = params;
  lastParams.set(container, params);
  const map = mapFor(container);
  map.resize(dimensions?.width, dimensions?.height);
  map.update({
    parsed: parseRows(data, slots, language, timezoneId),
    nameContent: layoutFor(slots)?.name,
    options: readOptions(options, language)
  });
};

export const resize = (params: ChartParams): void => {
  const { container, dimensions } = params;
  const prev = lastParams.get(container);
  lastParams.set(container, { ...(prev ?? params), dimensions });
  const map = maps.get(container);
  if (!map) {
    render(params);
    return;
  }
  map.resize(dimensions?.width, dimensions?.height);
};
