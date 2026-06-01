export function safeCompare(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function normalizePhone(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length === 8) return d;
  if (d.length === 11 && d.startsWith('961')) return d.slice(3);
  return '';
}

export function priceNumber(price) {
  const n = Number(String(price || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function cleanText(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function publicConfig(value, isAdmin = false, pinAvailable = false) {
  const clean = { ...(value || {}) };
  const pinSet = !!(clean.driverPinHash || pinAvailable);
  delete clean.driverPin;
  delete clean.driverPinHash;
  if (isAdmin) clean.driverPinSet = pinSet;
  return clean;
}

const CENTER_LAT = 33.821091538427524;
const CENTER_LNG = 35.56496110422372;
const ZONE_A_RADIUS_KM = 0.60;
const ZONE_B_LAT_SEMI = 0.010;
const ZONE_B_LNG_SEMI = 0.022;
const ZONE_C_POLYGON = [
  [33.870,35.535],[33.867,35.558],[33.862,35.590],
  [33.848,35.608],[33.825,35.622],[33.808,35.610],
  [33.792,35.590],[33.785,35.555],[33.787,35.520],
  [33.797,35.502],[33.816,35.490],[33.835,35.492],
  [33.843,35.542],[33.858,35.542],[33.864,35.538],
];

function distKm(a, b, c, d) {
  const R = 6371, dL = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
  const x = Math.sin(dL / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function inEllipse(la, ln, cL, cN, lS, nS) {
  return ((la - cL) / lS) ** 2 + ((ln - cN) / nS) ** 2 <= 1;
}

function pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = [poly[i][0], poly[i][1]], [xj, yj] = [poly[j][0], poly[j][1]];
    if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function deliveryZoneForPoint(point) {
  if (!point) return null;
  const d = distKm(point.lat, point.lng, CENTER_LAT, CENTER_LNG);
  if (d <= ZONE_A_RADIUS_KM) return { label: 'Zone A', fee: 0.5 };
  if (inEllipse(point.lat, point.lng, CENTER_LAT, CENTER_LNG, ZONE_B_LAT_SEMI, ZONE_B_LNG_SEMI)) return { label: 'Zone B', fee: 1 };
  if (pointInPolygon(point.lat, point.lng, ZONE_C_POLYGON)) return { label: 'Zone C', fee: 1.5 };
  return { label: 'Outside delivery area', fee: 0, outside: true };
}
