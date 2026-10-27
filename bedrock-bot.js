'use strict';
/**
 * NexusGaming019 - Bedrock edition bot (bedrock-protocol), for Geyser / Bedrock servers.
 *
 * IMPORTANT: bedrock-protocol only gives raw packets. There is no terrain, physics or
 * pathfinding, so this bot is "terrain blind". To stay safe it:
 *   - stays inside a leash radius around its spawn point
 *   - treats any server position correction as "I hit something" and turns away
 *   - flees from hostile mobs it can see in entity packets
 *   - approaches a joining player to ~14 blocks, then goes back to wandering
 *   - stands still at night (set_time) instead of wandering
 * It cannot dig, hunt, eat, avoid holes/water or check caves. Use the Java bot for that.
 */
const bedrock = require('bedrock-protocol');

const CFG = {
  host: process.env.MC_HOST || '15.235.165.81',
  port: parseInt(process.env.MC_PORT || '20000', 10), // Geyser's BEDROCK port
  version: process.env.MC_VERSION || undefined, // e.g. 1.21.80 (leave empty = auto)
  // cracked: the in-game name. Xbox mode: the Microsoft account email (name comes from the gamertag)
  username: process.env.MC_USERNAME || 'nbody8881@gmail.com',
  xbox: process.env.MC_AUTH === 'xbox', // real Microsoft/Xbox login (set MC_AUTH=xbox)
  offline: process.env.MC_AUTH !== 'xbox' && process.env.MC_OFFLINE !== 'false',
  authDir: process.env.AUTH_DIR || './auth', // token cache; put this on a persistent volume
  maxRuntimeMs: (parseFloat(process.env.MAX_RUNTIME_MIN || '0') || 0) * 60000,
  leash: 22,
  visitDistance: 14,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const key = (v) => String(v);
const DEG = 180 / Math.PI;

const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom',
  'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'warden', 'breeze',
]);
const RADIUS = { creeper: 9, skeleton: 16, stray: 16, pillager: 18, witch: 12, ghast: 30, blaze: 14, phantom: 18, enderman: 7, warden: 25 };

let current = null;
let stopping = false;
let backoff = 8000;

function launch() {
  if (stopping) return;
  const opts = {
    host: CFG.host,
    port: CFG.port,
    username: CFG.username,
    offline: CFG.offline,
    version: CFG.version,
    connectTimeout: 30000,
  };
  if (CFG.xbox) {
    // First run prints a code in the logs: open the link, enter the code, sign in.
    // The token is then cached in AUTH_DIR and refreshed automatically.
    opts.profilesFolder = CFG.authDir;
    opts.onMsaCode = (d) => console.log(`\n[auth] Open ${d.verification_uri} and enter code: ${d.user_code}\n`);
  }
  const client = bedrock.createClient(opts);
  current = client;

  const S = {
    pos: null, origin: null, rid: null, yaw: rand(0, 360), pitch: 0, tick: 0n,
    ents: new Map(), visit: [], lastVisit: {}, night: false,
    mode: 'idle', until: 0, modeStart: 0, heading: 0, lookAt: 0, nextLook: 0,
    lastCorrect: 0, wasSprint: false, loop: null, warned: false, visitTarget: null,
  };

  const setMode = (m, ms) => { S.mode = m; S.modeStart = Date.now(); S.until = Date.now() + ms; };

  // ---------- packets ----------
  client.on('start_game', (p) => {
    S.rid = p.runtime_entity_id;
    S.pos = { ...p.player_position };
    S.origin = { ...p.player_position };
  });

  client.on('add_entity', (p) => {
    S.ents.set(key(p.runtime_id), { name: String(p.entity_type).replace('minecraft:', ''), pos: { ...p.position } });
  });
  client.on('add_player', (p) => {
    S.ents.set(key(p.runtime_id), { name: 'player', username: p.username, pos: { ...p.position } });
  });
  client.on('remove_entity', (p) => S.ents.delete(key(p.entity_id_self)));
  client.on('move_entity', (p) => {
    const e = S.ents.get(key(p.runtime_entity_id));
    if (e && p.position) e.pos = { ...p.position };
  });
  client.on('move_entity_delta', (p) => {
    const e = S.ents.get(key(p.runtime_entity_id));
    if (!e) return;
    if (typeof p.x === 'number') e.pos.x = p.x;
    if (typeof p.y === 'number') e.pos.y = p.y;
    if (typeof p.z === 'number') e.pos.z = p.z;
  });
  client.on('move_player', (p) => {
    if (key(p.runtime_id) === key(S.rid)) {
      S.pos = { ...p.position };
      S.lastCorrect = Date.now();
    } else {
      const e = S.ents.get(key(p.runtime_id));
      if (e && p.position) e.pos = { ...p.position };
    }
  });
  client.on('correct_player_move_prediction', (p) => {
    if (p.position) { S.pos = { ...p.position }; S.lastCorrect = Date.now(); }
  });

  client.on('player_list', (p) => {
    try {
      if (!p.records || p.records.type !== 'add') return;
      for (const r of p.records.records) {
        if (!r.username || r.username === CFG.username) continue;
        if (client.profile && r.username === client.profile.name) continue; // ourselves (Xbox gamertag)
        const last = S.lastVisit[r.username] || 0;
        if (Date.now() - last < 10 * 60 * 1000) continue;
        S.lastVisit[r.username] = Date.now();
        S.visit.push({ name: r.username, at: Date.now() + rand(4000, 9000), tries: 0 });
      }
    } catch (e) { /* ignore */ }
  });

  client.on('set_time', (p) => {
    const t = Number(p.time) % 24000;
    S.night = t >= 13000 && t < 23000;
  });

  client.on('respawn', (p) => {
    try {
      if (p.state === 'searching' || p.state === 'server_searching') {
        client.queue('respawn', { position: p.position, state: 'client_ready', runtime_entity_id: S.rid });
      }
    } catch (e) { /* ignore */ }
  });

  client.on('spawn', () => {
    console.log(`[bot] spawned as ${CFG.username}`);
    backoff = 8000;
    setMode('idle', rand(3000, 6000));
    S.loop = setInterval(step, 50);
  });

  // ---------- brain + movement (20 ticks/s) ----------
  function nearestThreat() {
    let best = null;
    let bd = 1e9;
    for (const e of S.ents.values()) {
      if (!HOSTILE.has(e.name)) continue;
      const dx = e.pos.x - S.pos.x;
      const dz = e.pos.z - S.pos.z;
      const d = Math.hypot(dx, dz);
      if (Math.abs(e.pos.y - S.pos.y) > 10) continue;
      if (d < (RADIUS[e.name] || 10) && d < bd) { best = e; bd = d; }
    }
    return best;
  }

  const headingTo = (tx, tz) => Math.atan2(-(tx - S.pos.x), tz - S.pos.z) * DEG;
  const norm = (a) => ((a + 540) % 360) - 180;

  function pickWalkHeading() {
    const dx = S.origin.x - S.pos.x;
    const dz = S.origin.z - S.pos.z;
    if (Math.hypot(dx, dz) > CFG.leash) return headingTo(S.origin.x, S.origin.z) + rand(-25, 25);
    return rand(-180, 180);
  }

  function step() {
    if (!S.pos) return;
    const now = Date.now();
    let moving = false;
    let sprint = false;

    const threat = nearestThreat();
    if (threat) {
      if (S.mode !== 'flee') setMode('flee', 3000);
      S.until = now + 3000;
      S.heading = headingTo(threat.pos.x, threat.pos.z) + 180 + rand(-15, 15);
      moving = true;
      sprint = true;
    } else if (S.mode === 'flee') {
      setMode('idle', rand(1500, 3000));
    } else if (S.mode === 'idle') {
      if (now > S.until) {
        const v = S.visit.find((x) => now >= x.at);
        if (v && !S.night) {
          S.visit.splice(S.visit.indexOf(v), 1);
          const target = [...S.ents.values()].find((e) => e.name === 'player' && e.username === v.name);
          if (target) { S.visitTarget = target; setMode('visit', 25000); }
          else if (v.tries < 3) S.visit.push({ name: v.name, at: now + 6000, tries: v.tries + 1 });
        } else if (S.night) {
          S.until = now + rand(4000, 9000); // stand still at night
        } else {
          S.heading = pickWalkHeading();
          setMode('walk', rand(2000, 6000));
        }
      }
    } else if (S.mode === 'walk') {
      moving = true;
      if (S.lastCorrect > S.modeStart) { // server pushed us back -> obstacle
        S.heading += rand(100, 220);
        S.modeStart = now;
        if (Math.random() < 0.3) setMode('idle', rand(800, 2500));
      }
      if (now > S.until) setMode('idle', rand(1500, 6000));
    } else if (S.mode === 'visit') {
      const t = S.visitTarget;
      if (!t || now > S.until) { S.visitTarget = null; setMode('idle', rand(2000, 5000)); }
      else {
        const d = Math.hypot(t.pos.x - S.pos.x, t.pos.z - S.pos.z);
        if (d > CFG.visitDistance) { S.heading = headingTo(t.pos.x, t.pos.z); moving = true; }
        else if (d < 9) { S.heading = headingTo(t.pos.x, t.pos.z) + 180; moving = true; }
        else { S.visitTarget = null; setMode('idle', rand(3000, 8000)); }
        if (S.lastCorrect > S.modeStart) { S.heading += rand(60, 140); S.modeStart = now; }
      }
    }

    // human-like look drift while idle
    if (!moving && now > S.nextLook) {
      S.heading = S.yaw + rand(-80, 80);
      S.pitch = rand(-18, 18);
      S.nextLook = now + rand(1200, 4000);
    }

    // smooth turning
    const diff = norm(S.heading - S.yaw);
    S.yaw = norm(S.yaw + Math.max(-7, Math.min(7, diff)));
    if (moving && Math.abs(diff) > 70) moving = false; // turn first, then walk

    sendInput(moving, sprint);
  }

  function sendInput(moving, sprint) {
    const rad = S.yaw / DEG;
    const sp = moving ? (sprint ? 0.28 : 0.2158) : 0;
    const dx = -Math.sin(rad) * sp;
    const dz = Math.cos(rad) * sp;
    S.pos.x += dx;
    S.pos.z += dz;
    S.tick += 1n;
    const flags = {
      up: moving,
      sprint_down: moving && sprint,
      sprinting: moving && sprint,
      start_sprinting: moving && sprint && !S.wasSprint,
      stop_sprinting: S.wasSprint && !(moving && sprint),
    };
    S.wasSprint = moving && sprint;
    const mv = { x: 0, z: moving ? 1 : 0 };
    try {
      client.queue('player_auth_input', {
        pitch: S.pitch,
        yaw: S.yaw,
        position: { x: S.pos.x, y: S.pos.y, z: S.pos.z },
        move_vector: mv,
        head_yaw: S.yaw,
        input_data: flags,
        input_mode: 'mouse',
        play_mode: 'screen',
        interaction_model: 'classic',
        interact_rotation: { x: S.pitch, z: S.yaw },
        tick: S.tick,
        delta: { x: dx, y: 0, z: dz },
        analogue_move_vector: mv,
        raw_move_vector: mv,
        camera_orientation: { x: 0, y: 0, z: 0 },
      });
    } catch (e) {
      if (!S.warned) { S.warned = true; console.log('[bot] player_auth_input failed (version mismatch?):', e && e.message); }
    }
  }

  // ---------- lifecycle ----------
  client.on('kick', (p) => console.log('[bot] kicked:', p && (p.message || JSON.stringify(p))));
  client.on('error', (e) => console.log('[bot] error:', e && e.message));
  client.on('close', () => {
    clearInterval(S.loop);
    console.log('[bot] disconnected');
    if (stopping) return;
    const wait = backoff * rand(0.8, 1.3);
    backoff = Math.min(backoff * 1.7, 120000);
    console.log(`[bot] reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(launch, wait);
  });
}

function shutdown() {
  stopping = true;
  try { if (current) current.disconnect(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (CFG.maxRuntimeMs > 0) setTimeout(shutdown, CFG.maxRuntimeMs);

launch();
