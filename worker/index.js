const GH_OWNER = 'joetheproz5';
const GH_REPO  = 'le-kiosk-menu';
const GH_API   = 'https://api.github.com';

const ALLOWED_ORIGINS = [
  'https://lekiosk.store',
  'https://www.lekiosk.store',
  'https://joetheproz5.github.io',
];

const ALLOWED_FILES = ['orders.json','inbox.json','menu.json','blocklist.json','customers.json','config.json'];

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

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOk = ALLOWED_ORIGINS.includes(origin);
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOk ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Setup-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── WebSocket /ws/:orderId — real-time driver map updates via Durable Object ──
    if (url.pathname.startsWith('/ws/')) {
      const orderId = url.pathname.split('/')[2];
      if (!orderId) return new Response('Missing order id', { status: 400, headers: corsHeaders });
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

    // ── POST /auth/setup — create/reset staff accounts ──
    // ── POST /auth/setup — create/reset staff accounts ──
if (request.method === 'POST' && url.pathname === '/auth/setup') {
  try {
    if ((request.headers.get('X-Setup-Key') || '') !== env.AUTH_SETUP_KEY) {
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

    // ── GET /supabase/blocklist — public because menu checks blocked phones ──
    if (request.method === 'GET' && url.pathname === '/supabase/blocklist') {
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
        await supabaseFetch('/blocklist?phone=not.is.null', { method: 'DELETE' });

        const clean = rows.map(b => ({
          phone: String(b.phone || '').replace(/\D/g, '').slice(-8),
          reason: b.reason || '',
          blocked_at: b.blockedAt || b.blocked_at || new Date().toISOString(),
        })).filter(b => b.phone.length === 8);

        if (clean.length) {
          await supabaseFetch('/blocklist', {
            method: 'POST',
            body: JSON.stringify(clean),
          });
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

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const rows = Array.isArray(body.data) ? body.data : [];

      try {
        await supabaseFetch('/customers?phone=not.is.null', { method: 'DELETE' });

        const clean = rows.map(c => ({
          phone: String(c.phone || '').replace(/\D/g, '').slice(-8),
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
        })).filter(c => c.phone.length === 8);

        if (clean.length) {
          await supabaseFetch('/customers', {
            method: 'POST',
            body: JSON.stringify(clean),
          });
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

    // ── POST /order — public website order intake ──
    if (request.method === 'POST' && url.pathname === '/order') {
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
        order.status = order.status || 'inbox';
        order.gps = customerGPS(order);

        await supabaseFetch('/orders?on_conflict=id', {
          method: 'POST',
          headers: {
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({
            id: String(order.id),
            status: 'inbox',
            payload: order,
            updated_at: new Date().toISOString(),
          }),
        });

        return json({ ok: true, id: order.id });
      } catch (e) {
        return json({ error: e.message }, 502);
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

      if (!path.startsWith('menupictures/')) {
        return json({ error: 'Forbidden path' }, 403);
      }

      try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        await supabaseUploadImage(path, bytes, 'image/jpeg', env);
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
        await supabaseFetch('/products?id=not.is.null', { method: 'DELETE' });
        await supabaseFetch('/categories?id=not.is.null', { method: 'DELETE' });

        const categories = sections.map((sec, index) => ({
          key: sec.key || `category-${index}`,
          title: sec.title || 'Untitled',
          type: sec.type || 'regular',
          bottom_banner: sec.bottomBanner || null,
          sort_order: index,
          active: true,
          raw: sec,
          updated_at: new Date().toISOString(),
        }));

        if (categories.length) {
          await supabaseFetch('/categories', {
            method: 'POST',
            body: JSON.stringify(categories),
          });
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
              updated_at: new Date().toISOString(),
            });
          });
        });

        if (products.length) {
          await supabaseFetch('/products', {
            method: 'POST',
            body: JSON.stringify(products),
          });
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
        const rows = await supabaseFetch('/app_config?key=eq.site_settings&select=*');
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        return json({ data: row ? (row.value || {}) : {} });
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

      const value = body && typeof body.data === 'object' && body.data ? body.data : {};

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
            path: body.path || '',
            referrer: body.referrer || '',
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

  if (!b64 || b64.length > 14_000_000) {
    throw new Error('Image is too large. Max 10MB.');
  }

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
    throw new Error('Image is too large. Max 10MB.');
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
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const visitorId = galleryCleanText(body.visitorId, 80);
  if (!visitorId) return json({ error: 'Missing visitorId' }, 400);

  const submitDate = galleryCleanText(body.submitDate, 10) || galleryTodayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(submitDate)) {
    return json({ error: 'Invalid submitDate' }, 400);
  }

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
      try {
        const rows = await supabaseFetch('/orders?select=*&order=created_at.desc&limit=30');
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

    // ── POST /driver/:id/status — driver updates delivering/delivered (no auth) ──
    if (request.method === 'POST' && url.pathname.startsWith('/driver/') && url.pathname.endsWith('/status')) {
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

    // ── GET /driver/:id — public order details for driver ──
    if (request.method === 'GET' && url.pathname.startsWith('/driver/')) {
      const id = url.pathname.split('/driver/')[1];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

        const payload = row.payload || {};
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
        };

        return json({ ok: true, data: safe });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // ── POST /driver/:id/location — driver shares GPS location ──
    if (request.method === 'POST' && url.pathname.startsWith('/driver/') && url.pathname.endsWith('/location')) {
      const id = url.pathname.split('/driver/')[1].split('/location')[0];
      if (!id) return json({ error: 'Missing order ID' }, 400);

      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

      const lat = parseFloat(body.lat);
      const lng = parseFloat(body.lng);
      if (isNaN(lat) || isNaN(lng)) return json({ error: 'Invalid lat/lng' }, 400);
      const heading = Number(body.heading);

      try {
        const rows = await supabaseFetch(`/orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        const row = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!row) return json({ error: 'Order not found' }, 404);

        const payload = row.payload || {};
        if (!payload.tracking) payload.tracking = {};
        payload.tracking.driverLocation = {
          lat,
          lng,
          heading: Number.isFinite(heading) ? heading : payload.tracking.driverLocation?.heading ?? null,
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
