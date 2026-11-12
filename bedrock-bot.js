'use strict';
/**
 * Multi-player AFK bots (mineflayer, Java edition).
 *  - up to N players from settings.json -> roster.players (each has enabled / stay)
 *  - optional random names, random leave/rejoin schedule, min-online safety
 *  - each bot: wander (walk/run), flee mobs, hunt animals, eat, avoid caves, auto respawn
 *  - optional PIN keypad login (Kodeshi PIN plugin) and /login /register handling
 *  - MAX_RUNTIME_MIN env: exits cleanly so the GitHub workflow can start the next run
 */
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const config = require('./settings.json');
const express = require('express');
const human = require('./human');
const http = require('http');
const https = require('https');
const readline = require('readline');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rangeMs = (range, dflt) => { const r = range || dflt; return rand(r.min, r.max) * 60000; };

const R = config.roster || {};
const SC = config.schedule || {};
const startTime = Date.now();
let stopping = false;
const slots = [];

// Minecraft version the bots speak. Pinned value wins; if blank we auto-detect, and after an
// "invalid player movement" kick we fall back to 1.21.1 automatically.
let autoFallbackVersion = null;
const pinnedVersion = () => process.env.MC_VERSION || config.server.version || '';
const useVersion = () => pinnedVersion() || autoFallbackVersion || undefined;

// Optional proxy (SOCKS5 or HTTP): every bot leaves through the same fixed IP.
// type "auto" = try SOCKS5 first, switch to HTTP CONNECT if the proxy is not SOCKS.
let detectedProxyType = null;
function proxyConfig() {
  const P = config.proxy || {};
  const host = process.env.PROXY_HOST || (P.enabled ? P.host : '');
  if (!host) return null;
  return {
    host,
    port: parseInt(process.env.PROXY_PORT || P.port || '1080', 10),
    user: process.env.PROXY_USER || P.username || '',
    pass: process.env.PROXY_PASS || P.password || '',
    type: String(process.env.PROXY_TYPE || P.type || 'auto').toLowerCase(),
  };
}

function httpConnect(px, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(px.port, px.host);
    let buf = '';
    const fail = (e) => { try { sock.destroy(); } catch (x) { /* ignore */ } reject(e); };
    sock.setTimeout(20000, () => fail(new Error('proxy timeout')));
    sock.once('error', (e) => fail(new Error(e.message)));
    sock.once('connect', () => {
      const auth = px.user ? `Proxy-Authorization: Basic ${Buffer.from(`${px.user}:${px.pass}`).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m && m[1] === '200') {
        const rest = buf.slice(end + 4);
        if (rest.length) sock.unshift(Buffer.from(rest, 'latin1'));
        resolve(sock);
      } else {
        fail(new Error(`HTTP proxy refused the connection: ${buf.split('\r\n')[0]}`));
      }
    };
    sock.on('data', onData);
  });
}

async function openTunnel(px, host, port) {
  const type = px.type === 'auto' ? (detectedProxyType || 'socks5') : px.type;
  if (type === 'http' || type === 'https') return httpConnect(px, host, port);
  try {
    const { SocksClient } = require('socks');
    const info = await SocksClient.createConnection({
      proxy: { host: px.host, port: px.port, type: 5, userId: px.user || undefined, password: px.pass || undefined },
      command: 'connect',
      destination: { host, port },
      timeout: 20000,
    });
    return info.socket;
  } catch (e) {
    const msg = String(e && e.message);
    if (px.type === 'auto' && /invalid socks|initial handshake/i.test(msg)) {
      detectedProxyType = 'http';
      console.log('[Proxy] this is not a SOCKS5 proxy - switching to HTTP CONNECT');
      return httpConnect(px, host, port);
    }
    throw new Error(msg); // plain Error: never carries the proxy password
  }
}

function proxyConnector(px) {
  return (client) => {
    openTunnel(px, config.server.ip, config.server.port)
      .then((sock) => { trackSocket(sock); client.setSocket(sock); client.emit('connect'); })
      .catch((err) => client.emit('error', new Error(`proxy: ${err.message}`)));
  };
}

function checkPublicIp() {
  const px = proxyConfig();
  const done = (ip) => console.log(`[Net] IP the server sees: ${ip}${px ? ' (via proxy)' : ' (direct - this changes on every GitHub Actions run)'}`);
  const body = (txt) => (String(txt).split('\r\n\r\n').pop() || '').trim();
  if (!px) {
    http.get('http://api.ipify.org', (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => done(body(d)));
    }).on('error', (e) => console.log('[Net] IP check failed:', e.message));
    return;
  }
  openTunnel(px, 'api.ipify.org', 80).then((sock) => {
    trackSocket(sock);
    let d = '';
    sock.on('data', (c) => { d += c; });
    sock.on('end', () => done(body(d)));
    sock.on('error', () => {});
    sock.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
  }).catch((e) => console.log(`[Net] proxy check failed (bots cannot connect through it): ${e.message}`));
}

// ---- proxy traffic budget: spreads e.g. 10 GB over a year (a daily allowance) ----
const TRAFFIC_FILE = process.env.TRAFFIC_FILE || path.join(__dirname, 'traffic.json');
const traffic = { startedAt: Date.now(), total: 0, dayKey: '', totalAtDayStart: 0 };
try { Object.assign(traffic, JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'))); } catch (e) { /* first run */ }
let trafficDirty = true;
let budgetPausedUntil = 0;
const proxySockets = new Set();
const MB = 1e6;
const OVERHEAD = 1.08; // proxy providers count a little more than we can see
const nextMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

function countSocket(sock) {
  const cur = (sock.bytesRead || 0) + (sock.bytesWritten || 0);
  const delta = cur - (sock.__counted || 0);
  sock.__counted = cur;
  if (delta > 0) { traffic.total += delta; trafficDirty = true; }
}
function trackSocket(sock) {
  proxySockets.add(sock);
  sock.once('close', () => { countSocket(sock); proxySockets.delete(sock); });
}
function saveTraffic() {
  if (!trafficDirty) return;
  try { fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(traffic)); trafficDirty = false; } catch (e) { /* ignore */ }
}
function budgetInfo() {
  const P = config.proxy || {};
  const limit = (P['budget-gb'] || 10) * 1e9 * (P['budget-safety'] || 0.9);
  const days = P['budget-days'] || 365;
  const key = new Date().toISOString().slice(0, 10);
  if (traffic.dayKey !== key) { traffic.dayKey = key; traffic.totalAtDayStart = traffic.total; trafficDirty = true; }
  const daysLeft = Math.max(1, days - (Date.now() - traffic.startedAt) / 86400000);
  return {
    limit, days,
    usedTotal: traffic.total * OVERHEAD,
    allowToday: Math.max(0, (limit - traffic.totalAtDayStart * OVERHEAD) / daysLeft),
    usedToday: (traffic.total - traffic.totalAtDayStart) * OVERHEAD,
  };
}
function budgetTick() {
  if (!proxyConfig()) return;
  for (const sock of proxySockets) countSocket(sock);
  const bi = budgetInfo();
  const now = Date.now();
  if (budgetPausedUntil && now >= budgetPausedUntil) budgetPausedUntil = 0;
  if (!budgetPausedUntil && bi.usedToday >= bi.allowToday) {
    const exhausted = bi.usedTotal >= bi.limit;
    budgetPausedUntil = exhausted ? traffic.startedAt + bi.days * 86400000 : nextMidnight();
    console.log(exhausted
      ? '[Traffic] the whole proxy budget is used up - proxy bots stay offline until the period ends'
      : `[Traffic] today's proxy allowance is used (${(bi.usedToday / MB).toFixed(1)} of ${(bi.allowToday / MB).toFixed(1)} MB) - proxy bots rest until tomorrow (UTC)`);
    for (const sl of slots) {
      if (sl.useProxy && sl.bot && ['online', 'connecting', 'leaving'].includes(sl.status)) sl.stopForBudget();
    }
  }
  saveTraffic();
}
function printTraffic() {
  if (!proxyConfig()) return;
  const bi = budgetInfo();
  const n = slots.filter((x) => x.useProxy && x.status === 'online').length;
  console.log(`[Traffic] today ${(bi.usedToday / MB).toFixed(1)} / ${(bi.allowToday / MB).toFixed(1)} MB | total ${(bi.usedTotal / 1e9).toFixed(2)} / ${(bi.limit / 1e9).toFixed(1)} GB | ${n} bot(s) on the proxy`);
}
setInterval(budgetTick, 30000);
setInterval(printTraffic, 10 * 60000);

// Never let a NaN/Infinity movement packet leave the bot (the server kicks for those).
const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move',
  'move_player_pos', 'move_player_pos_rot', 'move_player_rot']);
function guardPackets(slot, b) {
  const c = b._client;
  if (!c || c.__guarded) return;
  c.__guarded = true;
  const orig = c.write.bind(c);
  let logged = 0;
  c.write = (name, params) => {
    if (MOVE_PACKETS.has(name) && params) {
      for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) {
        const v = params[k];
        if (typeof v === 'number' && !Number.isFinite(v)) {
          if (logged++ < 5) slot.log(`[Guard] dropped ${name} packet with invalid ${k}=${v}`);
          return undefined;
        }
      }
    }
    return orig(name, params);
  };
}

// If the physics engine ever produces a NaN position/rotation, restore the last good one.
function guardModule(slot, b) {
  let good = null;
  let lastLog = 0;
  b.on('physicsTick', () => {
    const e = b.entity;
    if (!e || !e.position) return;
    const p = e.position;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      good = { x: p.x, y: p.y, z: p.z };
    } else if (good) {
      p.set(good.x, good.y, good.z);
      if (e.velocity) e.velocity.set(0, 0, 0);
      if (Date.now() - lastLog > 10000) { lastLog = Date.now(); slot.log('[Guard] position was NaN - restored'); }
    }
    if (!Number.isFinite(e.yaw)) e.yaw = 0;
    if (!Number.isFinite(e.pitch)) e.pitch = 0;
  });
}

// ============================================================
// DISCORD
// ============================================================
function discord(content, color = 0x0099ff) {
  const ev = (config.discord && config.discord.events) || {};
  if (!config.discord || !config.discord.enabled) return;
  if (/joined|Died/.test(content) && ev.connect === false) return;
  if (/left|disconnected/.test(content) && ev.disconnect === false) return;
  const url = process.env.DISCORD_WEBHOOK || config.discord.webhookUrl;
  if (!url || url.includes('YOUR_DISCORD')) return;
  try {
    const u = new URL(url);
    const payload = JSON.stringify({
      username: config.name,
      embeds: [{ description: content, color, timestamp: new Date().toISOString() }],
    });
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, () => {});
    req.on('error', (e) => console.log(`[Discord] Error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    console.log(`[Discord] Error: ${e.message}`);
  }
}

// ============================================================
// NAMES
// ============================================================
const ADJ = ['Swift', 'Silent', 'Brave', 'Lucky', 'Crazy', 'Happy', 'Tiny', 'Mighty', 'Pixel', 'Shadow', 'Frost', 'Ember',
  'Cosmic', 'Rusty', 'Sneaky', 'Cool', 'Epic', 'Wild', 'Lazy', 'Salty', 'Fuzzy', 'Sunny', 'Dark', 'Neon'];
const NOUN = ['Fox', 'Wolf', 'Panda', 'Tiger', 'Miner', 'Builder', 'Creeper', 'Knight', 'Ninja', 'Dragon', 'Slime', 'Raven',
  'Otter', 'Gamer', 'Blaze', 'Falcon', 'Bear', 'Hunter', 'Archer', 'Wizard', 'Bat', 'Shark', 'Moth', 'Golem'];
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(n);

function namesInUse(except) {
  const used = new Set();
  for (const s of slots) {
    if (s === except) continue;
    if (['connecting', 'online', 'leaving'].includes(s.status)) used.add(s.name.toLowerCase());
  }
  return used;
}

function generateName(slot) {
  const used = namesInUse(slot);
  for (let i = 0; i < 60; i++) {
    const a = pick(ADJ);
    const n = pick(NOUN);
    const num = randInt(1, 999);
    const style = randInt(0, 3);
    const name = (style === 0 ? `${a}${n}` : style === 1 ? `${a}${n}${num}` : style === 2 ? `${n}${num}` : `${a}_${n}`).slice(0, 16);
    if (validName(name) && !used.has(name.toLowerCase())) return name;
  }
  return `Player${randInt(10000, 99999)}`;
}

function chooseName(slot) {
  if (R['randomize-names'] !== true) return slot.cfg.name;
  const used = namesInUse(slot);
  const pool = (R['name-pool'] || []).filter((n) => validName(n) && !used.has(n.toLowerCase()));
  return pool.length ? pick(pool) : generateName(slot);
}

// ============================================================
// CONNECT QUEUE (servers throttle fast reconnects)
// ============================================================
let nextConnectAt = 0;
function queueConnect(slot, delayMs) {
  const sp = SC['stagger-seconds'] || { min: 8, max: 20 };
  const at = Math.max(Date.now() + Math.min(delayMs, 2e9), nextConnectAt); // setTimeout max is ~24 days
  nextConnectAt = at + rand(sp.min, sp.max) * 1000;
  clearTimeout(slot.connTimer);
  slot.connTimer = setTimeout(() => slot.connect(), Math.max(0, at - Date.now()));
}

// ============================================================
// SLOT (one player)
// ============================================================
class Slot {
  constructor(index, cfg) {
    this.index = index;
    this.cfg = cfg;
    this.name = cfg.name;
    this.status = cfg.enabled === false ? 'disabled' : 'offline'; // offline|connecting|online|leaving|away|retry|disabled
    this.mode = '-';
    this.bot = null;
    this.timers = [];
    this.connTimer = null;
    this.leaveTimer = null;
    this.spawnTimeout = null;
    this.fails = 0;
    this.leaving = false;
    this.lastKick = '';
    this.diag = null;
    this.pinBusy = false;
    this.pinRuns = 0;
    this.pinNext = null;
    this.nextJoinAt = 0;
    this.budgetStop = false;
  }

  get useProxy() { return !!proxyConfig() && this.cfg.proxy !== false; }

  stopForBudget() {
    this.budgetStop = true;
    this.leaving = false;
    this.log('resting - daily proxy traffic allowance is used up');
    try { this.bot.quit('Resting'); } catch (e) { try { this.bot.end(); } catch (e2) { /* ignore */ } }
  }

  log(...a) { console.log(`[${this.name}]`, ...a); }
  addInterval(cb, d) { const id = setInterval(cb, d); this.timers.push(id); return id; }
  addTimeout(cb, d) { const id = setTimeout(cb, d); this.timers.push(id); return id; }
  clearTimers() { this.timers.forEach((id) => { clearInterval(id); clearTimeout(id); }); this.timers = []; }

  teardown() {
    clearTimeout(this.spawnTimeout);
    this.clearTimers();
    if (this.bot) {
      try { this.bot.removeAllListeners(); this.bot.end(); } catch (e) { /* ignore */ }
      this.bot = null;
    }
  }

  connect() {
    if (stopping || this.cfg.enabled === false) return;
    if (this.useProxy && Date.now() < budgetPausedUntil) {
      this.teardown();
      this.status = 'paused';
      queueConnect(this, budgetPausedUntil - Date.now() + rand(0, 600000));
      return;
    }
    this.teardown();
    this.name = chooseName(this);
    this.status = 'connecting';
    this.mode = '-';
    this.leaving = false;
    this.pinBusy = false;
    this.pinRuns = 0;
    this.pinNext = null;
    this.lastKick = '';
    const t0 = Date.now();
    this.log(`connecting to ${config.server.ip}:${config.server.port} (version ${useVersion() || 'auto'})`);

    let b;
    try {
      const opts = {
        username: this.name,
        auth: 'offline',
        host: config.server.ip,
        port: config.server.port,
        version: useVersion(),
        hideErrors: true, // mineflayer would print raw errors (they can contain proxy credentials)
        checkTimeoutInterval: 120000,
        viewDistance: 'short',
      };
      const px = this.useProxy ? proxyConfig() : null;
      if (px) {
        opts.connect = proxyConnector(px);
        opts.viewDistance = (config.proxy || {})['view-distance'] || 'tiny'; // fewer chunks = less traffic
      }
      b = mineflayer.createBot(opts);
    } catch (err) {
      this.log('failed to create bot:', err.message);
      this.onEnded('create failed');
      return;
    }
    this.bot = b;
    b.loadPlugin(pathfinder);
    guardPackets(this, b);
    setupAuth(this, b);
    setupPin(this, b);

    this.spawnTimeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.log('connection timeout (no spawn)');
        try { b.end(); } catch (e) { /* ignore */ }
      }
    }, 60000);

    b.once('spawn', () => {
      clearTimeout(this.spawnTimeout);
      this.status = 'online';
      this.fails = 0;
      this.log(`spawned after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      discord(`[+] **${this.name}** joined`, 0x4ade80);
      initializeSlot(this, b);
      this.scheduleLeave();
    });

    b.on('end', (reason) => {
      if (this.bot !== b) return;
      this.onEnded(reason);
    });

    b.on('kicked', (reason) => {
      const txt = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.lastKick = txt;
      this.log('[KICK]', txt);
      if (this.diag) this.log('[KICK] last movement state:', JSON.stringify(this.diag));
      if (/invalid_player_movement/.test(txt)) {
        if (!pinnedVersion() && !autoFallbackVersion) {
          autoFallbackVersion = '1.21.1';
          this.log('[Version] invalid movement kick on auto-detected version - switching to 1.21.1 for all bots');
        } else {
          this.log(`[Version] invalid movement kick on version ${useVersion()} - try another value in settings.json server.version`);
        }
      }
    });

    b.on('error', (err) => this.log('error:', err.message));
  }

  onEnded(reason) {
    clearTimeout(this.spawnTimeout);
    clearTimeout(this.leaveTimer);
    const wasOnline = this.status === 'online' || this.status === 'leaving';
    this.clearTimers();
    try { if (this.bot) this.bot.removeAllListeners(); } catch (e) { /* ignore */ }
    this.bot = null;
    this.mode = '-';

    if (stopping) { this.status = 'offline'; return; }

    if (this.budgetStop) {
      this.budgetStop = false;
      this.status = 'paused';
      queueConnect(this, Math.max(60000, budgetPausedUntil - Date.now()) + rand(0, 600000));
      return;
    }

    if (this.leaving) {
      this.leaving = false;
      this.status = 'away';
      const ms = rangeMs(SC['rejoin-minutes'], { min: 10, max: 20 });
      this.nextJoinAt = Date.now() + ms;
      this.log(`left (scheduled) - rejoining in ${(ms / 60000).toFixed(0)} min`);
      discord(`[-] **${this.name}** left`, 0xf87171);
      queueConnect(this, ms);
      return;
    }

    this.fails++;
    if (wasOnline) discord(`[-] **${this.name}** disconnected: ${reason || 'unknown'}`, 0xf87171);
    if (config.utils['auto-reconnect'] === false) { this.status = 'offline'; return; }

    this.status = 'retry';
    const base = config.utils['auto-reconnect-delay'] || 2000;
    const max = config.utils['max-reconnect-delay'] || 60000;
    let delay = Math.min(base + this.fails * 3000, max);
    if (/duplicate|already/i.test(this.lastKick)) delay = Math.max(delay, 60000);
    if (this.useProxy) delay = Math.max(delay, 30000); // every reconnect costs proxy traffic
    this.log(`disconnected: ${reason || 'unknown'} - reconnecting in ${(delay / 1000).toFixed(0)}s (attempt #${this.fails})`);
    queueConnect(this, delay);
  }

  scheduleLeave() {
    clearTimeout(this.leaveTimer);
    if (SC.enabled === false || this.cfg.stay === true) return;
    if (this.useProxy && (config.proxy || {})['schedule-leave'] !== true) return; // every rejoin costs proxy traffic
    const ms = rangeMs(SC['session-minutes'], { min: 60, max: 360 });
    this.log(`will leave in about ${(ms / 60000).toFixed(0)} min`);
    this.leaveTimer = setTimeout(() => this.tryLeave(), ms);
  }

  tryLeave() {
    if (this.status !== 'online') return;
    const minOnline = SC['min-online'] === undefined ? 2 : SC['min-online'];
    const others = slots.filter((s) => s !== this && s.status === 'online').length;
    if (others < minOnline) {
      this.log('postponing leave (keeping players on the server)');
      this.leaveTimer = setTimeout(() => this.tryLeave(), rand(5, 10) * 60000);
      return;
    }
    this.leaving = true;
    this.status = 'leaving';
    this.log('leaving (scheduled)');
    try { this.bot.quit('Leaving'); } catch (e) { try { this.bot.end(); } catch (e2) { /* ignore */ } }
  }
}

(R.players || []).forEach((p, i) => {
  if (!validName(p.name)) console.log(`[Config] players[${i}].name "${p.name}" is not a valid Minecraft name (3-16 letters/numbers/_)`);
  slots.push(new Slot(i, p));
});

const leadSlot = () => slots.find((s) => s.status === 'online');

// ============================================================
// LOGIN: /login /register + chat log
// ============================================================
function setupAuth(slot, b) {
  const auth = (config.utils && config.utils['auto-auth']) || {};
  const pw = auth.password || 'Perzuu';
  let lastAuth = 0;

  b.on('messagestr', (msg) => {
    const raw = String(msg);
    if (config.utils['chat-log'] !== false && raw.trim() && leadSlot() === slot) console.log('[Server]', raw.slice(0, 160));
    if (auth.enabled === false) return;
    const m = raw.toLowerCase();
    if (m.startsWith('<')) return;
    const now = Date.now();
    if (now - lastAuth < 20000) return;
    if (m.includes('/register')) {
      lastAuth = now;
      b.chat(`/register ${pw} ${pw}`);
      slot.log('[Auth] register sent');
    } else if (m.includes('/login')) {
      lastAuth = now;
      b.chat(`/login ${pw}`);
      slot.log('[Auth] login sent');
    }
  });
}

// ============================================================
// PIN KEYPAD (GUI login). Works by reading item names in the window.
// If auto-detect fails the log lists every slot name so you can fill utils.pin-auth.slots.
// ============================================================
function labelOf(item) {
  if (!item) return '';
  let raw = '';
  try {
    if (item.customName) raw = typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName);
  } catch (e) { /* ignore */ }
  if (!raw) raw = item.displayName || item.name || '';
  const texts = [];
  // plain JSON chat component:  "text":"3"      and NBT style:  "text":{"type":"string","value":"3"}
  const re = /"text"\s*:\s*(?:\{\s*"type"\s*:\s*"string"\s*,\s*"value"\s*:\s*)?"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw))) texts.push(m[1]);
  const joined = texts.length ? texts.join('') : raw;
  return joined.replace(/§./g, '').replace(/\\u00a7./gi, '').replace(/[^\x20-\x7e]/g, '').trim();
}

// ---- PinAuth keypad (Kodeshi plugin): default layout from its config.yml ----
const PIN_DEFAULT_DIGITS = [49, 21, 22, 23, 30, 31, 32, 39, 40, 41]; // index = digit 0..9
const PIN_DEFAULT_CONFIRM = 53;
const PIN_DEFAULT_ADMIN = 46; // "Admin only" button (nether star)
const isPane = (it) => !it || /glass_pane$/.test(it.name);

function isWeakPin(p) {
  if (new Set(p).size === 1) return true;
  let asc = true;
  let desc = true;
  for (let i = 1; i < p.length; i++) {
    if (p.charCodeAt(i) !== p.charCodeAt(i - 1) + 1) asc = false;
    if (p.charCodeAt(i) !== p.charCodeAt(i - 1) - 1) desc = false;
  }
  return asc || desc;
}

// every bot gets its own stable PIN: HMAC(secret, name) -> digits (same name = same PIN, on every run)
function derivePin(secret, name, len) {
  for (let i = 0; i < 25; i++) {
    const h = crypto.createHmac('sha256', secret).update(`${String(name).toLowerCase()}:${i}`).digest();
    const pin = String(h.readUInt32BE(0) % 10 ** len).padStart(len, '0');
    if (!isWeakPin(pin)) return pin;
  }
  return '482915'.slice(0, len);
}

function titleOf(win) {
  return (typeof win.title === 'string' ? win.title : JSON.stringify(win.title || '')).toLowerCase();
}
function flowOfWindow(win) {
  const t = titleOf(win);
  if (t.includes('new pin') || t.includes('current pin')) return 'change';
  if (t.includes('confirm')) return 'confirm';
  if (t.includes('register')) return 'register';
  if (t.includes('login')) return 'login';
  return 'unknown';
}

function findDigitSlot(win, d) {
  const end = win.inventoryStart || win.slots.length;
  const re = new RegExp(`(^|[^0-9])${d}([^0-9]|$)`);
  for (let i = 0; i < end; i++) {
    const lab = labelOf(win.slots[i]);
    if (!lab || isPane(win.slots[i])) continue;
    if (lab === d || (re.test(lab) && (lab.match(/\d/g) || []).length === 1)) return i;
  }
  return undefined;
}

function dumpWindow(slot, win, why) {
  const end = win.inventoryStart || win.slots.length;
  const items = [];
  for (let i = 0; i < end; i++) {
    const it = win.slots[i];
    if (it && !isPane(it)) items.push(`${i}:${it.name}"${labelOf(it)}"`);
  }
  slot.log(`[PIN] ${why} | title=${titleOf(win).slice(0, 80)} | items: ${items.join(' ').slice(0, 1500) || '(none)'}`);
}

async function clickSlot(b, idx) {
  await Promise.race([b.clickWindow(idx, 0, 0), sleep(2500)]).catch(() => {});
}

global.__pinBad = global.__pinBad || {}; // accounts whose login failed once - never retry (4 wrong tries lock the account)

function setupPin(slot, b) {
  const P = (config.utils && config.utils['pin-auth']) || {};
  if (P.enabled === false) return;
  const len = P.length || 6;
  const fixed = String(process.env.BOT_PIN || P.pin || '');
  const secret = String(process.env.BOT_PIN_SECRET || P.secret || '');
  const adminPin = String(process.env.BOT_ADMIN_PIN || P['admin-pin'] || '');
  // the bot's own PIN: BOT_PIN, else derived from BOT_PIN_SECRET, else the admin PIN itself
  const pin = /^\d{4,8}$/.test(fixed) ? fixed : (secret ? derivePin(secret, slot.name, len) : (/^\d{4,8}$/.test(adminPin) ? adminPin : ''));
  const adminSlotCfg = P['admin-slot'] === undefined ? PIN_DEFAULT_ADMIN : P['admin-slot'];
  const needle = String(P['window-title-contains'] === undefined ? 'Kodeshi' : P['window-title-contains']).toLowerCase();
  const manual = P.slots || {};
  const delay = P['click-delay-ms'] || 450;
  const confirmSlot = P['confirm-slot'] === undefined || P['confirm-slot'] === null ? PIN_DEFAULT_CONFIRM : P['confirm-slot'];
  const key = slot.name.toLowerCase();

  // does the window look like the plugin's default layout? (all ten digit slots hold the same item)
  function defaultLayoutOk(win) {
    const first = win.slots[PIN_DEFAULT_DIGITS[0]];
    return !!first && !isPane(first) && PIN_DEFAULT_DIGITS.every((i) => win.slots[i] && win.slots[i].name === first.name);
  }
  function digitSlot(win, d) {
    const m = manual[d];
    if (m !== undefined && win.slots[m] && !isPane(win.slots[m])) return m;
    if (defaultLayoutOk(win)) return PIN_DEFAULT_DIGITS[Number(d)];
    return findDigitSlot(win, d);
  }
  function findConfirm(win) {
    const c = win.slots[confirmSlot];
    if (c && !isPane(c) && (c.name === 'lime_concrete' || P['confirm-slot'] !== undefined)) return confirmSlot;
    const end = win.inventoryStart || win.slots.length;
    for (let i = 0; i < end; i++) if (/confirm/i.test(labelOf(win.slots[i])) && !isPane(win.slots[i])) return i;
    return undefined;
  }

  function findAdmin(win) {
    const a = win.slots[adminSlotCfg];
    if (a && !isPane(a) && (a.name === 'nether_star' || P['admin-slot'] !== undefined)) return adminSlotCfg;
    const end = win.inventoryStart || win.slots.length;
    for (let i = 0; i < end; i++) if (/admin/i.test(labelOf(win.slots[i])) && !isPane(win.slots[i])) return i;
    return undefined;
  }

  async function typeDigits(win, digits) {
    for (const d of digits) {
      if (b.currentWindow !== win) return false;
      const idx = digitSlot(win, d);
      if (idx === undefined) { dumpWindow(slot, win, `cannot find digit ${d} - set utils.pin-auth.slots`); return false; }
      await clickSlot(b, idx);
      await sleep(delay);
    }
    return b.currentWindow === win;
  }

  async function run(win) {
    slot.pinBusy = true;
    try {
      await sleep(P['first-delay-ms'] || 1000); // the items arrive just after the window opens
      if (b.currentWindow !== win) return;
      const flow = flowOfWindow(win);
      if (flow === 'change' || flow === 'unknown') { dumpWindow(slot, win, `ignoring window (${flow})`); return; }
      if (!pin && !adminPin) {
        if (!global.__pinWarned) {
          global.__pinWarned = true;
          slot.log('[PIN] a keypad is open but no PIN is configured. Set the BOT_ADMIN_PIN secret (the plugin admin-only PIN) or BOT_PIN / BOT_PIN_SECRET.');
        }
        return;
      }
      if (flow === 'login' && global.__pinBad[key]) {
        slot.log(`[PIN] ${slot.name}: the last login was rejected - not trying again (wrong tries lock the account). Run /pinreset ${slot.name} and the bot will register again.`);
        return;
      }
      const adminBtn = adminPin ? findAdmin(win) : undefined;
      const confirmBtn = findConfirm(win);
      if (flow === 'login') {
        if (adminBtn !== undefined) {
          slot.log('[PIN] login screen - typing the admin PIN and pressing "Admin only"');
          if (!(await typeDigits(win, adminPin))) return;
          await sleep(delay);
          await clickSlot(b, adminBtn);
          await sleep(2300); // the plugin allows one check per 1.5 s; a successful login closes the window
          if (b.currentWindow !== win) return;
          if (!pin || confirmBtn === undefined) { global.__pinBad[key] = true; slot.log('[PIN] the admin key was not accepted (is this account an operator?)'); return; }
          slot.log('[PIN] admin key not accepted - trying the normal PIN once');
        } else {
          slot.log('[PIN] login screen - entering PIN');
        }
        if (!pin || confirmBtn === undefined) { dumpWindow(slot, win, 'cannot log in (no PIN / confirm button)'); return; }
        if (!(await typeDigits(win, pin))) return;
        await sleep(delay);
        await clickSlot(b, confirmBtn);
        await sleep(2500);
        if (b.currentWindow === win) { global.__pinBad[key] = true; slot.log('[PIN] login did not work - will not retry'); }
        return;
      }
      if (flow === 'register') {
        if (adminBtn !== undefined) {
          slot.log('[PIN] register screen - typing the admin PIN and pressing "Admin only"');
          if (!(await typeDigits(win, adminPin))) return;
          await sleep(delay);
          await clickSlot(b, adminBtn);
          await sleep(1200);
          if (b.currentWindow !== win) return;
        }
      }
      // register (own PIN) and the "Confirm PIN" screen: type the PIN, press Confirm
      if (!pin || confirmBtn === undefined) { dumpWindow(slot, win, 'cannot enter the PIN (no PIN / confirm button)'); return; }
      slot.log(`[PIN] ${flow} screen - entering the PIN`);
      if (!(await typeDigits(win, pin))) return;
      await sleep(delay);
      await clickSlot(b, confirmBtn);
      slot.log(`[PIN] ${flow} PIN submitted`);
    } catch (e) {
      slot.log('[PIN] error:', e.message);
    } finally {
      slot.pinBusy = false;
      if (slot.pinNext) { // the plugin opened the "Confirm PIN" screen while we were clicking
        const w = slot.pinNext;
        slot.pinNext = null;
        if (b.currentWindow === w && ++slot.pinRuns <= 8) run(w);
      }
    }
  }

  b.on('windowOpen', (win) => {
    try {
      if (needle && !titleOf(win).includes(needle)) return;
      if (slot.pinBusy) { slot.pinNext = win; return; }
      if (++slot.pinRuns > 8) return;
      run(win);
    } catch (e) { slot.log('[PIN] error:', e.message); }
  });

  b.on('windowClose', () => { if (slot.pinBusy || slot.pinNext) slot.log('[PIN] window closed'); });

  // what the plugin tells us
  let said = 0;
  b.on('messagestr', (msg) => {
    const t = String(msg).replace(/§./g, '').trim();
    if (/PIN saved|Login successful|logged in automatically/i.test(t)) {
      slot.log(`[PIN] success: ${t}`);
      delete global.__pinBad[key];
    } else if (/Incorrect PIN/i.test(t)) {
      global.__pinBad[key] = true;
      slot.log(`[PIN] the server rejected the PIN: ${t}`);
    } else if (/administrator reset your PIN/i.test(t)) {
      delete global.__pinBad[key];
      slot.log('[PIN] an admin reset this PIN - the bot will register a new one');
    } else if (/Admin verified|Wrong admin PIN|Admin accounts must first/i.test(t)) {
      slot.log(`[PIN] server: ${t}`);
    } else if (/did not match|too easy to guess|already has a PIN|too many|locked|must be exactly/i.test(t) && said++ < 6) {
      slot.log(`[PIN] server: ${t}`);
    }
  });
}

// ============================================================
// PER-BOT MODULES
// ============================================================
function initializeSlot(slot, b) {
  guardModule(slot, b);
  if (config.movement && config.movement.enabled !== false) startBrain(slot, b);
  if (config.modules && config.modules.beds) bedModule(slot, b);

  const auth = (config.utils && config.utils['auto-auth']) || {};
  if (auth.enabled !== false && auth['proactive-login'] === true) {
    slot.addTimeout(() => { if (slot.bot === b) b.chat(`/login ${auth.password || 'Perzuu'}`); }, 4000);
  }
  if (config.utils['auto-creative'] === true) {
    slot.addTimeout(() => { if (slot.bot === b) b.chat('/gamemode creative'); }, 3000);
  }
}

function bedModule(slot, b) {
  slot.addInterval(async () => {
    if (slot.status !== 'online' || b.isSleeping) return;
    try {
      const t = b.time.timeOfDay;
      const isNight = t >= 12500 && t <= 23500;
      if (!(config.beds && config.beds['place-night']) || !isNight) return;
      const bed = b.findBlock({ matching: (blk) => blk.name.includes('bed'), maxDistance: 8 });
      if (bed) { await b.sleep(bed); slot.log('[Bed] sleeping'); }
    } catch (e) { /* cannot sleep right now */ }
  }, 10000);
}

// ============================================================
// BRAIN
//  priority: flee hostiles > eat > go home if too far/deep > visit joining players
//            > hunt animals (chase until dead, collect drops) > wander (walk / run)
// ============================================================
const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom',
  'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'warden', 'breeze',
]);
const RADIUS = { creeper: 9, skeleton: 16, stray: 16, pillager: 18, witch: 12, ghast: 30, blaze: 14, phantom: 18, enderman: 7, warden: 25 };
const AIR = new Set(['air', 'cave_air', 'void_air']);
const DANGER = new Set(['lava', 'water', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'powder_snow', 'cobweb']);
const NO_EAT = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'chorus_fruit']);
const PF = new Set(['hunt', 'collect', 'home', 'task', 'fight']); // modes driven by the pathfinder
const fin = (v, d) => (Number.isFinite(v) ? v : d);

function startBrain(slot, b) {
  const W = (config.movement && config.movement.wander) || {};
  const H = config.hunt || {};
  const E = config.eat || {};
  const SF = config.safety || {};
  const log = (...a) => slot.log(...a);

  // eco mode (proxy bots): stay close, so fewer new chunks are downloaded
  const eco = slot.useProxy && (config.proxy || {}).eco !== false;
  const leash = eco ? Math.min(W.leash || 22, 10) : (W.leash || 22);
  const nightLeash = eco ? Math.min(W['night-leash'] || 12, 6) : (W['night-leash'] || 12);
  const visitDistance = W['visit-distance'] || 14;
  const nightRest = !!W['night-rest'];
  const sprintChance = W['sprint-chance'] !== undefined ? W['sprint-chance'] : 0.4;

  const huntEnabled = H.enabled !== false;
  const huntAlways = H.always === true;
  const huntRange = eco ? Math.min(H.range || 24, 12) : (H.range || 24);
  const huntNames = new Set(H.animals || ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);

  const eatEnabled = E.enabled !== false;
  const eatBelow = E.below || 14;

  const avoidCaves = SF['avoid-caves'] !== false;
  const minSky = SF['min-sky-light'] || 9;
  const maxDescent = SF['max-descent'] || 4;
  const fleeHealth = SF['flee-health'] || 8;

  const C = config.combat || {};
  const combatEnabled = C.enabled !== false;
  const engageRange = C['engage-range'] || 8;
  const fightSet = new Set(C['fight-mobs'] || ['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
    'spider', 'cave_spider', 'slime', 'silverfish', 'endermite', 'witch']);
  fightSet.delete('creeper'); // never melee creepers - always run
  const retaliateHits = C['retaliate-hits'] || 3;
  const retaliateWindow = (C['retaliate-window-seconds'] || 12) * 1000;
  const retaliateFor = (C['retaliate-seconds'] || 30) * 1000;
  const assistEnabled = C.assist !== false;

  const p0 = b.entity.position;
  let origin = config.position && config.position.enabled
    ? { x: config.position.x, y: config.position.y, z: config.position.z }
    : { x: fin(p0.x, 0), y: Math.floor(fin(p0.y, 64)), z: fin(p0.z, 0) };

  const now0 = Date.now();
  const S = {
    still: '', t0: now0, ready: false, lastWait: 0, lastBadPos: 0,
    mode: 'idle', until: 0, modeStart: 0,
    yaw: fin(b.entity.yaw, 0), pitch: 0, heading: fin(b.entity.yaw, 0), nextLook: 0,
    visit: [], lastVisit: {}, visitTarget: null,
    sx: fin(p0.x, 0), sz: fin(p0.z, 0), sampleT: 0, lastTurn: 0, hopUntil: 0, nextHop: now0 + 8000,
    sprintWalk: false, lastNoSafe: 0,
    prey: null, preyDead: false, blacklist: {}, lastHit: 0, nextHunt: 0, huntBestD: 1e9, huntProgressT: 0,
    nextCollectScan: 0, nextHome: 0, pfFailed: false,
    eating: false, nextEat: 0,
    foe: null, foeDead: false, nextFoeScan: 0, hostilePlayers: {}, fleeEntity: null, fleeUntil: 0, lastHurtAt: 0, hits: {}, swings: {},
    beatX: fin(p0.x, 0), beatZ: fin(p0.z, 0),
  };
  const T = { dark: false, deep: false };

  // ---------- pathfinder (never digs or places blocks) ----------
  const moves = new Movements(b);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowParkour = false;
  moves.allowSprinting = false;
  moves.maxDropDown = 2;
  moves.scafoldingBlocks = [];
  moves.liquidCost = 50;
  if (avoidCaves) {
    moves.exclusionAreasStep = [(blk) => (blk && typeof blk.skyLight === 'number' && blk.skyLight < minSky ? 200 : 0)];
  }
  b.pathfinder.setMovements(moves);
  b.pathfinder.thinkTimeout = 3000;

  b.on('path_update', (r) => {
    if (r && (r.status === 'noPath' || r.status === 'timeout') && PF.has(S.mode)) S.pfFailed = true;
  });

  // ---------- helpers ----------
  const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const yawTo = (tx, tz) => {
    const p = b.entity.position;
    return Math.atan2(-(tx - p.x), -(tz - p.z));
  };
  const isNight = () => !!b.time && b.time.timeOfDay >= 13000 && b.time.timeOfDay < 23000;
  const isAir = (blk) => !!blk && AIR.has(blk.name);
  const isDanger = (blk) => !!blk && DANGER.has(blk.name);
  const darkAt = (pos) => {
    const blk = b.blockAt(pos);
    return !!blk && typeof blk.skyLight === 'number' && blk.skyLight < minSky;
  };

  function stopControls() { try { b.clearControlStates(); } catch (e) { /* ignore */ } }
  function stopPathfinder() {
    try { b.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
    stopControls();
  }

  let hum = null;
  function setMode(m, ms) {
    if (hum && S.mode === 'task' && m !== 'task') hum.cancelTask();
    if (S.mode === 'fight' && m !== 'fight') S.foe = null;
    if (PF.has(S.mode) && !PF.has(m)) stopPathfinder();
    S.mode = m; S.modeStart = Date.now(); S.until = Date.now() + ms;
    slot.mode = m;
  }
  setMode('idle', 300);

  hum = human.create({
    slot, b, config, log, slots, leadSlot, eco,
    getOrigin: () => origin,
    enterTask: (ms) => setMode('task', ms),
    endTask: () => { if (S.mode === 'task') setMode('idle', rand(600, 1800)); },
  });

  function computeUnsafeAhead(yaw) {
    const p = b.entity.position;
    for (const d of [1.0, 2.0, 3.0]) {
      const f = p.offset(-Math.sin(yaw) * d, 0, -Math.cos(yaw) * d).floored();
      const b0 = b.blockAt(f);
      const b1 = b.blockAt(f.offset(0, -1, 0));
      const b2 = b.blockAt(f.offset(0, -2, 0));
      const b3 = b.blockAt(f.offset(0, -3, 0));
      if (isDanger(b0) || isDanger(b1)) return true;
      if (isAir(b1) && isAir(b2) && isAir(b3)) return true;
      if (!T.deep) {
        if (f.y < origin.y - maxDescent) return true;
        if (avoidCaves && !T.dark && darkAt(f)) return true;
      }
    }
    return false;
  }

  // cached for 250 ms so the 20 Hz loop stays light (lag causes bursts of position packets)
  const aheadCache = new Map();
  let aheadCacheT = 0;
  function unsafeAhead(yaw) {
    const t = Date.now();
    if (t - aheadCacheT > 250) { aheadCache.clear(); aheadCacheT = t; }
    const k = Math.round(yaw * 8);
    if (aheadCache.has(k)) return aheadCache.get(k);
    const r = computeUnsafeAhead(yaw);
    aheadCache.set(k, r);
    return r;
  }

  // 'free' = nothing in the way, 'step' = 1-block step we can jump, 'wall' = cannot be climbed
  function obstacleAhead(yaw) {
    const p = b.entity.position;
    const f = p.offset(-Math.sin(yaw) * 0.9, 0, -Math.cos(yaw) * 0.9).floored();
    const front = b.blockAt(f);
    if (!front || front.boundingBox !== 'block') return 'free';
    if (/fence|_wall|gate/.test(front.name)) return 'wall';
    const clear = (x) => !x || x.boundingBox === 'empty';
    return clear(b.blockAt(f.offset(0, 1, 0))) && clear(b.blockAt(f.offset(0, 2, 0))) ? 'step' : 'wall';
  }

  function pickSafeHeading(base) {
    for (const off of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      if (!unsafeAhead(base + off)) return base + off;
    }
    return null;
  }

  // things to run away from: creepers & other dangerous mobs, mobs we cannot fight right now,
  // and an attacker we gave up fighting
  function nearestThreat() {
    const me = b.entity.position;
    const now = Date.now();
    if (S.fleeEntity && now < S.fleeUntil && b.entities[S.fleeEntity.id]) return S.fleeEntity;
    const lowHp = b.health < fleeHealth;
    const scale = lowHp ? 1.5 : 1;
    let nearFight = 0;
    if (combatEnabled) {
      for (const e of Object.values(b.entities)) {
        if (e && e.position && fightSet.has(e.name) && Math.hypot(e.position.x - me.x, e.position.z - me.z) < 8) nearFight++;
      }
    }
    let best = null;
    let bd = 1e9;
    for (const e of Object.values(b.entities)) {
      if (!e || e === b.entity || !e.position || !HOSTILE.has(e.name)) continue;
      if (combatEnabled && fightSet.has(e.name) && !lowHp && nearFight < 4) continue; // we fight these
      if (Math.abs(e.position.y - me.y) > 10) continue;
      const d = Math.hypot(e.position.x - me.x, e.position.z - me.z);
      if (d < (RADIUS[e.name] || 10) * scale && d < bd) { best = e; bd = d; }
    }
    return best;
  }

  function pickWalkHeading(leashNow) {
    const p = b.entity.position;
    if (Math.hypot(origin.x - p.x, origin.z - p.z) > leashNow) {
      return yawTo(origin.x, origin.z) + rand(-0.45, 0.45);
    }
    return rand(-Math.PI, Math.PI);
  }

  // ---------- food ----------
  function pickFood() {
    const foods = b.registry.foods || {};
    const list = b.inventory.items().filter((i) => foods[i.type] && !NO_EAT.has(i.name));
    if (!list.length) return null;
    list.sort((a, c) => foods[c.type].foodPoints - foods[a.type].foodPoints);
    return list[0];
  }

  async function eatNow(food) {
    S.eating = true;
    stopPathfinder();
    try {
      await b.equip(food, 'hand');
      await Promise.race([
        b.consume(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('eat timeout')), 6000)),
      ]);
      log(`[Eat] ate ${food.name} (food now ${b.food})`);
    } catch (e) {
      log('[Eat] error:', e.message);
      try { b.deactivateItem(); } catch (e2) { /* ignore */ }
    }
    S.eating = false;
    S.nextEat = Date.now() + 1500;
  }

  // ---------- hunting ----------
  async function equipWeapon() {
    try {
      const items = b.inventory.items();
      const w = items.find((i) => i.name.endsWith('_sword')) || items.find((i) => i.name.endsWith('_axe'));
      if (w) await b.equip(w, 'hand');
    } catch (e) { /* ignore */ }
  }

  function findPrey(now) {
    const me = b.entity.position;
    let best = null;
    let bd = huntRange;
    for (const e of Object.values(b.entities)) {
      if (!e || !e.position || !huntNames.has(e.name) || e.isValid === false) continue;
      if ((S.blacklist[e.id] || 0) > now) continue;
      const d = e.position.distanceTo(me);
      if (d >= bd) continue;
      if (Math.hypot(e.position.x - origin.x, e.position.z - origin.z) > leash + 20) continue;
      if (e.position.y < origin.y - maxDescent) continue;
      if (avoidCaves && darkAt(e.position.floored())) continue;
      best = e; bd = d;
    }
    return best;
  }

  function startHunt(now) {
    const prey = findPrey(now);
    if (!prey) return false;
    S.prey = prey; S.preyDead = false; S.pfFailed = false; S.huntBestD = 1e9; S.huntProgressT = now;
    setMode('hunt', 45000);
    b.pathfinder.setGoal(new goals.GoalFollow(prey, 1.6), true);
    equipWeapon();
    log(`[Hunt] chasing ${prey.name}`);
    return true;
  }

  function huntTick(now, p) {
    const prey = S.prey;
    const alive = prey && !S.preyDead && b.entities[prey.id];
    if (!alive) {
      log('[Hunt] target down - collecting drops');
      S.prey = null; S.nextHunt = now + 2500;
      setMode('collect', 7000);
      try { b.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
      S.nextCollectScan = now + 800;
      return;
    }
    if (now > S.until || b.health < 8 || S.pfFailed) {
      S.blacklist[prey.id] = now + 60000;
      S.prey = null; S.nextHunt = now + 5000;
      log('[Hunt] giving up on target');
      setMode('idle', 800);
      return;
    }
    const eye = p.offset(0, 1.6, 0);
    const target = prey.position.offset(0, (prey.height || 1) * 0.5, 0);
    const d = eye.distanceTo(target);
    if (d < S.huntBestD - 0.5) { S.huntBestD = d; S.huntProgressT = now; }
    else if (now - S.huntProgressT > 9000) { S.pfFailed = true; return; }
    if (d < 3.2) {
      b.lookAt(target, true);
      if (now - S.lastHit > 600) {
        S.lastHit = now;
        S.huntProgressT = now;
        try { b.attack(prey); } catch (e) { /* ignore */ }
      }
    }
  }

  function nearestItem(r) {
    let best = null;
    let bd = r;
    for (const e of Object.values(b.entities)) {
      if (!e || !e.position || (e.name !== 'item' && e.objectType !== 'Item')) continue;
      const d = e.position.distanceTo(b.entity.position);
      if (d < bd) { best = e; bd = d; }
    }
    return best;
  }

  function collectTick(now) {
    if (now > S.until) { setMode('idle', 500); return; }
    if (now < S.nextCollectScan) return;
    S.nextCollectScan = now + 500;
    const it = nearestItem(10);
    if (!it) {
      if (now - S.modeStart > 2500) setMode('idle', 500);
      return;
    }
    S.pfFailed = false;
    b.pathfinder.setGoal(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.8));
  }

  function startHome() {
    log('[Brain] too far from home or too deep - heading back');
    S.pfFailed = false;
    setMode('home', 40000);
    b.pathfinder.setGoal(new goals.GoalNear(origin.x, origin.y, origin.z, 3));
  }

  // ---------- fighting ----------
  function resolveAssist(a) {
    if (a.player) { const pl = b.players[a.player]; return pl && pl.entity ? pl.entity : null; }
    let best = null;
    let bd = 12;
    for (const e of Object.values(b.entities)) {
      if (!e || !e.position || !fightSet.has(e.name)) continue;
      const d = Math.hypot(e.position.x - a.pos.x, e.position.z - a.pos.z);
      if (d < bd) { best = e; bd = d; }
    }
    return best;
  }

  function pickFoe(now) {
    if (!combatEnabled || b.health < 10) return null;
    const me = b.entity.position;
    for (const [name, until] of Object.entries(S.hostilePlayers)) {
      if (until < now) { delete S.hostilePlayers[name]; continue; }
      const pl = b.players[name];
      if (pl && pl.entity && pl.entity.position.distanceTo(me) < 16) return pl.entity;
    }
    let best = null;
    let bd = engageRange;
    for (const e of Object.values(b.entities)) {
      if (!e || e === b.entity || !e.position || !fightSet.has(e.name)) continue;
      if (Math.abs(e.position.y - me.y) > 4) continue;
      const d = e.position.distanceTo(me);
      if (d < bd) { best = e; bd = d; }
    }
    if (best) return best;
    if (assistEnabled) {
      const a = hum.assistFor(me);
      if (a) { const e = resolveAssist(a); if (e) return e; }
    }
    return null;
  }

  function startFight(foe) {
    S.foe = foe; S.foeDead = false; S.pfFailed = false; S.lastHit = 0;
    const isPlayer = foe.type === 'player';
    setMode('fight', isPlayer ? retaliateFor : 25000);
    b.pathfinder.setGoal(new goals.GoalFollow(foe, 1.6), true);
    equipWeapon();
    hum.feel('angry', 20000);
    log(`[Fight] engaging ${foe.username || foe.name}`);
  }

  function fightTick(now) {
    const foe = S.foe;
    const alive = foe && !S.foeDead && b.entities[foe.id];
    const isPlayer = !!foe && foe.type === 'player';
    if (!alive || now > S.until || (isPlayer && !(S.hostilePlayers[foe.username] > now))) {
      if (foe && S.foeDead && !isPlayer) hum.onKill();
      if (foe && isPlayer && !alive) delete S.hostilePlayers[foe.username]; // we won / they are gone
      log(`[Fight] over (${alive ? 'timeout' : 'target gone'})`);
      S.foe = null; S.nextFoeScan = now + 1500;
      setMode('idle', 600);
      return;
    }
    if (b.health < fleeHealth) {
      log('[Fight] health low - running away');
      S.fleeEntity = foe; S.fleeUntil = now + 8000;
      hum.feel('scared', 15000);
      S.foe = null;
      setMode('idle', 300);
      return;
    }
    const d = b.entity.position.distanceTo(foe.position);
    if (d > 26) { S.foe = null; setMode('idle', 600); return; }
    if (d < 3.2) {
      try { b.lookAt(foe.position.offset(0, (foe.height || 1.6) * 0.8, 0), true); } catch (e) { /* ignore */ }
      if (now - S.lastHit > 550) {
        S.lastHit = now;
        try { b.attack(foe); } catch (e) { /* ignore */ }
      }
    }
  }

  // who hurt us? mobs next to us, or a player who just swung at us (3 hits in a row = we fight back)
  function onSelfHurt() {
    const now = Date.now();
    if (now - S.lastHurtAt < 300) return;
    S.lastHurtAt = now;
    const me = b.entity.position;
    let mob = null;
    let md = 5;
    for (const e of Object.values(b.entities)) {
      if (!e || e === b.entity || !e.position || !HOSTILE.has(e.name)) continue;
      const d = e.position.distanceTo(me);
      if (d < md) { mob = e; md = d; }
    }
    if (mob) {
      hum.onHurt('mob', mob.name);
      if (assistEnabled && fightSet.has(mob.name)) hum.reportAttack(me, null);
      return;
    }
    let attacker = null;
    let pd = 6.5;
    for (const pl of Object.values(b.players)) {
      const e = pl.entity;
      if (!e || e === b.entity || slots.some((s) => s.name === pl.username)) continue;
      if (now - (S.swings[e.id] || 0) > 700) continue;
      const d = e.position.distanceTo(me);
      if (d < pd) { attacker = pl; pd = d; }
    }
    if (!attacker) return; // fall damage, fire, hunger...
    const name = attacker.username;
    const arr = (S.hits[name] = (S.hits[name] || []).filter((t) => now - t < retaliateWindow));
    arr.push(now);
    hum.onHurt('player', name);
    hum.onPlayerHit(name, arr.length);
    const need = retaliateHits + (hum.friendship(name) >= 8 ? 2 : 0);
    if (arr.length >= need && !(S.hostilePlayers[name] > now)) {
      S.hostilePlayers[name] = now + retaliateFor;
      hum.onRetaliate(name);
      if (assistEnabled) hum.reportAttack(me, name);
    }
  }

  b.on('entitySwingArm', (e) => { if (e) S.swings[e.id] = Date.now(); });
  b.on('entityHurt', (e) => {
    if (e !== b.entity) return;
    try { onSelfHurt(); } catch (err) { log('[Fight] error:', err.message); }
  });

  // ---------- visiting joining players (never our own bots) ----------
  b.on('playerJoined', (pl) => {
    if (!pl || !pl.username || pl.username === b.username) return;
    if (slots.some((s) => s.name === pl.username)) return;
    hum.onPlayerJoined(pl.username);
    if (Date.now() - (S.lastVisit[pl.username] || 0) < 10 * 60 * 1000) return;
    S.lastVisit[pl.username] = Date.now();
    S.visit.push({ name: pl.username, at: Date.now() + rand(4000, 9000), tries: 0 });
  });

  const markDead = (e) => {
    if (!e) return;
    if (S.prey && e.id === S.prey.id) S.preyDead = true;
    if (S.foe && e.id === S.foe.id) S.foeDead = true;
  };
  b.on('entityDead', markDead);
  b.on('entityGone', markDead);

  // ---------- death / respawn ----------
  function respawnNow() {
    try {
      if (b.isAlive !== false) return;
      if (typeof b.respawn === 'function') b.respawn();
      else b._client.write('client_command', { actionId: 0 });
    } catch (e) { log('[Respawn] error:', e.message); }
  }

  b.on('death', () => {
    log('died - respawning');
    discord(`[x] **${slot.name}** died - respawning`, 0xf87171);
    stopPathfinder();
    S.prey = null; S.foe = null; S.visitTarget = null; S.eating = false;
    hum.cancelTask();
    hum.onDeath();
    S.mode = 'idle'; slot.mode = 'idle'; S.until = Date.now() + 3000;
    slot.addTimeout(respawnNow, 700);
    let tries = 0;
    const t = slot.addInterval(() => {
      if (slot.bot !== b || b.isAlive !== false || ++tries > 8) { clearInterval(t); return; }
      respawnNow();
    }, 1500);
  });

  let resetT = null;
  const afterRespawn = () => {
    clearTimeout(resetT);
    resetT = setTimeout(() => {
      if (slot.bot !== b || !b.entity) return;
      const q = b.entity.position;
      if (!(config.position && config.position.enabled)) origin = { x: fin(q.x, origin.x), y: Math.floor(fin(q.y, origin.y)), z: fin(q.z, origin.z) };
      S.t0 = Date.now(); S.ready = false;
      setMode('idle', 1500);
      log('respawned - new home point set');
      hum.onRespawn();
    }, 1200);
    slot.timers.push(resetT);
  };
  b.on('respawn', afterRespawn);
  b.on('spawn', afterRespawn);

  // ---------- main loop (20 ticks/s) ----------
  function step() {
    if (slot.bot !== b || slot.status !== 'online' || !b.entity) return;
    const now = Date.now();
    if (b.isAlive === false) return;
    if (b.isSleeping) { stopControls(); return; }

    const p = b.entity.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      stopControls();
      if (now - S.lastBadPos > 10000) { S.lastBadPos = now; log('[Brain] position is not a number - pausing'); }
      return;
    }

    // a GUI (PIN keypad) is open: a real player cannot walk now either
    if (b.currentWindow || slot.pinBusy) { stopControls(); S.still = 'a GUI is open (PIN keypad?)'; return; }

    // never send NaN rotations (the server kicks with "invalid player movement")
    if (!Number.isFinite(S.yaw)) S.yaw = 0;
    if (!Number.isFinite(S.heading)) S.heading = S.yaw;
    if (!Number.isFinite(S.pitch)) S.pitch = 0;

    // wait until the chunk under us is loaded
    if (!b.blockAt(p.offset(0, -0.5, 0))) {
      stopControls();
      S.still = 'waiting for world chunks';
      if (!S.ready && now - S.lastWait > 5000) {
        S.lastWait = now;
        log(`[Brain] waiting for world chunks... (${Math.round((now - S.t0) / 1000)}s)`);
      }
      return;
    }
    if (!S.ready) {
      S.ready = true;
      log(`[Brain] world loaded after ${((now - S.t0) / 1000).toFixed(1)}s - moving`);
      setMode('idle', 300);
    }

    if (S.eating) { stopControls(); S.still = 'eating'; return; }

    T.dark = darkAt(p);
    T.deep = p.y < origin.y - maxDescent;
    const liquid = !!(b.entity.isInWater || b.entity.isInLava);
    const threat = nearestThreat();
    const leashNow = isNight() ? nightLeash : leash;
    const dHome = Math.hypot(origin.x - p.x, origin.z - p.z);

    // eat when hungry (not while something dangerous is near)
    if (!threat && eatEnabled && b.food <= eatBelow && now > S.nextEat) {
      const food = pickFood();
      if (food) { setMode('idle', 800); eatNow(food); return; }
      S.nextEat = now + 5000;
    }

    // fight mobs that come at us (not creepers) and players who keep hitting us
    if (!threat && combatEnabled && S.mode !== 'fight' && now > S.nextFoeScan) {
      S.nextFoeScan = now + 400;
      const foe = pickFoe(now);
      if (foe) startFight(foe);
    }

    let moving = false;
    let sprint = false;

    if (threat) {
      if (threat.name === 'creeper') hum.onCreeper();
      if (S.mode !== 'flee') setMode('flee', 3000);
      S.until = now + 3000;
      S.heading = yawTo(threat.position.x, threat.position.z) + Math.PI + rand(-0.25, 0.25);
      moving = true;
      sprint = b.food > 6;
    } else if (S.mode === 'flee') {
      setMode('idle', rand(1000, 2000));
    } else if (S.mode === 'fight') {
      fightTick(now);
    } else if (S.mode === 'task') {
      if (now > S.until) setMode('idle', 800);
    } else if (S.mode === 'hunt') {
      huntTick(now, p);
    } else if (S.mode === 'collect') {
      collectTick(now);
    } else if (S.mode === 'home') {
      if ((dHome < 6 && !T.deep) || now > S.until || S.pfFailed) {
        if (S.pfFailed) S.nextHome = now + 15000;
        setMode('idle', 1000);
      }
    } else if (S.mode === 'idle') {
      if (now > S.until) {
        const resting = nightRest && isNight();
        const v = S.visit.find((x) => now >= x.at);
        if ((T.deep || dHome > leashNow + 15) && now > S.nextHome) {
          startHome();
        } else if (v && !resting) {
          S.visit.splice(S.visit.indexOf(v), 1);
          const pl = b.players[v.name];
          if (pl && pl.entity) { S.visitTarget = v.name; setMode('visit', 25000); }
          else if (v.tries < 3) S.visit.push({ name: v.name, at: now + 6000, tries: v.tries + 1 });
        } else if (!resting && huntEnabled && b.health >= 10 && now > S.nextHunt
          && (huntAlways || (b.food < 18 && !pickFood()))) {
          if (!startHunt(now)) S.nextHunt = now + 8000;
        } else if (!resting && (() => { const act = hum.pickActivity(); return act ? hum.startTask(act) : false; })()) {
          // a human-like goal started (farm / fish / explore / socialize ...)
        } else if (resting) {
          S.until = now + rand(4000, 9000);
        } else {
          S.heading = pickWalkHeading(leashNow);
          S.sprintWalk = Math.random() < sprintChance; // sometimes run, sometimes walk
          setMode('walk', rand(3000, 7000));
        }
      }
    } else if (S.mode === 'walk') {
      moving = true;
      sprint = S.sprintWalk && b.food > 6;
      if (now > S.until) setMode('idle', rand(800, 2500));
    } else if (S.mode === 'visit') {
      const pl = S.visitTarget && b.players[S.visitTarget];
      const t = pl && pl.entity;
      if (!t || now > S.until) { S.visitTarget = null; setMode('idle', rand(2000, 5000)); }
      else {
        const d = Math.hypot(t.position.x - p.x, t.position.z - p.z);
        if (d > visitDistance) { S.heading = yawTo(t.position.x, t.position.z); moving = true; sprint = d > visitDistance + 12 && b.food > 6; }
        else if (d < 9) { S.heading = yawTo(t.position.x, t.position.z) + Math.PI; moving = true; }
        else { S.visitTarget = null; setMode('idle', rand(3000, 8000)); }
      }
    }

    // pathfinder modes drive the controls themselves
    if (PF.has(S.mode)) return;

    // in water/lava: swim up and head for home
    if (liquid) {
      S.heading = yawTo(origin.x, origin.z);
      moving = true;
      sprint = false;
    } else if (moving) {
      const safe = pickSafeHeading(S.heading);
      if (safe === null) {
        moving = false;
        S.still = 'no safe direction';
        if (now - S.lastNoSafe > 10000) {
          S.lastNoSafe = now;
          log('[Brain] no safe direction (edge / water / cave all around) - standing still');
        }
        if (S.mode === 'walk') setMode('idle', rand(500, 1500));
      } else {
        S.heading = safe;
      }
    }

    // human-like look drift while idle
    if (!moving && S.mode === 'idle' && now > S.nextLook) {
      S.heading = S.yaw + rand(-1.4, 1.4);
      S.pitch = rand(-0.3, 0.3);
      S.nextLook = now + rand(1200, 4000);
    }

    // smooth turning (turn first, then walk)
    if (!Number.isFinite(S.heading)) S.heading = S.yaw;
    const diff = norm(S.heading - S.yaw);
    S.yaw = norm(S.yaw + Math.max(-0.2, Math.min(0.2, diff)));
    if (moving && !liquid && Math.abs(diff) > 1.2) moving = false;
    if (moving && !liquid && unsafeAhead(S.yaw)) moving = false;

    // stuck detection based on real progress
    if (!moving) {
      S.sampleT = now; S.sx = p.x; S.sz = p.z;
    } else if (now - S.sampleT > 1200) {
      const progress = Math.hypot(p.x - S.sx, p.z - S.sz);
      S.sampleT = now; S.sx = p.x; S.sz = p.z;
      if (progress < 0.8 && now - S.lastTurn > 1200) {
        S.heading += rand(2.0, 4.0); // blocked -> turn away
        S.lastTurn = now;
      }
    }

    // occasional hop while idle (anti-AFK)
    if (!moving && now > S.nextHop) {
      S.hopUntil = now + 150;
      S.nextHop = now + rand(8000, 15000);
    }

    // only jump for a real 1-block step; turn away from walls instead of pushing into them
    let jump = liquid || now < S.hopUntil;
    if (moving && !liquid) {
      const ob = obstacleAhead(S.yaw);
      if (ob === 'step') { if (b.entity.onGround) jump = true; sprint = false; }
      else if (ob === 'wall') {
        S.heading = S.yaw + rand(2.0, 4.0);
        S.lastTurn = now;
        moving = false;
      }
    }

    if (moving) S.still = '';
    if (Number.isFinite(S.yaw) && Number.isFinite(S.pitch)) b.look(S.yaw, S.pitch, true);
    b.setControlState('forward', moving);
    b.setControlState('sprint', moving && sprint);
    b.setControlState('jump', !!jump);
    slot.diag = { mode: S.mode, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +S.yaw.toFixed(3), pitch: +S.pitch.toFixed(3), moving };
  }

  slot.addInterval(() => {
    try { step(); } catch (e) { log('[Brain] error:', e.message); }
  }, 50);

  slot.addInterval(() => {
    if (!b.entity) return;
    const p = b.entity.position;
    const moved = Math.hypot(p.x - S.beatX, p.z - S.beatZ);
    S.beatX = p.x; S.beatZ = p.z;
    log(`[Brain] ${slot.role} mood=${slot.mood} mode=${S.mode}${slot.activity ? ':' + slot.activity : ''} pos=(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) hp=${Math.round(b.health)} food=${b.food} moved1m=${moved.toFixed(1)}${S.still ? ` STILL: ${S.still}` : ''}`);
  }, 60000);
}

// ============================================================
// DASHBOARD (keeps Render awake) + health
// ============================================================
const app = express();

const DASH = `<!DOCTYPE html><html><head><title>__NAME__</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:'Segoe UI',Tahoma,sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;padding:20px 0;margin:0}
.c{background:#1e293b;padding:24px;border-radius:20px;box-shadow:0 0 50px rgba(45,212,191,.2);width:92%;max-width:440px;border:1px solid #334155}
h1{margin:0 0 18px;font-size:22px;color:#ccfbf1;text-align:center}
.card{background:#0f172a;padding:12px 14px;margin:10px 0;border-radius:12px;border-left:5px solid #2dd4bf}
.l{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
.v{font-size:18px;font-weight:bold;color:#2dd4bf;margin-top:4px}
.row{display:flex;align-items:center;gap:8px;background:#0f172a;padding:10px 12px;margin:8px 0;border-radius:10px;font-size:14px}
.dot{height:11px;width:11px;border-radius:50%;flex:none}
.n{font-weight:bold;flex:1;word-break:break-all}
.s{color:#94a3b8;font-size:12px;text-align:right}
</style></head><body><div class="c">
<h1>__NAME__</h1>
<div class="card"><div class="l">Players online</div><div class="v" id="sum">-</div></div>
<div id="list"></div>
<div class="card"><div class="l">Uptime</div><div class="v" id="up">0h 0m 0s</div></div>
<div class="card"><div class="l">Server</div><div class="v">__SERVER__</div></div>
</div>
<script>
var colors={paused:'#a78bfa',online:'#4ade80',connecting:'#facc15',retry:'#f87171',away:'#60a5fa',leaving:'#60a5fa',offline:'#64748b',disabled:'#475569'};
var f=function(s){return Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m '+(s%60)+'s'};
async function u(){
  try{
    var r=await fetch('/health');var d=await r.json();
    document.getElementById('sum').innerText=d.online+' / '+d.total;
    document.getElementById('up').innerText=f(d.uptime);
    var list=document.getElementById('list');list.innerHTML='';
    d.players.forEach(function(p){
      var row=document.createElement('div');row.className='row';
      var dot=document.createElement('span');dot.className='dot';dot.style.background=colors[p.status]||'#64748b';
      var n=document.createElement('span');n.className='n';n.textContent=p.name;
      var s=document.createElement('span');s.className='s';
      s.textContent=p.status+(p.status==='online'?' - '+p.mode+(p.role?' - '+p.role+' ('+p.mood+')':''):'')+(p.coords?' ('+Math.floor(p.coords.x)+', '+Math.floor(p.coords.y)+', '+Math.floor(p.coords.z)+')':'');
      row.appendChild(dot);row.appendChild(n);row.appendChild(s);list.appendChild(row);
    });
  }catch(e){document.getElementById('sum').innerText='offline';}
}
setInterval(u,2000);u();
</script></body></html>`;

app.get('/', (req, res) => {
  res.send(DASH.replace(/__NAME__/g, config.name || 'AFK Players').replace(/__SERVER__/g, `${config.server.ip}:${config.server.port}`));
});

app.get('/health', (req, res) => {
  const online = slots.filter((s) => s.status === 'online').length;
  res.json({
    status: online > 0 ? 'connected' : 'disconnected',
    online,
    total: slots.filter((s) => s.cfg.enabled !== false).length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    traffic: proxyConfig() ? (() => { const t = budgetInfo(); return { todayMB: +(t.usedToday / MB).toFixed(1), allowTodayMB: +(t.allowToday / MB).toFixed(1), totalGB: +(t.usedTotal / 1e9).toFixed(2), limitGB: +(t.limit / 1e9).toFixed(1) }; })() : null,
    players: slots.map((s) => ({
      name: s.name,
      status: s.status,
      mode: s.activity ? `${s.mode}:${s.activity}` : s.mode,
      role: s.role || '',
      mood: s.mood || '',
      coords: s.bot && s.bot.entity ? s.bot.entity.position : null,
    })),
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, '0.0.0.0', () => console.log(`[Server] HTTP server started on port ${PORT}`));

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const proto = url.startsWith('https') ? https : http;
  proto.get(`${url}/ping`, () => {}).on('error', (e) => console.log(`[KeepAlive] Self-ping failed: ${e.message}`));
}, 10 * 60 * 1000);

setInterval(() => {
  const online = slots.filter((s) => s.status === 'online').length;
  console.log(`[Status] online ${online}/${slots.filter((s) => s.cfg.enabled !== false).length} | heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
}, 5 * 60 * 1000);

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', (line) => {
  const t = line.trim();
  if (t === 'list') {
    slots.forEach((s) => console.log(`${s.index + 1}. ${s.name} - ${s.status}${s.status === 'online' ? ` (${s.mode})` : ''}`));
    return;
  }
  const lead = leadSlot();
  if (!lead) return console.log('[Console] No bot online');
  if (t.startsWith('say ')) lead.bot.chat(t.slice(4));
  else if (t.startsWith('cmd ')) lead.bot.chat('/' + t.slice(4));
  else lead.bot.chat(t);
});

// ============================================================
// SHUTDOWN / CRASH RECOVERY
// ============================================================
function shutdown(why) {
  if (stopping) return;
  stopping = true;
  human.saveSocial();
  saveTraffic();
  console.log(`[System] Shutting down (${why})`);
  for (const s of slots) {
    clearTimeout(s.connTimer);
    clearTimeout(s.leaveTimer);
    clearTimeout(s.spawnTimeout);
    s.clearTimers();
    try { if (s.bot) s.bot.quit('Restarting'); } catch (e) { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 3000);
}

process.on('uncaughtException', (err) => console.log(`[FATAL] Uncaught Exception: ${err.message}`));
process.on('unhandledRejection', (reason) => console.log(`[FATAL] Unhandled Rejection: ${reason}`));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const maxRuntimeMs = (parseFloat(process.env.MAX_RUNTIME_MIN || '0') || 0) * 60000;
if (maxRuntimeMs > 0) setTimeout(() => shutdown('runtime limit reached - next run takes over'), maxRuntimeMs);

// ============================================================
// START
// ============================================================
console.log('='.repeat(50));
console.log('  Minecraft AFK Players v5');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}  Version: ${useVersion() || 'auto'}`);
console.log(`Random names: ${R['randomize-names'] === true ? 'ON' : 'off'}  |  Schedule: ${SC.enabled === false ? 'off' : 'ON'}  |  Node ${process.version}`);
slots.forEach((s) => console.log(`  ${s.index + 1}. ${s.cfg.name}  enabled=${s.cfg.enabled !== false}  stay=${s.cfg.stay === true}`));

budgetTick();
checkPublicIp();
slots.forEach((s) => { if (s.cfg.enabled !== false) queueConnect(s, 0); });
