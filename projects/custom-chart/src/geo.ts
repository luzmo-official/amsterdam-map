import * as THREE from 'three';

/* WGS84 → RD New (EPSG:28992) → scene km, origin at the Dam, north = -z */
export function rd(lat: number, lng: number): [number, number] {
  const p = 0.36 * (lat - 52.1551744), l = 0.36 * (lng - 5.38720621);
  const X = 155000 + 190094.945 * l - 11832.228 * p * l - 114.221 * p * p * l - 32.391 * l ** 3 - 0.705 * p - 2.34 * p ** 3 * l - 0.608 * p * l ** 3 + 0.008 * l * l + 0.148 * p * p * l ** 3;
  const Y = 463000 + 309056.544 * p + 3638.893 * l * l + 73.077 * p * p - 157.984 * p * l * l + 59.788 * p ** 3 + 0.433 * l - 6.439 * p * p * l * l - 0.032 * p * l + 0.092 * l ** 4 - 0.054 * p * l ** 4;
  return [X, Y];
}

const [X0, Y0] = rd(52.3731, 4.8926);
export const sxz = (X: number, Y: number): [number, number] => [(X - X0) / 1000, -(Y - Y0) / 1000];
export const xz = (lat: number, lng: number): [number, number] => {
  const r = rd(lat, lng);
  return sxz(r[0], r[1]);
};
export const V3 = (lat: number, lng: number, y = 0): THREE.Vector3 => {
  const p = xz(lat, lng);
  return new THREE.Vector3(p[0], y, p[1]);
};

// The 3D city covers this RD New square (14 × 14 km). Points outside it are dropped.
export const AREA = { x0: 115000, x1: 129000, y0: 479000, y1: 493000 };
export const inArea = (lat: number, lng: number): boolean => {
  const [X, Y] = rd(lat, lng);
  return X >= AREA.x0 && X <= AREA.x1 && Y >= AREA.y0 && Y <= AREA.y1;
};

export const clamp = THREE.MathUtils.clamp;
export const hash = (n: number): number => {
  n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
};
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
