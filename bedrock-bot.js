'use strict';
const mineflayer = require('mineflayer');
const config = require('./settings.json');
const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');

const PORT = process.env.PORT || 5000;
const rand = (a, b) => a + Math.random() * (b - a);

let botState = {
  connected: false,
  mode: 'offline',
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
};

let bot = null;
let activeIntervals = [];
let reconnectTimeout = null;
let connectionTimeout = null;
let isReconnecting = false;

// ============================================================
// EXPRESS DASHBOARD (keeps Render awake)
// ============================================================
const app = express();

const DASH = `<!DOCTYPE html><html><head><title>__NAME__ Status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:'Segoe UI',Tahoma,sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.c{background:#1e293b;padding:32px;border-radius:20px;box-shadow:0 0 50px rgba(45,212,191,.2);text-align:center;width:92%;max-width:400px;border:1px solid #334155}
h1{margin:0 0 24px;font-size:22px;color:#ccfbf1}
.card{background:#0f172a;padding:14px;margin:12px 0;border-radius:12px;border-left:5px solid #2dd4bf;text-align:left}
.l{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
.v{font-size:18px;font-weight:bold;color:#2dd4bf;margin-top:5px}
.dot{height:12px;width:12px;border-radius:50%;display:inline-block;margin-right:8px;background:#ef4444}
.bar{height:4px;background:#334155;margin-top:18px;border-radius:2px;overflow:hidden}
.fill{height:100%;width:100%;background:#2dd4bf;animation:ld 2s infinite linear}
@keyframes ld{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
</style></head><body><div class="c">
<h1><span id="dot" class="dot"></span>__NAME__</h1>
<div class="card"><div class="l">Status</div><div class="v" id="st">Connecting...</div></div>
<div class="card"><div class="l">Activity</div><div class="v" id="mode">-</div></div>
<div class="card"><div class="l">Uptime</div><div class="v" id="up">0h 0m 0s</div></div>
<div class="card"><div class="l">Coordinates</div><div class="v" id="co">Waiting...</div></div>
<div class="card"><div class="l">Server</div><div class="v">__SERVER__</div></div>
<div class="bar"><div class="fill"></div></div>
</div>
<script>
var f=function(s){return Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m '+(s%60)+'s'};
async function u(){
  try{
    var r=await fetch('/health');var d=await r.json();
    var on=d.status==='connected';
    document.getElementById('st').innerText=on?'Online & Running':'Reconnecting...';
    document.getElementById('dot').style.background=on?'#4ade80':'#f87171';
    document.getElementById('mode').innerText=d.mode||'-';
    document.getElementById('up').innerText=f(d.uptime);
    document.getElementById('co').innerText=d.coords?Math.floor(d.coords.x)+', '+Math.floor(d.coords.y)+', '+Math.floor(d.coords.z):'Unknown';
  }catch(e){document.getElementById('st').innerText='System Offline';}
}
setInterval(u,1000);u();
</script></body></html>`;

app.get('/', (req, res) => {
  res.send(DASH.replace(/__NAME__/g, config.name).replace(/__SERVER__/g, `${config.server.ip}:${config.server.port}`));
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    mode: botState.mode,
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, '0.0.0.0', () => console.log(`[Server] HTTP server started on port ${PORT}`));

// Self-ping so Render doesn't sleep
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const proto = url.startsWith('https') ? https : http;
  proto.get(`${url}/ping`, () => {}).on('error', (e) => console.log(`[KeepAlive] Self-ping failed: ${e.message}`));
}, 10 * 60 * 1000);

setInterval(() => {
  console.log(`[Memory] Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 5 * 60 * 1000);

// ============================================================
// HELPERS
// ============================================================
function formatUptime(seconds) {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

function clearAllIntervals() {
  activeIntervals.forEach((id) => { clearInterval(id); clearTimeout(id); });
  activeIntervals = [];
}

function addInterval(cb, delay) {
  const id = setInterval(cb, delay);
  activeIntervals.push(id);
  return id;
}

function addTimeout(cb, delay) {
  const id = setTimeout(cb, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  const base = config.utils['auto-reconnect-delay'] || 2000;
  const max = config.utils['max-reconnect-delay'] || 15000;
  return Math.min(base + botState.reconnectAttempts * 1000, max);
}

function sendDiscordWebhook(content, color = 0x0099ff) {
  const url = process.env.DISCORD_WEBHOOK || (config.discord && config.discord.webhookUrl);
  if (!config.discord || !config.discord.enabled || !url || url.includes('YOUR_DISCORD')) return;
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
// BOT + RECONNECT
// ============================================================
function createBot() {
  if (isReconnecting) return;

  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (e) { /* ignore */ }
    bot = null;
  }

  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port} (v${config.server.version})`);

  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      hideErrors: false,
      checkTimeoutInterval: 120000,
    });

    setupAuth(bot);

    clearTimeout(connectionTimeout);
    connectionTimeout = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received');
        scheduleReconnect();
      }
    }, 60000);

    bot.once('spawn', () => {
      clearTimeout(connectionTimeout);
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      console.log('[Bot] [+] Successfully spawned on server!');

      if (config.discord && config.discord.events && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      const mcData = bot.registry;
      initializeModules(bot, mcData);

      addTimeout(() => {
        if (bot && botState.connected && config.utils['auto-creative'] !== false) {
          bot.chat('/gamemode creative');
          console.log('[INFO] Attempted to set creative mode (requires OP)');
        }
      }, 3000);
    });

    bot.on('end', (reason) => {
      console.log(`[Bot] Disconnected: ${reason || 'Unknown reason'}`);
      clearTimeout(connectionTimeout);
      botState.connected = false;
      botState.mode = 'offline';
      clearAllIntervals();

      if (config.discord && config.discord.events && config.discord.events.disconnect && reason !== 'Periodic Rejoin') {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || 'Unknown'}`, 0xf87171);
      }
      if (config.utils['auto-reconnect']) scheduleReconnect();
    });

    bot.on('kicked', (reason) => {
      console.log('[KICK]', typeof reason === 'string' ? reason : JSON.stringify(reason));
    });

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.message}`);
      botState.errors.push({ type: 'error', message: err.message, time: Date.now() });
    });
  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (isReconnecting) return;

  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// Single login/register handler (sends once per connection, no duplicates)
function setupAuth(b) {
  const auth = (config.utils && config.utils['auto-auth']) || {};
  if (auth.enabled === false) return;
  const pw = auth.password || 'Perzuu';
  let lastAuth = 0;

  b.on('messagestr', (msg) => {
    const m = String(msg).toLowerCase();
    if (m.startsWith('<')) return; // normal player chat
    const now = Date.now();
    if (now - lastAuth < 20000) return;

    if (m.includes('/register')) {
      lastAuth = now;
      b.chat(`/register ${pw} ${pw}`);
      console.log('[Auth] Register sent');
    } else if (m.includes('/login')) {
      lastAuth = now;
      b.chat(`/login ${pw}`);
      console.log('[Auth] Login sent');
    }
  });
}

// ============================================================
// MODULES
// ============================================================
function initializeModules(b, mcData) {
  console.log('[Modules] Initializing...');

  if (config.movement && config.movement.enabled !== false) startWander(b);
  if (config.modules.combat) combatModule(b, mcData);
  if (config.modules.beds) bedModule(b);
  if (config.modules.chat) chatModule(b);

  const pr = config.utils['periodic-rejoin'];
  if (pr && pr.enabled) {
    const mins = rand(pr['min-interval'] || 20, pr['max-interval'] || 60);
    console.log(`[Rejoin] Rejoining in ${mins.toFixed(0)} min`);
    addTimeout(() => { if (bot) bot.quit('Periodic Rejoin'); }, mins * 60000);
  }

  console.log('[Modules] All modules initialized!');
}

// ------------------------------------------------------------
// WANDER: same behaviour as the Bedrock bot, but with real
// terrain awareness (mineflayer has physics + block data).
//  - wanders inside a leash around spawn (or config.position)
//  - flees hostile mobs it can see
//  - walks up to ~14 blocks from players who join, then goes back to wandering
//  - optionally stands still at night
// ------------------------------------------------------------
const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom',
  'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'warden', 'breeze',
]);
const RADIUS = { creeper: 9, skeleton: 16, stray: 16, pillager: 18, witch: 12, ghast: 30, blaze: 14, phantom: 18, enderman: 7, warden: 25 };
const AIR = new Set(['air', 'cave_air', 'void_air']);
const DANGER = new Set(['lava', 'water', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'powder_snow']);

function startWander(b) {
  const W = (config.movement && config.movement.wander) || {};
  const leash = W.leash || 22;
  const visitDistance = W['visit-distance'] || 14;
  const nightRest = !!W['night-rest'];

  const p0 = b.entity.position;
  const origin = config.position && config.position.enabled
    ? { x: config.position.x, z: config.position.z }
    : { x: p0.x, z: p0.z };

  const S = {
    mode: 'idle', until: 0, modeStart: 0,
    yaw: b.entity.yaw, pitch: 0, heading: b.entity.yaw, nextLook: 0,
    visit: [], lastVisit: {}, visitTarget: null,
    sx: p0.x, sz: p0.z, sampleT: 0, lastTurn: 0, hopUntil: 0, nextHop: Date.now() + 8000,
    beatX: p0.x, beatZ: p0.z,
  };

  const setMode = (m, ms) => {
    S.mode = m; S.modeStart = Date.now(); S.until = Date.now() + ms;
    botState.mode = m;
  };
  setMode('idle', rand(1500, 2500));

  const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const yawTo = (tx, tz) => {
    const p = b.entity.position;
    return Math.atan2(-(tx - p.x), -(tz - p.z));
  };

  const isAir = (blk) => !!blk && AIR.has(blk.name);
  const isDanger = (blk) => !!blk && DANGER.has(blk.name);

  // true if walking in this direction leads into lava/water/fire or a 3+ block drop
  function unsafeAhead(yaw) {
    const p = b.entity.position;
    for (const d of [1.0, 2.0]) {
      const f = p.offset(-Math.sin(yaw) * d, 0, -Math.cos(yaw) * d).floored();
      const b0 = b.blockAt(f);
      const b1 = b.blockAt(f.offset(0, -1, 0));
      const b2 = b.blockAt(f.offset(0, -2, 0));
      const b3 = b.blockAt(f.offset(0, -3, 0));
      if (isDanger(b0) || isDanger(b1)) return true;
      if (isAir(b1) && isAir(b2) && isAir(b3)) return true;
    }
    return false;
  }

  function pickSafeHeading(base) {
    for (const off of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      if (!unsafeAhead(base + off)) return base + off;
    }
    return null;
  }

  function nearestThreat() {
    const me = b.entity.position;
    let best = null;
    let bd = 1e9;
    for (const e of Object.values(b.entities)) {
      if (!e || e === b.entity || !e.position || !HOSTILE.has(e.name)) continue;
      if (Math.abs(e.position.y - me.y) > 10) continue;
      const d = Math.hypot(e.position.x - me.x, e.position.z - me.z);
      if (d < (RADIUS[e.name] || 10) && d < bd) { best = e; bd = d; }
    }
    return best;
  }

  function pickWalkHeading() {
    const p = b.entity.position;
    if (Math.hypot(origin.x - p.x, origin.z - p.z) > leash) {
      return yawTo(origin.x, origin.z) + rand(-0.45, 0.45);
    }
    return rand(-Math.PI, Math.PI);
  }

  b.on('playerJoined', (pl) => {
    if (!pl || !pl.username || pl.username === b.username) return;
    if (Date.now() - (S.lastVisit[pl.username] || 0) < 10 * 60 * 1000) return;
    S.lastVisit[pl.username] = Date.now();
    S.visit.push({ name: pl.username, at: Date.now() + rand(4000, 9000), tries: 0 });
  });

  function stopControls() {
    b.setControlState('forward', false);
    b.setControlState('sprint', false);
    b.setControlState('jump', false);
  }

  function step() {
    if (!botState.connected || !b.entity) return;
    if (b.isSleeping) { stopControls(); return; }

    const now = Date.now();
    const p = b.entity.position;
    let moving = false;
    let sprint = false;

    const threat = nearestThreat();
    if (threat) {
      if (S.mode !== 'flee') setMode('flee', 3000);
      S.until = now + 3000;
      S.heading = yawTo(threat.position.x, threat.position.z) + Math.PI + rand(-0.25, 0.25);
      moving = true;
      sprint = true;
    } else if (S.mode === 'flee') {
      setMode('idle', rand(1000, 2000));
    } else if (S.mode === 'idle') {
      if (now > S.until) {
        const isNight = b.time && b.time.timeOfDay >= 13000 && b.time.timeOfDay < 23000;
        const resting = nightRest && isNight;
        const v = S.visit.find((x) => now >= x.at);
        if (v && !resting) {
          S.visit.splice(S.visit.indexOf(v), 1);
          const pl = b.players[v.name];
          if (pl && pl.entity) { S.visitTarget = v.name; setMode('visit', 25000); }
          else if (v.tries < 3) S.visit.push({ name: v.name, at: now + 6000, tries: v.tries + 1 });
        } else if (resting) {
          S.until = now + rand(4000, 9000);
        } else {
          S.heading = pickWalkHeading();
          setMode('walk', rand(3000, 7000));
        }
      }
    } else if (S.mode === 'walk') {
      moving = true;
      if (now > S.until) setMode('idle', rand(800, 2500));
    } else if (S.mode === 'visit') {
      const pl = S.visitTarget && b.players[S.visitTarget];
      const t = pl && pl.entity;
      if (!t || now > S.until) { S.visitTarget = null; setMode('idle', rand(2000, 5000)); }
      else {
        const d = Math.hypot(t.position.x - p.x, t.position.z - p.z);
        if (d > visitDistance) { S.heading = yawTo(t.position.x, t.position.z); moving = true; }
        else if (d < 9) { S.heading = yawTo(t.position.x, t.position.z) + Math.PI; moving = true; }
        else { S.visitTarget = null; setMode('idle', rand(3000, 8000)); }
      }
    }

    // pick a safe direction (no lava, water, fire or big drops)
    if (moving) {
      const safe = pickSafeHeading(S.heading);
      if (safe === null) {
        moving = false;
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
    const diff = norm(S.heading - S.yaw);
    S.yaw = norm(S.yaw + Math.max(-0.2, Math.min(0.2, diff)));
    if (moving && Math.abs(diff) > 1.2) moving = false;
    if (moving && unsafeAhead(S.yaw)) moving = false;

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

    b.look(S.yaw, S.pitch, true);
    b.setControlState('forward', moving);
    b.setControlState('sprint', moving && sprint);
    const jump = (moving && b.entity.isCollidedHorizontally) || b.entity.isInWater || now < S.hopUntil;
    b.setControlState('jump', !!jump);
    botState.lastActivity = now;
  }

  addInterval(() => {
    try { step(); } catch (e) { console.log('[Wander] Error:', e.message); }
  }, 50);

  addInterval(() => {
    if (!b.entity) return;
    const p = b.entity.position;
    const moved = Math.hypot(p.x - S.beatX, p.z - S.beatZ);
    S.beatX = p.x; S.beatZ = p.z;
    console.log(`[Wander] mode=${S.mode} pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) moved30s=${moved.toFixed(1)}`);
  }, 30000);
}

// ------------------------------------------------------------
function combatModule(b, mcData) {
  if (config.combat && config.combat['attack-mobs']) {
    addInterval(() => {
      if (!botState.connected) return;
      try {
        const mob = Object.values(b.entities).find((e) =>
          e && e.type === 'hostile' && e.position && b.entity.position.distanceTo(e.position) < 4);
        if (mob) b.attack(mob);
      } catch (e) { console.log('[Combat] Error:', e.message); }
    }, 1500);
  }

  let eating = false;
  b.on('health', async () => {
    if (!config.combat || !config.combat['auto-eat'] || eating || b.food >= 14) return;
    const food = b.inventory.items().find((i) => mcData.itemsByName[i.name] && mcData.itemsByName[i.name].foodPoints);
    if (!food) return;
    eating = true;
    try {
      await b.equip(food, 'hand');
      await b.consume();
    } catch (e) {
      console.log('[AutoEat] Error:', e.message);
    }
    eating = false;
  });
}

function bedModule(b) {
  addInterval(async () => {
    if (!botState.connected || b.isSleeping) return;
    try {
      const t = b.time.timeOfDay;
      const isNight = t >= 12500 && t <= 23500;
      if (!(config.beds && config.beds['place-night']) || !isNight) return;
      const bed = b.findBlock({ matching: (blk) => blk.name.includes('bed'), maxDistance: 8 });
      if (bed) {
        await b.sleep(bed);
        console.log('[Bed] Sleeping...');
      }
    } catch (e) { /* cannot sleep right now */ }
  }, 10000);
}

function chatModule(b) {
  let lastGreet = 0;
  b.on('chat', (username, message) => {
    if (username === b.username || !(config.chat && config.chat.respond)) return;
    if (/\b(hello|hi|hey)\b/i.test(message) && Date.now() - lastGreet > 15000) {
      lastGreet = Date.now();
      b.chat(`Hello, ${username}!`);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', (line) => {
  if (!bot || !botState.connected) return console.log('[Console] Bot not connected');
  const t = line.trim();
  if (t.startsWith('say ')) bot.chat(t.slice(4));
  else if (t.startsWith('cmd ')) bot.chat('/' + t.slice(4));
  else if (t === 'status') console.log(`Connected: ${botState.connected}, Mode: ${botState.mode}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
  else if (t === 'reconnect') bot.end();
  else bot.chat(t);
});

// ============================================================
// CRASH RECOVERY
// ============================================================
process.on('uncaughtException', (err) => {
  console.log(`[FATAL] Uncaught Exception: ${err.message}`);
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });
  if (config.utils['auto-reconnect']) {
    clearAllIntervals();
    setTimeout(scheduleReconnect, 1000);
  }
});
process.on('unhandledRejection', (reason) => {
  console.log(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ============================================================
console.log('='.repeat(50));
console.log('  Minecraft AFK Bot v3 - wander / flee / visit');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}  Version: ${config.server.version}`);

createBot();
