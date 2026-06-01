const GH_OWNER = 'joetheproz5';
const GH_REPO  = 'le-kiosk-menu';
const GH_API   = 'https://api.github.com';
const RATE_BUCKETS = globalThis.__LK_RATE_BUCKETS || (globalThis.__LK_RATE_BUCKETS = new Map());

const ALLOWED_ORIGINS = [
  'https://lekiosk.store',
  'https://www.lekiosk.store',
  'https://joetheproz5.github.io',
];

const ALLOWED_FILES = ['orders.json','inbox.json','menu.json','blocklist.json','customers.json','config.json'];

function wsAccessToken(request, url) {
  const protocols = String(request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(p => p.trim());
  const tokenProtocol = protocols.find(p => p.startsWith('lk-token-'));
  return tokenProtocol ? tokenProtocol.slice('lk-token-'.length) : '';
}

function wsSelectedProtocol(request) {
  return String(request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(p => p.trim())
    .find(p => p.startsWith('lk-token-')) || '';
}

function safeCompare(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export class OrderRoom {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Keep one live socket per role and close stale sockets for this order.
    const old = this.sessions.get(role);
    if (old) {
      try { old.close(1000, 'replaced'); } catch (_) {}
    }
    this.sessions.set(role, server);

    server.addEventListener('message', (evt) => {
      // Driver messages are live map updates; forward them to the customer only.
      if (role === 'driver') {
        const customer = this.sessions.get('customer');
        if (customer && customer.readyState === 1) customer.send(evt.data);
      }
    });

    const cleanup = () => {
      if (this.sessions.get(role) === server) this.sessions.delete(role);
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    const selectedProtocol = wsSelectedProtocol(request);
    const init = { status: 101, webSocket: client };
    if (selectedProtocol) init.headers = { 'Sec-WebSocket-Protocol': selectedProtocol };
    return new Response(null, init);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOk = ALLOWED_ORIGINS.includes(origin);
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOk ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Setup-Key, X-Backup-Key, X-Driver-Pin, X-Driver-Token, X-Track-Token',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=()',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── WebSocket /ws/:orderId — real-time driver map updates via Durable Object ──
    if (url.pathname.startsWith('/ws/')) {
      const orderId = url.pathname.split('/')[2];
      if (!orderId) return new Response('Missing order id', { status: 400, headers: corsHeaders });
      const role = url.searchParams.get('role');
      if (!['customer', 'driver'].includes(role)) {
        return new Response('Invalid role', { status: 400, headers: corsHeaders });
      }

      const token = wsAccessToken(request, url);
      const orderRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=payload&limit=1`,
        {
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const rows = orderRes.ok ? await orderRes.json().catch(() => []) : [];
      const payload = Array.isArray(rows) && rows.length ? (rows[0].payload || {}) : null;
      if (!payload) return new Response('Order not found', { status: 404, headers: corsHeaders });
      const access = payload.access || {};
      const expected = role === 'driver' ? access.driverToken : access.customerToken;
      if (!expected || !token || !safeCompare(token, expected)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      const id = env.ORDER_ROOM.idFromName(orderId);
      const room = env.ORDER_ROOM.get(id);
      return room.fetch(request);
    }

    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'LeKiosk-Worker/1.0',
    };

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    function b64decode(b64) {
      const bin = atob(b64.replace(/\n/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }

    function b64encode(str) {
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }

    async function supabaseFetch(path, options = {}) {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
        ...options,
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
          ...(options.headers || {}),
        },
      });

      const text = await res.text();
      const data = text ? JSON.parse(text) : null;

      if (!res.ok) {
        throw new Error(data?.message || data?.error || `Supabase ${res.status}`);
      }

      return data;
    }

    async function supabaseUploadImage(path, bytes, contentType, env) {
      const res = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/menu-images/${path}`,
        {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': contentType,
            'x-upsert': 'true',
          },
          body: bytes,
        }
      );

      const text = await res.text();
      const data = text ? JSON.parse(text) : null;

      if (!res.ok) {
        throw new Error(data?.message || data?.error || `Storage ${res.status}`);
      }

      return data;
    }

    // ── Staff auth helpers ──
    const PBKDF2_ITERATIONS = 100000;
    const SESSION_HOURS = 6;

    function bytesToB64(bytes) {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }

    function b64ToBytes(b64) {
      const bin = atob(b64);
      return Uint8Array.from(bin, c => c.charCodeAt(0));
    }

    function randomB64(len = 32) {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      return bytesToB64(bytes);
    }

    async function sha256Hex(text) {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function passwordHash(password, saltB64) {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
      );

      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: b64ToBytes(saltB64),
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256',
        },
        key,
        256
      );

      return bytesToB64(new Uint8Array(bits));
    }

    function safeEqual(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      let out = 0;
      for (let i = 0; i < a.length; i++) {
        out |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      return out === 0;
    }

    function bearerToken(request) {
      const header = request.headers.get('Authorization') || '';
      return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    }

    async function requireAuth(request, roles = []) {
      const token = bearerToken(request);

      if (!token) {
        throw json({ error: 'Auth required' }, 401);
      }

      const tokenHash = await sha256Hex(token);

      const rows = await supabaseFetch(
        `/staff_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=*`
      );

      const session = Array.isArray(rows) && rows.length ? rows[0] : null;

      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        throw json({ error: 'Session expired' }, 401);
      }

      if (roles.length && !roles.includes(session.role)) {
        throw json({ error: 'Forbidden' }, 403);
      }

      return session;
    }

    async function guard(roles) {
      try {
        return await requireAuth(request, roles);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }
    }

    function cleanPoint(point) {
      if (!point) return null;

      if (Array.isArray(point) && point.length >= 2) {
        const lat = Number(point[0]);
        const lng = Number(point[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      }

      if (typeof point === 'object') {
        const lat = Number(point.lat ?? point.latitude);
        const lng = Number(point.lng ?? point.lon ?? point.long ?? point.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      }

      return null;
    }

    function pointFromText(text) {
      const raw = String(text || '');
      const match = raw.match(/(?:q=|@)?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (!match) return null;
      const lat = Number(match[1]);
      const lng = Number(match[2]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    function customerGPS(payload) {
      if (!payload || typeof payload !== 'object') return null;

      return cleanPoint(payload.gps)
        || cleanPoint(payload.customerGps)
        || cleanPoint(payload.customerGPS)
        || cleanPoint(payload.customerLocation)
        || cleanPoint(payload.deliveryLocation)
        || cleanPoint(payload.location)
        || cleanPoint(payload.coordinates)
        || cleanPoint(payload.coords)
        || cleanPoint(payload.tracking && payload.tracking.customerLocation)
        || pointFromText(payload.mapUrl)
        || pointFromText(payload.locationUrl)
        || pointFromText(payload.address)
        || pointFromText(payload.note);
    }

    function clientIp() {
      return request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')
        || 'unknown';
    }

    function rateLimit(name, limit, windowMs) {
      const key = `${name}:${clientIp()}`;
      const now = Date.now();
      const bucket = RATE_BUCKETS.get(key) || { count: 0, reset: now + windowMs };
      if (bucket.reset <= now) {
        bucket.count = 0;
        bucket.reset = now + windowMs;
      }
      bucket.count++;
      RATE_BUCKETS.set(key, bucket);
      if (bucket.count > limit) {
        return json({ error: 'Too many requests. Try again soon.' }, 429);
      }
      if (RATE_BUCKETS.size > 1000) {
        for (const [k, v] of RATE_BUCKETS) if (v.reset <= now) RATE_BUCKETS.delete(k);
      }
      return null;
    }

    async function siteConfigRaw() {
      const rows = await supabaseFetch('/app_config?key=eq.site_settings&select=*').catch(() => []);
      const row = Array.isArray(rows) && rows.length ? rows[0] : null;
      return row && row.value && typeof row.value === 'object' ? row.value : {};
    }

    function publicConfig(value, isAdmin = false) {
      const clean = { ...(value || {}) };
      const pinSet = !!(clean.driverPinHash || env.DRIVER_PIN || env.DRIVER_PIN_HASH);
      delete clean.driverPin;
      delete clean.driverPinHash;
      if (isAdmin) clean.driverPinSet = pinSet;
      return clean;
    }

    function backupKeyOk(request) {
      const key = request.headers.get('X-Backup-Key') || '';
      return !!(env.BACKUP_KEY && safeCompare(key, env.BACKUP_KEY));
    }

    function backupDateKey() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Beirut',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    }

    function b64url(bytes) {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    async function hmacSign(text, secret) {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
      return b64url(new Uint8Array(sig));
    }

    async function driverAppToken(expiresAtMs) {
      if (!env.APP_DOWNLOAD_SECRET) throw new Error('Missing APP_DOWNLOAD_SECRET Worker secret');
      const exp = String(expiresAtMs);
      return `${exp}.${await hmacSign(exp, env.APP_DOWNLOAD_SECRET)}`;
    }

    async function verifyDriverAppToken(token) {
      if (!env.APP_DOWNLOAD_SECRET) return false;
      const [exp, sig] = String(token || '').split('.');
      const expMs = Number(exp);
      if (!exp || !sig || !Number.isFinite(expMs) || expMs <= Date.now()) return false;
      const expected = await hmacSign(exp, env.APP_DOWNLOAD_SECRET);
      return safeEqual(sig, expected);
    }

    async function signedDriverApkUrl() {
      const bucket = env.DRIVER_APK_BUCKET || 'driver-apps';
      const path = env.DRIVER_APK_PATH || 'le-kiosk-driver.apk';
      const res = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: 15 * 60 }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.signedURL) {
        throw new Error(data.message || data.error || `Driver APK signing failed ${res.status}`);
      }
      return `${env.SUPABASE_URL}/storage/v1${data.signedURL}`;
    }

    function beirutHour() {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Beirut',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      return Number(parts.find(p => p.type === 'hour')?.value || 0);
    }

    function storeIsOpen(cfg) {
      if (cfg.testingMode) return true;
      const h = beirutHour();
      return h >= 18 || h < 1;
    }

    function normalizePhone(value) {
      const d = String(value || '').replace(/\D/g, '');
      if (d.length === 8) return d;
      if (d.length === 11 && d.startsWith('961')) return d.slice(3);
      return '';
    }

    function priceNumber(price) {
      const n = Number(String(price || '').replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }

    function money(price) {
      return `$${Number(price || 0).toFixed(2).replace(/\.00$/, '')}`;
    }

    function cleanText(value, max = 160) {
      return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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

    function deliveryZoneForPoint(point) {
      if (!point) return null;
      const d = distKm(point.lat, point.lng, CENTER_LAT, CENTER_LNG);
      if (d <= ZONE_A_RADIUS_KM) return { label: 'Zone A', fee: 0.5 };
      if (inEllipse(point.lat, point.lng, CENTER_LAT, CENTER_LNG, ZONE_B_LAT_SEMI, ZONE_B_LNG_SEMI)) return { label: 'Zone B', fee: 1 };
      if (pointInPolygon(point.lat, point.lng, ZONE_C_POLYGON)) return { label: 'Zone C', fee: 1.5 };
      return { label: 'Outside delivery area', fee: 0, outside: true };
    }

    async function menuProducts() {
      const products = await supabaseFetch('/products?select=*&active=eq.true&order=sort_order.asc');
      return Array.isArray(products) ? products : [];
    }

    function findProduct(products, item) {
      const categoryKey = String(item.categoryKey || item.catKey || item.category || '').trim();
      const name = String(item.name || '').trim().toLowerCase();
      if (categoryKey) {
        return products.find(p => String(p.category_key || '') === categoryKey && String(p.name || '').trim().toLowerCase() === name);
      }
      return products.find(p => String(p.name || '').trim().toLowerCase() === name);
    }

    function cleanPublicOrder(order, products) {
      const phone = normalizePhone(order.phone);
      if (!phone) throw new Error('Invalid phone number');

      const orderType = ['dinein', 'takeaway', 'delivery'].includes(order.orderType) ? order.orderType : '';
      if (!orderType) throw new Error('Invalid order type');

      const submitted = Array.isArray(order.items) ? order.items : [];
      if (!submitted.length || submitted.length > 40) throw new Error('Invalid order items');

      let total = 0;
      const items = submitted.map(raw => {
        const product = findProduct(products, raw);
        if (!product) throw new Error(`Unavailable item: ${cleanText(raw.name, 80) || 'unknown'}`);
        const qty = Math.max(1, Math.min(50, Number(raw.qty || 1) || 1));
        const productAddons = Array.isArray(product.addons) ? product.addons : [];
        const submittedAddons = Array.isArray(raw.addons) ? raw.addons : [];
        const addons = submittedAddons.map(a => {
          const label = String(a.label || a.name || '').trim();
          const match = productAddons.find(pa => String(pa.label || pa.name || '').trim().toLowerCase() === label.toLowerCase());
          if (!match) throw new Error(`Unavailable add-on: ${label}`);
          return {
            label: String(match.label || match.name || label),
            price: priceNumber(match.price),
          };
        });

        for (const required of productAddons.filter(a => a.required)) {
          const label = String(required.label || required.name || '').trim().toLowerCase();
          if (!addons.some(a => String(a.label || '').trim().toLowerCase() === label)) {
            throw new Error(`Required add-on missing: ${required.label || required.name}`);
          }
        }

        const flavors = Array.isArray(product.flavors) ? product.flavors.map(String) : [];
        const flavor = raw.flavor && flavors.includes(String(raw.flavor)) ? String(raw.flavor) : null;
        const price = priceNumber(product.price);
        total += (price + addons.reduce((sum, a) => sum + priceNumber(a.price), 0)) * qty;
        return {
          categoryKey: product.category_key || raw.categoryKey || '',
          name: product.name,
          price,
          priceStr: product.price || money(price),
          qty,
          flavor,
          addons,
        };
      });

      const gps = customerGPS(order);
      let deliveryFee = 0;
      let deliveryZone = null;
      if (orderType === 'delivery') {
        const zone = deliveryZoneForPoint(gps);
        if (!zone || zone.outside) throw new Error('Delivery location is outside our delivery area');
        deliveryFee = zone.fee;
        deliveryZone = zone.label;
        total += deliveryFee;
      }

      const access = {
        customerToken: randomB64(24).replace(/[+/=]/g, ''),
        driverToken: randomB64(24).replace(/[+/=]/g, ''),
      };
      const tableNumber = cleanText(order.tableNumber, 12).replace(/[^a-zA-Z0-9_-]/g, '');

      return {
        id: `MENU-${crypto.randomUUID()}`,
        status: 'inbox',
        timestamp: new Date().toISOString(),
        source: tableNumber ? 'table-qr' : 'menu',
        name: cleanText(order.name, 80) || 'Guest',
        phone,
        orderType,
        deliveryZone,
        deliveryFee,
        gps: gps || null,
        address: orderType === 'delivery' ? (cleanText(order.address || order.note, 240) || null) : null,
        tableNumber: tableNumber || null,
        tableLabel: tableNumber ? (cleanText(order.tableLabel, 40) || `Table ${tableNumber}`) : null,
        note: cleanText(order.note, 240) || null,
        changeFor: Math.max(0, Math.min(100, Number(order.changeFor || 0) || 0)) || null,
        items,
        total: Number(total.toFixed(2)),
        access,
      };
    }

    async function driverPinHash(cfg) {
      if (cfg.driverPinHash) return String(cfg.driverPinHash);
      if (env.DRIVER_PIN_HASH) return String(env.DRIVER_PIN_HASH);
      if (env.DRIVER_PIN) return sha256Hex(String(env.DRIVER_PIN));
      return '';
    }

    async function driverPinOk(pin, cfg) {
      const hash = await driverPinHash(cfg);
      if (!hash) return false;
      return safeEqual(await sha256Hex(String(pin || '')), hash);
    }

    async function requireDriverPin(request, cfg) {
      const pin = request.headers.get('X-Driver-Pin') || url.searchParams.get('pin') || '';
      if (await driverPinOk(pin, cfg)) return true;
      throw json({ error: 'Driver PIN required' }, 403);
    }

    function trackTokenFromRequest(request) {
      return request.headers.get('X-Track-Token') || '';
    }

    function driverTokenFromRequest(request, body = null) {
      return request.headers.get('X-Driver-Token') || (body && body.token) || '';
    }

    function requireTrackAccess(payload, request) {
      const expected = payload?.access?.customerToken;
      const token = trackTokenFromRequest(request);
      if (!expected || !token || !safeEqual(token, expected)) {
        throw json({ error: 'Invalid tracking link' }, 403);
      }
    }

    async function requireDriverOrderAccess(payload, request, cfg, body = null) {
      const expected = payload?.access?.driverToken;
      const token = driverTokenFromRequest(request, body);
      if (expected && safeEqual(token, expected)) return true;
      if (await driverPinOk(request.headers.get('X-Driver-Pin') || url.searchParams.get('pin') || (body && body.pin), cfg)) return true;
      throw json({ error: 'Driver PIN or token required' }, 403);
    }

    function ensureOrderAccess(order) {
      if (!order || typeof order !== 'object') return order;
      const access = order.access && typeof order.access === 'object' ? { ...order.access } : {};
      if (!access.customerToken) access.customerToken = randomB64(24).replace(/[+/=]/g, '');
      if (!access.driverToken) access.driverToken = randomB64(24).replace(/[+/=]/g, '');
      order.access = access;
      return order;
    }

    // ── POST /auth/setup — create/reset staff accounts ──
    // ── POST /auth/setup — create/reset staff accounts ──
if (request.method === 'POST' && url.pathname === '/auth/setup') {
  const limited = rateLimit('auth-setup', 5, 15 * 60 * 1000);
  if (limited) return limited;
  try {
    if (!env.AUTH_SETUP_KEY || !safeCompare(request.headers.get('X-Setup-Key') || '', env.AUTH_SETUP_KEY)) {
      return json({ error: 'Forbidden' }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '').trim().toLowerCase();

    if (!username || password.length < 8 || !['admin', 'pos'].includes(role)) {
      return json({ error: 'Need username, role, and password with at least 8 chars' }, 400);
    }

    const salt = randomB64(16);
    const hash = await passwordHash(password, salt);

    const data = await supabaseFetch('/staff_accounts?on_conflict=username', {
      method: 'POST',
      headers: {
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        username,
        role,
        password_salt: salt,
        password_hash: hash,
        active: true,
        updated_at: new Date().toISOString(),
      }),
    });

    return json({ ok: true, data });
  } catch (e) {
    return json({
      error: e.message || String(e),
      where: 'auth_setup'
    }, 500);
  }
}

    // ── POST /auth/login ──
    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const limited = rateLimit('auth-login', 12, 5 * 60 * 1000);
      if (limited) return limited;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const requestedRole = String(body.role || '').trim().toLowerCase();

      const rows = await supabaseFetch(
        `/staff_accounts?username=eq.${encodeURIComponent(username)}&active=eq.true&select=*`
      );

      const account = Array.isArray(rows) && rows.length ? rows[0] : null;

      if (!account || (requestedRole && account.role !== requestedRole)) {
        return json({ error: 'Invalid login' }, 401);
      }

      const hash = await passwordHash(password, account.password_salt);

      if (!safeEqual(hash, account.password_hash)) {
        return json({ error: 'Invalid login' }, 401);
      }

      const token = randomB64(32);
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();

      await supabaseFetch('/staff_sessions', {
        method: 'POST',
        body: JSON.stringify({
          token_hash: tokenHash,
          account_id: account.id,
          role: account.role,
          expires_at: expiresAt,
        }),
      });

      await supabaseFetch(`/staff_accounts?id=eq.${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          last_login_at: new Date().toISOString(),
        }),
      });

      return json({
        ok: true,
        token,
        role: account.role,
        username: account.username,
        expiresAt,
      });
    }

    // ── GET /auth/me ──
    if (request.method === 'GET' && url.pathname === '/auth/me') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;
      const session = blocked;

      try {
        const rows = await supabaseFetch(`/staff_accounts?id=eq.${encodeURIComponent(session.account_id)}&select=id,username,role,active,last_login_at,updated_at&limit=1`);
        const account = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!account || account.active === false) return json({ error: 'Account disabled' }, 403);
        return json({ account });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /auth/password ──
    if (request.method === 'POST' && url.pathname === '/auth/password') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;
      const session = blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!currentPassword || newPassword.length < 8) {
        return json({ error: 'Current password and a new password with at least 8 chars are required' }, 400);
      }

      try {
        const rows = await supabaseFetch(`/staff_accounts?id=eq.${encodeURIComponent(session.account_id)}&active=eq.true&select=*`);
        const account = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!account) return json({ error: 'Account not found' }, 404);

        const currentHash = await passwordHash(currentPassword, account.password_salt);
        if (!safeEqual(currentHash, account.password_hash)) {
          return json({ error: 'Current password is wrong' }, 400);
        }

        const salt = randomB64(16);
        const hash = await passwordHash(newPassword, salt);
        await supabaseFetch(`/staff_accounts?id=eq.${encodeURIComponent(session.account_id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            password_salt: salt,
            password_hash: hash,
            updated_at: new Date().toISOString(),
          }),
        });
        await supabaseFetch(`/staff_sessions?account_id=eq.${encodeURIComponent(session.account_id)}`, { method: 'DELETE' }).catch(() => {});
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /auth/accounts ──
    if (request.method === 'GET' && url.pathname === '/auth/accounts') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      try {
        const rows = await supabaseFetch('/staff_accounts?select=id,username,role,active,last_login_at,updated_at&order=username.asc');
        return json({ data: rows });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /auth/accounts ──
    if (request.method === 'POST' && url.pathname === '/auth/accounts') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;
      const session = blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      let role = String(body.role || '').trim().toLowerCase();
      if (!['admin', 'pos'].includes(role)) role = 'pos';

      if (!/^[a-z0-9._-]{3,32}$/.test(username) || password.length < 8) {
        return json({ error: 'Username must be 3-32 simple characters and password at least 8 chars' }, 400);
      }

      try {
        const existing = await supabaseFetch(`/staff_accounts?username=eq.${encodeURIComponent(username)}&select=id&limit=1`);
        if (Array.isArray(existing) && existing.length) return json({ error: 'Username already exists' }, 409);

        const salt = randomB64(16);
        const hash = await passwordHash(password, salt);
        const data = await supabaseFetch('/staff_accounts', {
          method: 'POST',
          body: JSON.stringify({
            username,
            role,
            password_salt: salt,
            password_hash: hash,
            active: true,
            updated_at: new Date().toISOString(),
          }),
        });
        return json({ ok: true, data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /auth/logout ──
    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      const token = bearerToken(request);

      if (token) {
        const tokenHash = await sha256Hex(token);
        await supabaseFetch(
          `/staff_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`,
          { method: 'DELETE' }
        ).catch(() => {});
      }

      return json({ ok: true });
    }

    async function ghReadSha(file) {
      const res = await fetch(
        `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
        { headers: ghHeaders }
      );

      if (res.status === 404) return null;
      if (!res.ok) throw new Error('GH SHA read ' + res.status);

      const d = await res.json();
      return d.sha || null;
    }

    async function ghRead(file) {
      const res = await fetch(
        `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
        { headers: ghHeaders }
      );

      if (res.status === 404) return { data: [], sha: null };
      if (!res.ok) throw new Error('GH read ' + res.status);

      const d = await res.json();
      return { data: JSON.parse(b64decode(d.content)), sha: d.sha };
    }

    async function ghWrite(file, data, message) {
      const sha = await ghReadSha(file);
      const body = {
        message,
        content: b64encode(JSON.stringify(data, null, 2)),
      };

      if (sha) body.sha = sha;

      const res = await fetch(
        `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
        {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || res.status);
      }

      const saved = await res.json();
      return saved.content.sha;
    }

    async function ghWriteRaw(file, b64content, message) {
      const sha = await ghReadSha(file);
      const body = { message, content: b64content };

      if (sha) body.sha = sha;

      const res = await fetch(
        `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
        {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || res.status);
      }

      const saved = await res.json();
      return saved.content.sha;
    }

    // ── POST /supabase/blocklist/check — public, returns only yes/no ──
    if (request.method === 'POST' && url.pathname === '/supabase/blocklist/check') {
      const limited = rateLimit('block-check', 80, 60 * 1000);
      if (limited) return limited;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const phone = normalizePhone(body.phone);
      if (!phone) return json({ blocked: false });
      try {
        const rows = await supabaseFetch(`/blocklist?phone=eq.${encodeURIComponent(phone)}&select=phone&limit=1`);
        return json({ blocked: Array.isArray(rows) && rows.length > 0 });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/blocklist — admin only ──
    if (request.method === 'GET' && url.pathname === '/supabase/blocklist') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      try {
        const data = await supabaseFetch('/blocklist?select=*&order=blocked_at.desc');
        return json({ data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── PUT /supabase/blocklist — admin only ──
    if (request.method === 'PUT' && url.pathname === '/supabase/blocklist') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const rows = Array.isArray(body.data) ? body.data : [];

      try {
        const cleanByPhone = new Map();
        rows.forEach(b => {
          const phone = String(b.phone || '').replace(/\D/g, '').slice(-8);
          if (phone.length !== 8) return;
          cleanByPhone.set(phone, {
            phone,
            reason: b.reason || '',
            blocked_at: b.blockedAt || b.blocked_at || new Date().toISOString(),
          });
        });
        const clean = Array.from(cleanByPhone.values());
        const existing = await supabaseFetch('/blocklist?select=*').catch(() => []);
        const existingByPhone = new Map((Array.isArray(existing) ? existing : []).map(row => [String(row.phone || ''), row]));

        for (const row of clean) {
          if (existingByPhone.has(row.phone)) {
            await supabaseFetch(`/blocklist?phone=eq.${encodeURIComponent(row.phone)}`, {
              method: 'PATCH',
              body: JSON.stringify(row),
            });
          } else {
            await supabaseFetch('/blocklist', {
              method: 'POST',
              body: JSON.stringify(row),
            });
          }
        }

        for (const row of existingByPhone.values()) {
          const phone = String(row.phone || '');
          if (phone && !cleanByPhone.has(phone)) {
            await supabaseFetch(`/blocklist?phone=eq.${encodeURIComponent(phone)}`, { method: 'DELETE' });
          }
        }

        return json({ ok: true, count: clean.length });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/customers — admin/POS ──
    if (request.method === 'GET' && url.pathname === '/supabase/customers') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      try {
        const data = await supabaseFetch('/customers?select=*&order=last_seen.desc.nullslast');
        return json({ data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── PUT /supabase/customers — admin/POS ──
    if (request.method === 'PUT' && url.pathname === '/supabase/customers') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;
      const session = blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const rows = Array.isArray(body.data) ? body.data : [];

      try {
        const cleanByPhone = new Map();
        rows.forEach(c => {
          const phone = String(c.phone || '').replace(/\D/g, '').slice(-8);
          if (phone.length !== 8) return;
          cleanByPhone.set(phone, {
            phone,
            name: c.name || '',
            note: c.note || '',
            first_seen: c.firstSeen || c.first_seen || new Date().toISOString(),
            last_seen: c.lastSeen || c.last_seen || new Date().toISOString(),
            total_orders: Number(c.totalOrders ?? c.total_orders ?? 0),
            total_spent: Number(c.totalSpent ?? c.total_spent ?? 0),
            order_ids: c.orderIds || c.order_ids || [],
            item_freq: c.itemFreq || c.item_freq || {},
            favorite_items: c.favoriteItems || c.favorite_items || [],
            loyalty_stamps: Number(c.loyaltyStamps ?? c.loyalty_stamps ?? 0),
            loyalty_reward_ready: !!(c.loyaltyRewardReady ?? c.loyalty_reward_ready),
            loyalty_last_reward: c.loyaltyLastReward ?? c.loyalty_last_reward ?? null,
            loyalty_reward_redeemed_at: c.loyaltyRewardRedeemedAt ?? c.loyalty_reward_redeemed_at ?? null,
            loyalty_lifetime_redemptions: Number(c.loyaltyLifetimeRedemptions ?? c.loyalty_lifetime_redemptions ?? 0),
          });
        });
        const clean = Array.from(cleanByPhone.values());
        const existing = await supabaseFetch('/customers?select=*').catch(() => []);
        const existingByPhone = new Map((Array.isArray(existing) ? existing : []).map(row => [String(row.phone || ''), row]));

        for (const row of clean) {
          if (existingByPhone.has(row.phone)) {
            await supabaseFetch(`/customers?phone=eq.${encodeURIComponent(row.phone)}`, {
              method: 'PATCH',
              body: JSON.stringify(row),
            });
          } else {
            await supabaseFetch('/customers', {
              method: 'POST',
              body: JSON.stringify(row),
            });
          }
        }

        if (session.role === 'admin') {
          for (const row of existingByPhone.values()) {
            const phone = String(row.phone || '');
            if (phone && !cleanByPhone.has(phone)) {
              await supabaseFetch(`/customers?phone=eq.${encodeURIComponent(phone)}`, { method: 'DELETE' });
            }
          }
        }

        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/orders — admin/POS ──
    if (request.method === 'GET' && url.pathname === '/supabase/orders') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      const status = url.searchParams.get('status');

      try {
        const path = status
          ? `/orders?select=*&status=eq.${encodeURIComponent(status)}&order=created_at.desc`
          : '/orders?select=*&order=created_at.desc';

        const data = await supabaseFetch(path);
        return json({ data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/order-events — admin/POS lightweight order-change polling ──
    if (request.method === 'GET' && url.pathname === '/supabase/order-events') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      const since = url.searchParams.get('since');
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 40) || 40));

      try {
        let path = `/orders?select=id,status,updated_at,created_at,payload&order=updated_at.desc&limit=${limit}`;
        if (since) path += `&updated_at=gt.${encodeURIComponent(since)}`;
        const rows = await supabaseFetch(path);
        const data = (Array.isArray(rows) ? rows : []).map(row => ({
          id: row.id,
          status: row.status,
          updatedAt: row.updated_at || row.created_at || '',
          createdAt: row.created_at || '',
          name: row.payload?.name || '',
          phone: row.payload?.phone || '',
          orderType: row.payload?.orderType || '',
          total: row.payload?.total || 0,
          source: row.payload?.source || '',
        }));
        return json({ data, serverTime: new Date().toISOString() });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/customer-history?phone= — admin/POS order history by customer ──
    if (request.method === 'GET' && url.pathname === '/supabase/customer-history') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      const phone = normalizePhone(url.searchParams.get('phone'));
      if (!phone) return json({ error: 'Invalid phone' }, 400);

      try {
        const rows = await supabaseFetch('/orders?select=*&order=created_at.desc&limit=500');
        const data = (Array.isArray(rows) ? rows : [])
          .filter(row => normalizePhone(row.payload?.phone) === phone)
          .slice(0, 50)
          .map(row => ({
            id: row.id,
            status: row.status,
            createdAt: row.created_at || row.payload?.timestamp || '',
            updatedAt: row.updated_at || '',
            payload: row.payload || {},
          }));
        return json({ data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /supabase/order — admin/POS ──
    if (request.method === 'POST' && url.pathname === '/supabase/order') {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      let order;
      try {
        order = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      if (!order.id || !order.name || !order.items) {
        return json({ error: 'Missing fields' }, 400);
      }

      try {
        const existingRows = await supabaseFetch(`/orders?id=eq.${String(order.id)}&select=*&limit=1`);
        const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;

        if (existing && existing.payload && existing.payload.tracking) {
          if (!order.tracking) order.tracking = {};
          order.tracking = { ...existing.payload.tracking, ...order.tracking };
        }
        if (existing && existing.payload && existing.payload.access && !order.access) {
          order.access = existing.payload.access;
        }
        ensureOrderAccess(order);

        const existingGPS = existing && existing.payload ? customerGPS(existing.payload) : null;
        const nextGPS = customerGPS(order);
        if (!nextGPS && existingGPS) order.gps = existingGPS;
        else if (nextGPS) order.gps = nextGPS;

        if ((!order.address || !String(order.address).trim()) && existing?.payload?.address) {
          order.address = existing.payload.address;
        }

        const row = {
          id: String(order.id),
          status: order.status || 'inbox',
          payload: order,
          updated_at: new Date().toISOString(),
        };

        const data = await supabaseFetch('/orders?on_conflict=id', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify(row),
        });

        return json({ ok: true, data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /supabase/backup — scheduled Supabase snapshot backup ──
    if (request.method === 'POST' && url.pathname === '/supabase/backup') {
      if (!backupKeyOk(request)) return json({ error: 'Forbidden' }, 403);

      try {
        const [
          cfg,
          categories,
          products,
          customers,
          orders,
          blocklist,
          gallery,
        ] = await Promise.all([
          siteConfigRaw(),
          supabaseFetch('/categories?select=*&order=sort_order.asc').catch(() => []),
          supabaseFetch('/products?select=*&order=sort_order.asc').catch(() => []),
          supabaseFetch('/customers?select=*&order=last_seen.desc.nullslast').catch(() => []),
          supabaseFetch('/orders?select=*&order=created_at.desc&limit=1000').catch(() => []),
          supabaseFetch('/blocklist?select=*&order=blocked_at.desc').catch(() => []),
          supabaseFetch('/guest_gallery?select=*&order=created_at.desc&limit=1000').catch(() => []),
        ]);

        const snapshot = {
          createdAt: new Date().toISOString(),
          source: 'worker',
          tables: {
            app_config: { site_settings: cfg },
            categories,
            products,
            customers,
            orders,
            blocklist,
            guest_gallery: gallery,
          },
        };

        const backupKey = backupDateKey();
        const inserted = await supabaseFetch('/app_backups?on_conflict=backup_key', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({
            backup_key: backupKey,
            snapshot,
            created_at: snapshot.createdAt,
          }),
        });

        await supabaseFetch('/app_backups?select=backup_key&order=backup_key.desc&offset=30')
          .then(oldRows => Promise.all((oldRows || []).map(row =>
            supabaseFetch(`/app_backups?backup_key=eq.${encodeURIComponent(row.backup_key)}`, { method: 'DELETE' })
          )))
          .catch(() => {});

        return json({
          ok: true,
          backupKey,
          rows: {
            categories: categories.length,
            products: products.length,
            customers: customers.length,
            orders: orders.length,
            blocklist: blocklist.length,
            gallery: gallery.length,
          },
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/backups — admin backup inventory ──
    if (request.method === 'GET' && url.pathname === '/supabase/backups') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      try {
        const data = await supabaseFetch('/app_backups?select=backup_key,created_at&order=backup_key.desc&limit=30');
        return json({ data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /driver-app/link — admin-only 15-minute APK download link ──
    if (request.method === 'POST' && url.pathname === '/driver-app/link') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      try {
        const expiresAtMs = Date.now() + 15 * 60 * 1000;
        const token = await driverAppToken(expiresAtMs);
        const publicUrl = new URL(request.url);
        publicUrl.pathname = '/driver-app/download';
        publicUrl.search = `?token=${encodeURIComponent(token)}`;
        return json({
          ok: true,
          url: publicUrl.toString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /driver-app/download — temporary redirect to APK asset ──
    if (request.method === 'GET' && url.pathname === '/driver-app/download') {
      const token = url.searchParams.get('token') || '';
      if (!(await verifyDriverAppToken(token))) {
        return new Response('Download link expired or invalid', { status: 403, headers: corsHeaders });
      }
      try {
        return Response.redirect(await signedDriverApkUrl(), 302);
      } catch (e) {
        if (env.DRIVER_APK_URL) return Response.redirect(env.DRIVER_APK_URL, 302);
        return json({ error: e.message || 'Driver APK is not available' }, 502);
      }
    }

    // ── POST /order — public website order intake ──
    if (request.method === 'POST' && url.pathname === '/order') {
      const limited = rateLimit('public-order', 10, 5 * 60 * 1000);
      if (limited) return limited;

      let order;
      try {
        order = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      if (!order.name || !order.items) {
        return json({ error: 'Missing fields' }, 400);
      }

      try {
        const cfg = await siteConfigRaw();
        if (cfg.menuOrderingEnabled === false) {
          return json({ error: 'Online ordering is currently disabled' }, 403);
        }
        if (!storeIsOpen(cfg)) {
          return json({ error: 'Orders open from 6 PM to 12 AM' }, 403);
        }

        const phone = normalizePhone(order.phone);
        const blockedRows = phone
          ? await supabaseFetch(`/blocklist?phone=eq.${encodeURIComponent(phone)}&select=phone&limit=1`)
          : [];
        if (Array.isArray(blockedRows) && blockedRows.length) {
          return json({ error: 'This number is blocked. Please contact us directly.' }, 403);
        }

        const cleanOrder = cleanPublicOrder(order, await menuProducts());

        await supabaseFetch('/orders?on_conflict=id', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({
            id: String(cleanOrder.id),
            status: 'inbox',
            payload: cleanOrder,
            updated_at: new Date().toISOString(),
          }),
        });

        return json({
          ok: true,
          id: cleanOrder.id,
          customerToken: cleanOrder.access.customerToken,
          trackUrl: `https://lekiosk.store/track/?id=${encodeURIComponent(cleanOrder.id)}#t=${encodeURIComponent(cleanOrder.access.customerToken)}`,
        });
      } catch (e) {
        return json({ error: e.message }, /Invalid|Unavailable|Required|outside|disabled|blocked|open/i.test(e.message || '') ? 400 : 502);
      }
    }

    // ── GET /gh — admin only ──
    if (request.method === 'GET' && url.pathname === '/gh') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      const file = url.searchParams.get('file');

      if (!ALLOWED_FILES.includes(file)) {
        return json({ error: 'Forbidden file: ' + file }, 403);
      }

      try {
        const { data, sha } = await ghRead(file);
        return json({ data, sha });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── PUT /gh — admin only ──
    if (request.method === 'PUT' && url.pathname === '/gh') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      const file = url.searchParams.get('file');

      if (!ALLOWED_FILES.includes(file)) {
        return json({ error: 'Forbidden file: ' + file }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      try {
        const newSha = await ghWrite(file, body.data, body.message);
        return json({ ok: true, sha: newSha });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /image — admin only ──
    if (request.method === 'POST' && url.pathname === '/image') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const { path, b64, message } = body;

      if (!path || !b64 || !message) {
        return json({ error: 'Missing path, b64, or message' }, 400);
      }

      if (!/^menupictures\/[a-zA-Z0-9._/-]+\.(?:jpe?g|png|webp)$/i.test(path) || path.includes('..')) {
        return json({ error: 'Forbidden path' }, 403);
      }

      try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) return json({ error: 'Image is too large. Max 5MB.' }, 400);
        const lower = path.toLowerCase();
        const contentType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        await supabaseUploadImage(path, bytes, contentType, env);
        return json({ ok: true, path });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/menu — public ──
    if (request.method === 'GET' && url.pathname === '/supabase/menu') {
      try {
        const categories = await supabaseFetch('/categories?select=*&active=eq.true&order=sort_order.asc');
        const products = await supabaseFetch('/products?select=*&active=eq.true&order=sort_order.asc');

        const menu = categories.map(cat => {
          const items = products
            .filter(p => p.category_key === cat.key)
            .map(p => ({
              ...(p.raw || {}),
              name: p.name,
              desc: p.description,
              price: p.price,
              image: p.image,
              active: p.active,
              flavors: p.flavors || [],
              addons: p.addons || [],
              flavorColor: p.flavor_color || 'amber',
            }));

          return {
            ...(cat.raw || {}),
            key: cat.key,
            title: cat.title,
            type: cat.type === 'regular' ? undefined : cat.type,
            bottomBanner: cat.bottom_banner || undefined,
            items,
          };
        });

        return json({ data: menu });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── PUT /supabase/menu — admin only ──
    if (request.method === 'PUT' && url.pathname === '/supabase/menu') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const sections = Array.isArray(body.data) ? body.data : [];

      try {
        const now = new Date().toISOString();
        const existingCategories = await supabaseFetch('/categories?select=*').catch(() => []);
        const existingProducts = await supabaseFetch('/products?select=*').catch(() => []);
        const existingCategoriesByKey = new Map((Array.isArray(existingCategories) ? existingCategories : []).map(cat => [String(cat.key || ''), cat]));
        const existingProductsBySlot = new Map();
        (Array.isArray(existingProducts) ? existingProducts : []).forEach(product => {
          const slot = `${product.category_key || ''}\n${Number(product.sort_order ?? 0)}`;
          if (!existingProductsBySlot.has(slot)) existingProductsBySlot.set(slot, product);
        });
        const productFilter = (product) => {
          if (product?.id != null) return `/products?id=eq.${encodeURIComponent(product.id)}`;
          return `/products?category_key=eq.${encodeURIComponent(product.category_key || '')}&sort_order=eq.${encodeURIComponent(product.sort_order ?? 0)}`;
        };
        const categories = sections.map((sec, index) => ({
          key: sec.key || `category-${index}`,
          title: sec.title || 'Untitled',
          type: sec.type || 'regular',
          bottom_banner: sec.bottomBanner || null,
          sort_order: index,
          active: true,
          raw: sec,
          updated_at: now,
        }));

        const incomingCategoryKeys = new Set(categories.map(cat => cat.key));
        for (const category of categories) {
          if (existingCategoriesByKey.has(category.key)) {
            await supabaseFetch(`/categories?key=eq.${encodeURIComponent(category.key)}`, {
              method: 'PATCH',
              body: JSON.stringify(category),
            });
          } else {
            await supabaseFetch('/categories', {
              method: 'POST',
              body: JSON.stringify(category),
            });
          }
        }

        const products = [];

        sections.forEach((sec, sectionIndex) => {
          if (sec.type === 'addons') return;

          (sec.items || []).forEach((item, itemIndex) => {
            products.push({
              category_key: sec.key || `category-${sectionIndex}`,
              name: item.name || 'Untitled Item',
              description: item.desc || item.description || '',
              price: item.price || '$0',
              image: item.image || '',
              active: item.active !== false,
              sort_order: itemIndex,
              flavors: item.flavors || [],
              addons: item.addons || [],
              flavor_color: item.flavorColor || 'amber',
              raw: item,
              updated_at: now,
            });
          });
        });

        const incomingProductSlots = new Set();
        for (const product of products) {
          const slot = `${product.category_key || ''}\n${Number(product.sort_order ?? 0)}`;
          incomingProductSlots.add(slot);
          const existing = existingProductsBySlot.get(slot);
          if (existing) {
            await supabaseFetch(productFilter(existing), {
              method: 'PATCH',
              body: JSON.stringify(product),
            });
          } else {
            await supabaseFetch('/products', {
              method: 'POST',
              body: JSON.stringify(product),
            });
          }
        }

        for (const product of existingProductsBySlot.values()) {
          const slot = `${product.category_key || ''}\n${Number(product.sort_order ?? 0)}`;
          if (!incomingProductSlots.has(slot) && product.active !== false) {
            await supabaseFetch(productFilter(product), {
              method: 'PATCH',
              body: JSON.stringify({ active: false, updated_at: now }),
            });
          }
        }

        for (const category of existingCategoriesByKey.values()) {
          const key = String(category.key || '');
          if (key && !incomingCategoryKeys.has(key) && category.active !== false) {
            await supabaseFetch(`/categories?key=eq.${encodeURIComponent(key)}`, {
              method: 'PATCH',
              body: JSON.stringify({ active: false, updated_at: now }),
            });
          }
        }

        return json({
          ok: true,
          categories: categories.length,
          products: products.length,
	        });
	      } catch (e) {
	        return json({ error: e.message }, 502);
	      }
	    }

    // ── GET /supabase/config — public ──
    if (request.method === 'GET' && url.pathname === '/supabase/config') {
      try {
        const cfg = await siteConfigRaw();
        let isAdmin = false;
        if (bearerToken(request)) {
          try {
            await requireAuth(request, ['admin']);
            isAdmin = true;
          } catch (_) {}
        }
        return json({ data: publicConfig(cfg, isAdmin) });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── PUT /supabase/config — admin only ──
    if (request.method === 'PUT' && url.pathname === '/supabase/config') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const existingConfig = await siteConfigRaw();
      const value = body && typeof body.data === 'object' && body.data ? { ...existingConfig, ...body.data } : { ...existingConfig };
      if (typeof value.driverPin === 'string' && value.driverPin.trim()) {
        const pin = value.driverPin.trim();
        if (!/^\d{4,8}$/.test(pin)) return json({ error: 'Driver PIN must be 4-8 digits' }, 400);
        value.driverPinHash = await sha256Hex(pin);
      }
      if (value.clearDriverPin === true) delete value.driverPinHash;
      delete value.driverPin;
      delete value.clearDriverPin;
      delete value.driverPinSet;

      try {
        const data = await supabaseFetch('/app_config?on_conflict=key', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({
            key: 'site_settings',
            value,
            updated_at: new Date().toISOString(),
          }),
        });

        return json({ ok: true, data });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── POST /supabase/menu-visit — public ──
    if (request.method === 'POST' && url.pathname === '/supabase/menu-visit') {
      const limited = rateLimit('menu-visit', 60, 60 * 1000);
      if (limited) return limited;

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const visitorId = String(body.visitorId || '').trim();
      const visitDate = String(body.visitDate || '').slice(0, 10);

      if (!visitorId || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
        return json({ error: 'Missing visitorId or visitDate' }, 400);
      }

      try {
        await supabaseFetch('/menu_visits?on_conflict=visitor_id,visit_date', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({
            visitor_id: visitorId,
            visit_date: visitDate,
            path: String(body.path || '').slice(0, 250),
            referrer: String(body.referrer || '').slice(0, 500),
          }),
        });

        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ── GET /supabase/menu-visits — admin only ──
    if (request.method === 'GET' && url.pathname === '/supabase/menu-visits') {
      const blocked = await guard(['admin']);
      if (blocked instanceof Response) return blocked;

      try {
        const data = await supabaseFetch('/menu_visits?select=visit_date,visitor_id&order=visit_date.desc');

        const byDay = {};
        data.forEach(row => {
          const day = row.visit_date;
          if (!day) return;
          byDay[day] = (byDay[day] || 0) + 1;
        });

        const rows = Object.entries(byDay).map(([visit_date, visits]) => ({
          visit_date,
          visits,
        }));

        return json({ data: rows });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
/*
Le Kiosk AI Combo Builder route.
*/

// -- POST /api/combo -- public AI combo builder
if (request.method === 'POST' && url.pathname === '/api/combo') {
  const limited = rateLimit('ai-combo', 20, 10 * 60 * 1000);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const craving = String(body.craving || '').trim();
  if (!craving) {
    return json({ error: 'Missing craving' }, 400);
  }

  if (!env.GEMINI_API_KEY) {
    return json({ error: 'Missing GEMINI_API_KEY Worker secret' }, 500);
  }

  try {
    const cfg = await siteConfigRaw();
    if (cfg.aiComboEnabled === false) return json({ error: 'AI combo builder is disabled' }, 403);

    const categories = await supabaseFetch('/categories?select=*&active=eq.true&order=sort_order.asc');
    const products = await supabaseFetch('/products?select=*&active=eq.true&order=sort_order.asc');

    const categoryTitles = Object.fromEntries(
      (Array.isArray(categories) ? categories : []).map(cat => [cat.key, cat.title])
    );

    const menuItems = (Array.isArray(products) ? products : [])
      .map(p => ({
        name: p.name,
        category: categoryTitles[p.category_key] || p.category_key || '',
        description: p.description || '',
        price: p.price || '$0',
      }))
      .filter(item => item.name);

    function priceNumber(price) {
      const n = Number(String(price || '').replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }

    function normalizeName(name) {
      return String(name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function menuItemByName(name) {
      const exact = normalizeName(name);
      return menuItems.find(item => normalizeName(item.name) === exact)
        || menuItems.find(item => exact && normalizeName(item.name).includes(exact))
        || menuItems.find(item => exact && exact.includes(normalizeName(item.name)));
    }

    function cravingTerms() {
      const raw = normalizeName(craving).split(/\s+/).filter(word => word.length > 2);
      const aliases = {
        // English sweet / dessert
        nutela: ['nutella', 'chocolate', 'sweet', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'milkshake'],
        nutla: ['nutella', 'chocolate', 'sweet', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        nutella: ['chocolate', 'sweet', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'milkshake'],
        choco: ['chocolate', 'nutella', 'brownie', 'oreo', 'sweet'],
        chocolate: ['nutella', 'brownie', 'oreo', 'sweet', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        chocolat: ['chocolate', 'nutella', 'brownie', 'oreo', 'sweet'],
        kinder: ['kinder', 'chocolate', 'sweet', 'waffle', 'crepe', 'pancake'],
        oreo: ['oreo', 'chocolate', 'sweet', 'milkshake', 'ice', 'cream'],
        lotus: ['lotus', 'biscoff', 'sweet', 'waffle', 'crepe', 'pancake'],
        caramel: ['caramel', 'sweet', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        sugar: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        sukar: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        sokar: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],
        sweet: ['waffle', 'pancake', 'crepe', 'ice', 'cream', 'nutella', 'oreo', 'chocolate', 'dessert'],
        dessert: ['sweet', 'waffle', 'pancake', 'crepe', 'ice', 'cream', 'nutella', 'oreo', 'chocolate'],
        sweets: ['sweet', 'waffle', 'pancake', 'crepe', 'ice', 'cream', 'nutella', 'oreo', 'chocolate'],
        helou: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        helo: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        heloow: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        '7elo': ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        '7elou': ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        hlou: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        helwe: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        helweh: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        helu: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        halew: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream', 'nutella', 'chocolate'],
        zahra: ['dessert', 'sweet', 'waffle', 'crepe', 'pancake'],
        sahra: ['dessert', 'sweet', 'waffle', 'crepe', 'pancake', 'shisha'],
        atyab: ['sweet', 'dessert', 'waffle', 'crepe', 'pancake', 'ice', 'cream'],

        // Cold / drinks / fruity
        cold: ['ice', 'cream', 'milkshake', 'smoothie', 'juice', 'lemon', 'mint', 'fruit'],
        cool: ['ice', 'cream', 'milkshake', 'smoothie', 'juice', 'cold'],
        fresh: ['juice', 'smoothie', 'lemon', 'mint', 'cold', 'fruit'],
        ice: ['ice', 'cream', 'cold', 'milkshake'],
        iced: ['ice', 'cream', 'cold', 'milkshake'],
        frozen: ['ice', 'cream', 'cold', 'smoothie', 'milkshake'],
        drink: ['juice', 'smoothie', 'milkshake', 'cold', 'lemon', 'mint'],
        drinks: ['juice', 'smoothie', 'milkshake', 'cold', 'lemon', 'mint'],
        juice: ['juice', 'fruit', 'lemon', 'mint', 'orange', 'strawberry', 'mango'],
        smoothie: ['smoothie', 'fruit', 'cold', 'strawberry', 'banana', 'mango'],
        milkshake: ['milkshake', 'ice', 'cream', 'chocolate', 'oreo', 'cold'],
        refreshing: ['juice', 'smoothie', 'lemon', 'mint', 'cold', 'fruit'],
        fruity: ['fruit', 'strawberry', 'banana', 'mango', 'berry', 'juice', 'smoothie'],
        fruit: ['fruit', 'strawberry', 'banana', 'mango', 'berry', 'juice', 'smoothie'],
        strawberry: ['strawberry', 'fruit', 'smoothie', 'juice', 'ice', 'cream'],
        banana: ['banana', 'fruit', 'smoothie', 'juice', 'ice', 'cream'],
        mango: ['mango', 'fruit', 'smoothie', 'juice'],
        lemon: ['lemon', 'mint', 'juice', 'cold', 'refreshing'],
        mint: ['mint', 'lemon', 'juice', 'cold', 'refreshing', 'shisha'],
        bared: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        bered: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        barid: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        barad: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        sa2e3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        sa23a: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        msa2a3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        msa23: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        msaa2a3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        msha2a3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        msake3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        mse2a3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        saqe3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        se2a3: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        sa2a: ['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice'],
        talej: ['ice', 'cream', 'cold', 'milkshake'],
        tlej: ['ice', 'cream', 'cold', 'milkshake'],
        mos2e3: ['cold', 'juice', 'smoothie', 'lemon', 'mint'],
        asir: ['juice', 'fruit', 'lemon', 'mint', 'orange', 'strawberry', 'mango'],
        '3asir': ['juice', 'fruit', 'lemon', 'mint', 'orange', 'strawberry', 'mango'],
        cocktail: ['juice', 'fruit', 'smoothie', 'strawberry', 'banana', 'mango'],
        koktel: ['juice', 'fruit', 'smoothie', 'strawberry', 'banana', 'mango'],
        orange: ['orange', 'juice', 'fruit'],
        avocado: ['avocado', 'juice', 'smoothie', 'fruit'],

        // Salty / savory / meal
        salty: ['fries', 'cheese', 'burger', 'sandwich', 'sauce', 'loaded'],
        salt: ['fries', 'cheese', 'burger', 'sandwich', 'sauce', 'loaded'],
        savory: ['fries', 'cheese', 'burger', 'sandwich', 'sauce', 'loaded'],
        snack: ['fries', 'cheese', 'burger', 'sandwich', 'sauce', 'loaded', 'box'],
        snacks: ['fries', 'cheese', 'burger', 'sandwich', 'sauce', 'loaded', 'box'],
        fries: ['fries', 'loaded', 'cheese', 'sauce'],
        fry: ['fries', 'loaded', 'cheese', 'sauce'],
        batata: ['fries', 'loaded', 'cheese', 'sauce'],
        batataw: ['fries', 'loaded', 'cheese', 'sauce'],
        batata2: ['fries', 'loaded', 'cheese', 'sauce'],
        cheese: ['cheese', 'fries', 'burger', 'sandwich'],
        jebne: ['cheese', 'fries', 'burger', 'sandwich'],
        jebneh: ['cheese', 'fries', 'burger', 'sandwich'],
        labne: ['labne', 'labneh', 'sandwich', 'cheese', 'savory'],
        labneh: ['labne', 'labneh', 'sandwich', 'cheese', 'savory'],
        labni: ['labne', 'labneh', 'sandwich', 'cheese', 'savory'],
        zaatar: ['zaatar', 'labne', 'sandwich', 'savory'],
        manoushe: ['zaatar', 'labne', 'cheese', 'savory'],
        manouche: ['zaatar', 'labne', 'cheese', 'savory'],
        maleh: ['salty', 'fries', 'cheese', 'burger', 'sandwich', 'loaded'],
        meleh: ['salty', 'fries', 'cheese', 'burger', 'sandwich', 'loaded'],
        mleh: ['salty', 'fries', 'cheese', 'burger', 'sandwich', 'loaded'],
        male7: ['salty', 'fries', 'cheese', 'burger', 'sandwich', 'loaded'],
        mele7: ['salty', 'fries', 'cheese', 'burger', 'sandwich', 'loaded'],
        akel: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        akle: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        akleh: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        spicy: ['spicy', 'buffalo', 'sauce', 'burger', 'fries'],
        har: ['spicy', 'buffalo', 'sauce', 'burger', 'fries'],
        '7ar': ['spicy', 'buffalo', 'sauce', 'burger', 'fries'],
        harr: ['spicy', 'buffalo', 'sauce', 'burger', 'fries'],
        spicyy: ['spicy', 'buffalo', 'sauce', 'burger', 'fries'],
        hungry: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        honger: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        hunger: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        jo3an: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        jوعان: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        je3an: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        jou3an: ['burger', 'sandwich', 'fries', 'loaded', 'box'],
        ktir: ['loaded', 'box', 'burger', 'sandwich', 'fries'],
        burger: ['burger', 'fries', 'cheese', 'sauce'],
        sandwich: ['sandwich', 'fries', 'cheese', 'sauce'],
        sandwish: ['sandwich', 'fries', 'cheese', 'sauce'],
        tawouk: ['sandwich', 'fries', 'garlic', 'sauce'],
        taouk: ['sandwich', 'fries', 'garlic', 'sauce'],
        chicken: ['chicken', 'sandwich', 'burger', 'fries'],
        djej: ['chicken', 'sandwich', 'burger', 'fries'],
        djeij: ['chicken', 'sandwich', 'burger', 'fries'],
        crispy: ['crispy', 'sandwich', 'burger', 'fries'],
        loaded: ['loaded', 'fries', 'cheese', 'sauce'],
        shawarma: ['sandwich', 'chicken', 'fries', 'garlic', 'sauce'],
        garlic: ['garlic', 'sauce', 'sandwich', 'fries'],
        toum: ['garlic', 'sauce', 'sandwich', 'fries'],
        sauce: ['sauce', 'fries', 'burger', 'sandwich'],
        bbq: ['bbq', 'sauce', 'burger', 'fries'],
        buffalo: ['buffalo', 'spicy', 'sauce', 'fries'],

        // Shisha
        shisha: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        arguile: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        argile: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        arghile: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        nargile: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        nafas: ['shisha', 'double', 'apple', 'mint', 'lemon', 'flavor'],
        teffehten: ['double', 'apple', 'shisha'],
        tifehten: ['double', 'apple', 'shisha'],
        na3na3: ['mint', 'lemon', 'shisha'],
        nana: ['mint', 'lemon', 'shisha'],

        // Mood words
        light: ['juice', 'smoothie', 'fruit', 'salad', 'ice', 'cream'],
        khafif: ['juice', 'smoothie', 'fruit', 'ice', 'cream'],
        khfif: ['juice', 'smoothie', 'fruit', 'ice', 'cream'],
        quick: ['fries', 'sandwich', 'burger', 'juice', 'milkshake'],
        cheap: ['fries', 'juice', 'ice', 'cream'],
        rkhees: ['fries', 'juice', 'ice', 'cream'],
        rkhes: ['fries', 'juice', 'ice', 'cream'],
        kids: ['pancake', 'waffle', 'ice', 'cream', 'fries', 'juice'],
        child: ['pancake', 'waffle', 'ice', 'cream', 'fries', 'juice'],
        kidsmeal: ['pancake', 'waffle', 'ice', 'cream', 'fries', 'juice'],
      };
      const terms = new Set(raw);
      raw.forEach(word => (aliases[word] || []).forEach(alias => terms.add(alias)));
      return [...terms];
    }

    function itemRelevance(item) {
      const hay = normalizeName(`${item.name} ${item.category} ${item.description}`);
      let score = cravingTerms().reduce((total, term) => {
        if (hay.includes(term)) total += 4;
        if (normalizeName(item.name).includes(term)) total += 3;
        if (normalizeName(item.category).includes(term)) total += 2;
        return total;
      }, 0);
      if (isBadMatchForCraving(item)) score -= 20;
      return score;
    }

    function hasAnyTerm(list) {
      const terms = cravingTerms();
      return list.some(term => terms.includes(term));
    }

    function isBadMatchForCraving(item) {
      const hay = normalizeName(`${item.name} ${item.category} ${item.description}`);
      const sweetIntent = hasAnyTerm(['sweet', 'dessert', 'nutella', 'chocolate', 'oreo', 'lotus', 'kinder', 'waffle', 'crepe', 'pancake']);
      const coldIntent = hasAnyTerm(['cold', 'ice', 'cream', 'milkshake', 'smoothie', 'juice', 'fruit']);
      if (sweetIntent) {
        return ['fries', 'burger', 'sandwich', 'labne', 'labneh', 'zaatar', 'cheese', 'tawouk', 'taouk', 'chicken', 'crispy', 'garlic', 'sauce']
          .some(term => hay.includes(term));
      }
      if (coldIntent && !sweetIntent) {
        return ['fries', 'burger', 'sandwich', 'labne', 'labneh', 'zaatar', 'tawouk', 'taouk', 'chicken', 'crispy']
          .some(term => hay.includes(term));
      }
      return false;
    }

    function cleanCombo(combo) {
      const names = Array.isArray(combo?.items) ? combo.items : [];
      const picked = [];
      names.forEach(name => {
        const item = menuItemByName(name);
        if (item && !picked.some(p => normalizeName(p.name) === normalizeName(item.name))) {
          picked.push(item);
        }
      });

      const finalItems = picked.slice(0, 3);
      if (finalItems.length < 2) return null;

      const relevantItems = finalItems.filter(item => itemRelevance(item) > 0);
      if (relevantItems.length < Math.min(2, finalItems.length)) return null;

      const totalPrice = finalItems.reduce((sum, item) => sum + priceNumber(item.price), 0);
      return {
        comboName: String(combo.comboName || 'Le Kiosk Combo').trim() || 'Le Kiosk Combo',
        items: finalItems.map(item => item.name),
        description: String(combo.description || 'Picked from the Le Kiosk menu for your craving.').trim(),
        totalPrice: Number(totalPrice.toFixed(2)),
      };
    }

    function fallbackCombo() {
      const scored = menuItems.map(item => {
        let score = itemRelevance(item);
        const hay = normalizeName(`${item.name} ${item.category} ${item.description}`);
        if (cravingTerms().some(term => ['nutela', 'nutella', 'chocolate', 'sweet', 'cold'].includes(term))) {
          if (hay.includes('fries') || hay.includes('burger') || hay.includes('sandwich')) score -= 8;
        }
        if (hay.includes('combo')) score += 1;
        return { item, score };
      });

      const picks = scored
        .sort((a, b) => b.score - a.score)
        .filter(row => row.score > 0)
        .slice(0, 3)
        .map(row => row.item);

      const finalItems = (picks.length ? picks : menuItems.slice(0, 3)).slice(0, 3);
      const totalPrice = finalItems.reduce((sum, item) => sum + priceNumber(item.price), 0);

      return {
        comboName: 'Le Kiosk Craving Combo',
        items: finalItems.map(item => item.name),
        description: 'A quick pick from the menu that matches your craving.',
        totalPrice: Number(totalPrice.toFixed(2)),
      };
    }

    const prompt = `You are the Le Kiosk snack combo assistant.

User craving: "${craving}"

Available menu items, with exact names and prices:
${JSON.stringify(menuItems)}

Pick 2-3 items that best match the craving.

Strict rules:
- Use ONLY exact item names from the menu above.
- Do not invent items.
- Prefer obvious flavor matches from name, category, and description.
- For sweet cravings, prefer waffles, pancakes, crepes, ice cream, chocolate, Nutella, Oreo, fruit, milkshakes, and desserts.
- For salty/hungry cravings, prefer burgers, sandwiches, fries, loaded fries, sauces, and savory items.
- For cold/refreshing cravings, prefer ice cream, drinks, smoothies, juices, fruit, lemon, mint.
- Make the combo feel like something a real Le Kiosk customer would order together.
- totalPrice must be the sum of the selected menu item prices.

Reply with ONLY a valid JSON object. Do not write markdown. Do not write "here is". Do not add explanation.

JSON shape:
{
  "comboName": "...",
  "items": ["...", "..."],
  "description": "one fun line",
  "totalPrice": 0.00
}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                comboName: { type: 'STRING' },
                items: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                },
                description: { type: 'STRING' },
                totalPrice: { type: 'NUMBER' },
              },
              required: ['comboName', 'items', 'description', 'totalPrice'],
            },
          },
        }),
      }
    );

    const geminiText = await geminiRes.text();
    const geminiData = geminiText ? JSON.parse(geminiText) : {};

    if (!geminiRes.ok) {
      return json({
        ok: true,
        combo: fallbackCombo(),
        fallback: true,
        aiUnavailable: true,
      });
    }

    const rawText = geminiData?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim() || '';

    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    if (!cleaned.startsWith('{')) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }
    }

    let combo;
    if (!cleaned) {
      combo = fallbackCombo();
    } else {
      try {
        combo = JSON.parse(cleaned);
      } catch (_) {
        try {
          const repaired = cleaned
            .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
            .replace(/,\s*([}\]])/g, '$1');
          combo = JSON.parse(repaired);
        } catch (__) {
          combo = fallbackCombo();
        }
      }
    }

    combo = cleanCombo(combo);

    if (!combo || !Array.isArray(combo.items) || !combo.items.length) {
      combo = fallbackCombo();
    }

    return json({ ok: true, combo });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}
/*
Le Kiosk Google Reviews route.

Paste inside the Worker fetch handler before the final:
  return json({ error: 'Not found' }, 404);

Required Worker secrets/settings:
  GOOGLE_PLACES_API_KEY
  GOOGLE_PLACE_ID
*/

// -- GET /api/google-reviews -- public Google reviews for menu page
if (request.method === 'GET' && url.pathname === '/api/google-reviews') {
  if (!env.GOOGLE_PLACES_API_KEY) {
    return json({ error: 'Missing GOOGLE_PLACES_API_KEY Worker secret' }, 500);
  }

  if (!env.GOOGLE_PLACE_ID) {
    return json({ error: 'Missing GOOGLE_PLACE_ID Worker secret' }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.origin + '/api/google-reviews-cache-v2');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const googleUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    googleUrl.searchParams.set('place_id', env.GOOGLE_PLACE_ID);
    googleUrl.searchParams.set('fields', 'name,rating,user_ratings_total,reviews,url');
    googleUrl.searchParams.set('reviews_sort', 'newest');
    googleUrl.searchParams.set('key', env.GOOGLE_PLACES_API_KEY);

    const res = await fetch(googleUrl.toString());
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status !== 'OK') {
      return json({ error: data.error_message || data.status || `Google ${res.status}` }, 502);
    }

    const place = data.result || {};
    const payload = {
      ok: true,
      data: {
        name: place.name || 'Le Kiosk',
        rating: Number(place.rating || 0),
        userRatingsTotal: Number(place.user_ratings_total || 0),
        url: place.url || '',
        reviews: (Array.isArray(place.reviews) ? place.reviews : [])
          .filter(r => r && r.text)
          .slice(0, 10)
          .map(r => ({
            authorName: r.author_name || 'Google reviewer',
            rating: Number(r.rating || 0),
            text: String(r.text || '').trim().slice(0, 500),
            relativeTime: r.relative_time_description || '',
            time: r.time || null,
            profilePhotoUrl: r.profile_photo_url || '',
          })),
      },
    };

    const response = json(payload);
    response.headers.set('Cache-Control', 'public, max-age=86400');
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}
/*
Le Kiosk Guest Gallery routes.

Paste inside the Worker fetch handler before the final:
  return json({ error: 'Not found' }, 404);

Requires Supabase table:
  guest_gallery

Uses existing Supabase storage bucket:
  menu-images
*/

function galleryCleanText(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function galleryTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function galleryPublicRow(row) {
  return {
    id: row.id,
    image: row.image_path,
    caption: row.caption || '',
    customerName: row.customer_name || '',
    createdAt: row.created_at || '',
  };
}

function galleryAdminRow(row) {
  return {
    id: row.id,
    status: row.status,
    image: row.image_path,
    caption: row.caption || '',
    customerName: row.customer_name || '',
    visitorId: row.visitor_id || '',
    submitDate: row.submit_date || '',
    hidden: !!row.hidden,
    createdAt: row.created_at || '',
    reviewedAt: row.reviewed_at || null,
  };
}

function galleryImageFromBody(body) {
  const raw = String(body.imageBase64 || body.b64 || '').trim();
  const contentType = String(body.contentType || '').toLowerCase();
  const dataUrl = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  const mime = dataUrl ? dataUrl[1].toLowerCase().replace('image/jpg', 'image/jpeg') : contentType;
  const b64 = dataUrl ? dataUrl[2] : raw;

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw new Error('Only JPG, PNG, or WEBP images are allowed');
  }

  if (!b64 || b64.length > 4_500_000) {
    throw new Error('Image is too large. Max 3MB.');
  }

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) {
    throw new Error('Image is too large. Max 3MB.');
  }
  const isJpeg = mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const isPng = mime === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp = mime === 'image/webp' && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) {
    throw new Error('Uploaded file does not match the declared image type');
  }

  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { bytes, mime, ext };
}

// -- GET /gallery/approved -- public approved guest gallery photos
if (request.method === 'GET' && url.pathname === '/gallery/approved') {
  try {
    const cfgRows = await supabaseFetch('/app_config?key=eq.site_settings&select=*').catch(() => []);
    const cfg = Array.isArray(cfgRows) && cfgRows.length ? (cfgRows[0].value || {}) : {};
    if (cfg.galleryEnabled === false) return json({ ok: true, data: [] });

    const rows = await supabaseFetch('/guest_gallery?status=eq.approved&hidden=eq.false&select=*&order=created_at.desc&limit=18');
    return json({ ok: true, data: (Array.isArray(rows) ? rows : []).map(galleryPublicRow) });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}

// -- POST /gallery/submit -- public photo submission, max 3 per visitor per day
if (request.method === 'POST' && url.pathname === '/gallery/submit') {
  const limited = rateLimit('gallery-submit', 3, 60 * 60 * 1000);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const visitorId = galleryCleanText(body.visitorId, 80);
  if (!visitorId) return json({ error: 'Missing visitorId' }, 400);

  const cfg = await siteConfigRaw();
  if (cfg.galleryEnabled === false) return json({ error: 'Guest gallery is disabled' }, 403);
  const submitDate = galleryTodayKey();

  try {
    const existing = await supabaseFetch(
      `/guest_gallery?visitor_id=eq.${encodeURIComponent(visitorId)}&submit_date=eq.${encodeURIComponent(submitDate)}&select=id`
    );

    if (Array.isArray(existing) && existing.length >= 3) {
      return json({ error: 'Daily photo limit reached. Try again tomorrow.' }, 429);
    }

    const image = galleryImageFromBody(body);
    const safeId = visitorId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'guest';
    const fileName = `${Date.now()}-${crypto.randomUUID()}.${image.ext}`;
    const path = `menupictures/guest-gallery/${submitDate}/${safeId}-${fileName}`;

    await supabaseUploadImage(path, image.bytes, image.mime, env);

    const row = {
      status: 'pending',
      image_path: path,
      caption: galleryCleanText(body.caption, 120),
      customer_name: galleryCleanText(body.customerName || body.name, 50),
      visitor_id: visitorId,
      submit_date: submitDate,
      hidden: false,
    };

    const data = await supabaseFetch('/guest_gallery', {
      method: 'POST',
      body: JSON.stringify(row),
    });

    return json({ ok: true, data: Array.isArray(data) ? galleryAdminRow(data[0]) : null });
  } catch (e) {
    const status = /too large|allowed|limit/i.test(e.message || '') ? 400 : 502;
    return json({ error: e.message || String(e) }, status);
  }
}

// -- GET /supabase/gallery -- admin only
if (request.method === 'GET' && url.pathname === '/supabase/gallery') {
  const blocked = await guard(['admin']);
  if (blocked instanceof Response) return blocked;

  const status = url.searchParams.get('status');
  const statusFilter = status && ['pending', 'approved', 'rejected'].includes(status)
    ? `status=eq.${encodeURIComponent(status)}&`
    : '';

  try {
    const rows = await supabaseFetch(`/guest_gallery?${statusFilter}select=*&order=created_at.desc&limit=80`);
    return json({ ok: true, data: (Array.isArray(rows) ? rows : []).map(galleryAdminRow) });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}

// -- PATCH /supabase/gallery/:id -- admin approve/hide/reject/edit
if (request.method === 'PATCH' && url.pathname.startsWith('/supabase/gallery/')) {
  const blocked = await guard(['admin']);
  if (blocked instanceof Response) return blocked;

  const id = url.pathname.split('/').pop();
  if (!id) return json({ error: 'Missing id' }, 400);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const patch = {};
  if (['pending', 'approved', 'rejected'].includes(body.status)) {
    patch.status = body.status;
    patch.reviewed_at = new Date().toISOString();
  }
  if (typeof body.hidden === 'boolean') patch.hidden = body.hidden;
  if (body.caption !== undefined) patch.caption = galleryCleanText(body.caption, 120);
  if (body.customerName !== undefined) patch.customer_name = galleryCleanText(body.customerName, 50);

  if (!Object.keys(patch).length) return json({ error: 'Nothing to update' }, 400);

  try {
    const data = await supabaseFetch(`/guest_gallery?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return json({ ok: true, data: Array.isArray(data) ? galleryAdminRow(data[0]) : null });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}

// -- DELETE /supabase/gallery/:id -- admin delete
if (request.method === 'DELETE' && url.pathname.startsWith('/supabase/gallery/')) {
  const blocked = await guard(['admin']);
  if (blocked instanceof Response) return blocked;

  const id = url.pathname.split('/').pop();
  if (!id) return json({ error: 'Missing id' }, 400);

  try {
    await supabaseFetch(`/guest_gallery?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message || String(e) }, 502);
  }
}

    // ── GET /track/:id — public order tracking page ──
    if (request.method === 'GET' && url.pathname.startsWith('/track/')) {
      const id = url.pathname.split('/track/')[1];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

        const payload = row.payload || {};
        try {
          requireTrackAccess(payload, request);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }
        const safe = {
          id: row.id,
          name: payload.name || 'Guest',
          orderType: payload.orderType || 'pos',
          items: (payload.items || []).map(it => ({
            name: it.name, price: it.price, qty: it.qty,
            flavor: it.flavor || null,
            addons: (it.addons || []).map(a => ({ label: a.label, price: a.price }))
          })),
          total: payload.total || 0,
          gps: customerGPS(payload),
          tracking: payload.tracking || {},
        };

        return json({ ok: true, data: safe });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── POST /track/:id — admin/POS, update tracking step ──
    if (request.method === 'POST' && url.pathname.startsWith('/track/')) {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;

      const id = url.pathname.split('/track/')[1];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

      const step = String(body.step || '').trim();
      const STEPS_ORDER = ['received','confirmed','preparing','delivering','delivered'];
      if (!STEPS_ORDER.includes(step)) {
        return json({ error: 'Invalid step.' }, 400);
      }

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

        const payload = row.payload || {};
        if (!payload.tracking) payload.tracking = {};
        const now = new Date().toISOString();
        payload.tracking[step] = now;
        for (let i = 0; i < STEPS_ORDER.indexOf(step); i++) {
          const earlier = STEPS_ORDER[i];
          if (!payload.tracking[earlier]) payload.tracking[earlier] = now;
        }

        await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ payload, updated_at: new Date().toISOString() }),
        });

        return json({ ok: true, step, time: payload.tracking[step] });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── GET /driver — driver's pending delivery list (no ID = list view) ──
    if (request.method === 'GET' && url.pathname === '/driver') {
      const limited = rateLimit('driver-pin', 20, 5 * 60 * 1000);
      if (limited) return limited;
      try {
        const cfg = await siteConfigRaw();
        try {
          await requireDriverPin(request, cfg);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }
        const rows = await supabaseFetch('/orders?select=*&order=created_at.desc&limit=100');
        const all = (Array.isArray(rows) ? rows : [])
          .filter(row => {
            const p = row.payload || {};
            const track = p.tracking || {};
            return p.orderType === 'delivery' && (track.preparing || track.delivered);
          })
          .map(row => {
            const p = row.payload || {};
            return {
              id: row.id,
              name: p.name || 'Guest',
              phone: p.phone || '',
              address: p.address || '',
              deliveryZone: p.deliveryZone || null,
              items: (p.items || []).map(it => ({
                name: it.name, price: it.price, qty: it.qty,
                flavor: it.flavor || null,
                addons: (it.addons || []).map(a => ({ label: a.label, price: a.price }))
              })),
              total: p.total || 0,
              gps: customerGPS(p),
              tracking: p.tracking || {},
            };
          });

        return json({ ok: true, data: all });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── POST /driver/:id/status — driver updates delivering/delivered ──
    if (request.method === 'POST' && url.pathname.startsWith('/driver/') && url.pathname.endsWith('/status')) {
      const limited = rateLimit('driver-order', 80, 5 * 60 * 1000);
      if (limited) return limited;
      const id = url.pathname.split('/driver/')[1].split('/status')[0];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

      const step = String(body.step || '').trim();
      if (!['delivering','delivered'].includes(step)) {
        return json({ error: 'Invalid step. Use delivering or delivered.' }, 400);
      }

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

	        const payload = row.payload || {};
	        const cfg = await siteConfigRaw();
	        try {
	          await requireDriverOrderAccess(payload, request, cfg, body);
	        } catch (e) {
	          if (e instanceof Response) return e;
	          throw e;
	        }
	        const track = payload.tracking || {};

        if (step === 'delivering' && track.delivering) {
          return json({ ok: true, step, time: track.delivering, alreadyDone: true });
        }
        if (!track.preparing && step === 'delivering') {
          return json({ error: 'Order is not ready yet. Wait for kitchen to finish.' }, 400);
        }
        if (step === 'delivered' && track.delivered) {
          return json({ ok: true, step, time: track.delivered, alreadyDone: true });
        }

        if (!payload.tracking) payload.tracking = {};
        const now = new Date().toISOString();
        payload.tracking[step] = now;
        if (step === 'delivering' && !payload.tracking.received) payload.tracking.received = now;
        if (step === 'delivering' && !payload.tracking.confirmed) payload.tracking.confirmed = now;
        if (step === 'delivered' && !payload.tracking.received) payload.tracking.received = now;
        if (step === 'delivered' && !payload.tracking.confirmed) payload.tracking.confirmed = now;
        if (step === 'delivered' && !payload.tracking.preparing) payload.tracking.preparing = now;
        if (step === 'delivered' && !payload.tracking.delivering) payload.tracking.delivering = now;
        if (step === 'delivered') payload.status = 'done';

        await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({
            status: step === 'delivered' ? 'done' : row.status,
            payload,
            updated_at: new Date().toISOString(),
          }),
        });

        return json({ ok: true, step, time: payload.tracking[step] });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── GET /driver/:id — driver order details ──
    if (request.method === 'GET' && url.pathname.startsWith('/driver/')) {
      const limited = rateLimit('driver-order', 80, 5 * 60 * 1000);
      if (limited) return limited;
      const id = url.pathname.split('/driver/')[1];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

	        const payload = row.payload || {};
	        const cfg = await siteConfigRaw();
	        try {
	          await requireDriverOrderAccess(payload, request, cfg);
	        } catch (e) {
	          if (e instanceof Response) return e;
	          throw e;
	        }
	        const safe = {
          id: row.id,
          name: payload.name || 'Guest',
          phone: payload.phone || '',
          address: payload.address || '',
          orderType: payload.orderType || 'delivery',
          deliveryZone: payload.deliveryZone || null,
          items: (payload.items || []).map(it => ({
            name: it.name, price: it.price, qty: it.qty,
            flavor: it.flavor || null,
            addons: (it.addons || []).map(a => ({ label: a.label, price: a.price }))
          })),
	          total: payload.total || 0,
	          gps: customerGPS(payload),
	          tracking: payload.tracking || {},
	          driverToken: payload.access?.driverToken || '',
	        };

        return json({ ok: true, data: safe });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── POST /driver/:id/location — driver shares GPS location ──
    if (request.method === 'POST' && url.pathname.startsWith('/driver/') && url.pathname.endsWith('/location')) {
      const limited = rateLimit('driver-location', 400, 5 * 60 * 1000);
      if (limited) return limited;
      const id = url.pathname.split('/driver/')[1].split('/location')[0];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

      const lat = parseFloat(body.lat);
      const lng = parseFloat(body.lng);
      if (isNaN(lat) || isNaN(lng)) return json({ error: 'Invalid lat/lng' }, 400);
      const heading = Number(body.heading);
      const speed = Number(body.speed);
      const accuracy = Number(body.accuracy);

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

	        const payload = row.payload || {};
	        const cfg = await siteConfigRaw();
	        try {
	          await requireDriverOrderAccess(payload, request, cfg, body);
	        } catch (e) {
	          if (e instanceof Response) return e;
	          throw e;
	        }
	        if (!payload.tracking) payload.tracking = {};
        payload.tracking.driverLocation = {
          lat,
          lng,
          heading: Number.isFinite(heading) ? heading : payload.tracking.driverLocation?.heading ?? null,
          speed: Number.isFinite(speed) ? speed : payload.tracking.driverLocation?.speed ?? null,
          accuracy: Number.isFinite(accuracy) ? accuracy : payload.tracking.driverLocation?.accuracy ?? null,
          updatedAt: new Date().toISOString(),
        };

        await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ payload, updated_at: new Date().toISOString() }),
        });

        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── DELETE /orders/:id — admin only, delete test orders ──
    if (request.method === 'DELETE' && url.pathname.startsWith('/orders/')) {
      const blocked = await guard(['admin', 'pos']);
      if (blocked instanceof Response) return blocked;
      const id = url.pathname.split('/orders/')[1];
      if (!id) return json({ error: 'Missing ID' }, 400);
      try {
        await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 502); }
    }

    return json({ error: 'Not found' }, 404);
  },
};
