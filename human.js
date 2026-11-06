'use strict';
/**
 * Human-like layer for the bots:
 *  - personality: "The Farmer" and "The Socializer" (set per player with "role", or random)
 *  - moods (calm / happy / excited / angry / scared / bored / sad) that change behaviour and chat
 *  - daily routine (what they like to do depends on the time of day)
 *  - personal goals: farming, fishing, animal breeding, cooking, exploring, socializing, following players
 *  - conversations with real players (rule based, one bot answers, human typing delay)
 *  - friendship + reputation memory (saved to memory.json)
 *  - cooperation: bots help each other when one is attacked
 */
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fill = (t, n) => t.replace(/\{n\}/g, n || 'friend');

// ============================================================
// SHARED MEMORY (all bots): friendship + reputation per player name
// ============================================================
const MEMORY_FILE = process.env.MEMORY_FILE || path.join(__dirname, 'memory.json');
const social = {};
let dirty = false;

try { Object.assign(social, JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))); } catch (e) { /* first run */ }

const rec = (name) => social[name] || (social[name] = { friend: 0, rep: 0, seen: 0, talks: 0, last: 0, decayAt: Date.now() });
function bump(name, key, d) {
  const r = rec(name);
  r[key] = key === 'friend' ? clamp(r[key] + d, 0, 20) : clamp(r[key] + d, -10, 10);
  r.last = Date.now();
  dirty = true;
}
const friendOf = (n) => (social[n] ? social[n].friend : 0);
const repOf = (n) => (social[n] ? social[n].rep : 0);

function saveSocial() {
  if (!dirty) return;
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(social)); dirty = false; } catch (e) { /* ignore */ }
}
setInterval(() => {
  const now = Date.now();
  for (const r of Object.values(social)) { // bad reputation slowly heals (1 point per hour)
    const hrs = (now - (r.decayAt || now)) / 3600000;
    if (hrs >= 1 && r.rep !== 0) {
      r.rep -= Math.sign(r.rep) * Math.min(Math.abs(r.rep), Math.floor(hrs));
      r.decayAt = now;
      dirty = true;
    }
  }
  saveSocial();
}, 120000);

const G = { lastChat: 0, assist: [], avoid: {} };

// ============================================================
// PERSONALITIES
// ============================================================
const ROLES = {
  farmer: {
    label: 'The Farmer', chatty: 0.45,
    weights: { farm: 30, fish: 12, breed: 10, cook: 10, explore: 6, social: 6, follow: 2, chat: 4, rest: 8, wander: 16 },
    lines: ['crops are looking good today', 'need to replant some seeds', 'anyone need food? i might have extra',
      'good day for farming', 'the animals are doing well'],
  },
  socializer: {
    label: 'The Socializer', chatty: 0.95,
    weights: { farm: 0, fish: 2, breed: 0, cook: 2, explore: 18, social: 28, follow: 14, chat: 12, rest: 5, wander: 14 },
    lines: ['anyone around?', 'what is everyone up to?', 'so quiet today', 'want to hang out?', 'found anything cool lately?'],
  },
};

const ACT_TEXT = {
  farm: 'harvesting some crops', fish: 'fishing', breed: 'taking care of the animals', cook: 'cooking some food',
  explore: 'exploring around', social: 'hanging out', follow: 'hanging out', chat: 'just chilling', rest: 'taking a break', '': 'walking around',
};

const GREET = ['hey {n}', 'hi {n}!', 'hello {n}', 'yo {n}', 'hey there {n}', 'o/ {n}'];
const GREET_FRIEND = ['hey {n}! good to see you', '{n}! how have you been', 'welcome back {n}', "yo {n}, what's up"];
const NIGHT_LINES = ['getting dark, stay safe out there', 'watch out for creepers tonight', 'night time, careful everyone'];

// ============================================================
// INTENTS (what a player message means)
// ============================================================
function detectIntent(l) {
  if (/\b(are (you|u) (a )?(bot|real|human|ai)|is this a bot|you a bot|u a bot|afk bot)\b/.test(l)) return 'bot';
  if (/\b(follow me|come here|come with me|come to me|come over)\b/.test(l)) return 'follow';
  if (/\b(go away|leave me alone|get lost|back off|stop following|shut up)\b/.test(l)) return 'away';
  if (/\b(thanks|thank you|thx|ty)\b/.test(l)) return 'thanks';
  if (/\b(bye|cya|see ya|gtg|goodnight|gn|later)\b/.test(l)) return 'bye';
  if (/\b(noob|idiot|stupid|trash|ugly|dumb|loser)\b/.test(l)) return 'insult';
  if (/\b(how are you|how r u|hru|how's it going|hows it going|you good|wassup|what's up|whats up)\b/.test(l)) return 'how';
  if (/\b(what are you doing|what r u doing|wyd|whatcha doing|what you doing)\b/.test(l)) return 'doing';
  if (/\b(hi|hello|hey|yo|hii+|heyy+|hola|good morning|gm)\b/.test(l)) return 'greet';
  if (/\b(lol|lmao|haha|gg|nice|cool|wow)\b/.test(l)) return 'react';
  if (/\?\s*$/.test(l)) return 'question';
  return null;
}

// all bots receive the same chat message: this picks exactly one bot to answer
function chooseResponder(slots, username, lower) {
  const online = slots.filter((s) => s.status === 'online' && s.bot && s.bot.entity);
  const named = online.find((s) => lower.includes(s.name.toLowerCase()));
  if (named) return { slot: named, addressed: true, near: true };
  let best = null;
  let bd = 1e9;
  for (const s of online) {
    const pl = s.bot.players[username];
    if (!pl || !pl.entity) continue;
    const d = pl.entity.position.distanceTo(s.bot.entity.position);
    if (d < bd) { bd = d; best = s; }
  }
  if (best && bd < 32) return { slot: best, addressed: false, near: true };
  return { slot: online[0] || null, addressed: false, near: false };
}

// ============================================================
// CROPS / ANIMALS / FOOD tables
// ============================================================
const CROPS = {
  wheat: { max: 7, seed: 'wheat_seeds' },
  carrots: { max: 7, seed: 'carrot' },
  potatoes: { max: 7, seed: 'potato' },
  beetroots: { max: 3, seed: 'beetroot_seeds' },
};
const BREED_FOOD = {
  cow: ['wheat'], sheep: ['wheat'], mooshroom: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'golden_carrot'],
};
const RAW_FOOD = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
const INTERESTING = ['villager', 'iron_golem', 'horse', 'donkey', 'cat', 'wolf', 'parrot', 'fox', 'panda', 'axolotl', 'turtle'];

function fuelAmount(name) {
  if (name === 'coal' || name === 'charcoal') return 1;
  if (name.endsWith('_planks')) return 3;
  if (name.endsWith('_log')) return 2;
  return 0;
}

// ============================================================
// PER-BOT HUMAN LAYER
// ============================================================
function create(ctx) {
  const { slot, b, config, log, slots } = ctx;
  const H = config.human || {};
  const CH = config.chat || {};
  const SF = config.safety || {};
  const enabled = H.enabled !== false;
  const exploreRadius = H['explore-radius'] || 45;
  const actsCfg = H.activities || {};
  const chatEnabled = CH.enabled !== false;
  const botAnswer = CH['bot-answer'] || "yep, I'm one of the server's helper bots, but I'm happy to chat";
  const minSky = SF['min-sky-light'] || 9;

  slot.role = ROLES[slot.cfg.role] ? slot.cfg.role : (ROLES[slot.role] ? slot.role : pick(Object.keys(ROLES)));
  const R = ROLES[slot.role];
  const chatty = clamp(R.chatty + rand(-0.15, 0.15), 0.2, 1);
  log(`[Human] personality: ${R.label}`);

  // ---------- mood ----------
  let moodName = 'calm';
  let moodUntil = 0;
  const mood = () => (Date.now() < moodUntil ? moodName : 'calm');
  function feel(name, ms) { moodName = name; moodUntil = Date.now() + ms; slot.mood = name; }
  slot.mood = 'calm';
  slot.addInterval(() => { slot.mood = mood(); }, 5000);

  // ---------- helpers ----------
  const isOurs = (n) => slots.some((s) => s.name === n);
  const realPlayers = () => Object.values(b.players).filter((p) => p.username !== b.username && !isOurs(p.username));
  const entityOf = (name) => { const p = b.players[name]; return p && p.entity ? p.entity : null; };

  function nearestRealPlayer(maxD, forSocial) {
    let best = null;
    let bd = maxD;
    for (const p of realPlayers()) {
      const e = p.entity;
      if (!e) continue;
      if (forSocial && ((G.avoid[p.username] || 0) > Date.now() || repOf(p.username) <= -4)) continue;
      const d = e.position.distanceTo(b.entity.position);
      if (d < bd) { best = e; bd = d; }
    }
    return best;
  }

  // ---------- chat ----------
  function say(text, opts) {
    if (!chatEnabled || !text) return false;
    const now = Date.now();
    const force = opts && opts.force;
    if (!force && (now - G.lastChat < 3500 || now - (slot.lastSay || 0) < 9000)) return false;
    G.lastChat = now;
    slot.lastSay = now;
    slot.addTimeout(() => {
      if (slot.bot === b && slot.status === 'online') b.chat(text.slice(0, 200));
    }, rand(400, 1200) + text.length * 40); // typing delay
    return true;
  }

  function greetPlayer(name) {
    const f = friendOf(name);
    bump(name, 'friend', 0.5);
    if (Math.random() < 0.3 + 0.6 * chatty) say(fill(pick(f >= 3 ? GREET_FRIEND : GREET), name));
  }

  function replyFor(intent, name, addressed) {
    const f = friendOf(name);
    switch (intent) {
      case 'greet': return fill(pick(f >= 3 ? GREET_FRIEND : GREET), name);
      case 'how': return pick(['doing good, you?', 'pretty chill, you?', `not bad, just ${ACT_TEXT[slot.activity || '']}`, 'all good here']);
      case 'doing': return `just ${ACT_TEXT[slot.activity || '']}`;
      case 'thanks': return pick(['no problem', 'anytime', 'np!']);
      case 'bye': return fill(pick(['see ya {n}', 'bye {n}!', 'cya', 'take care {n}']), name);
      case 'bot': return botAnswer;
      case 'insult': return repOf(name) <= -3 ? null : pick(["that's not very nice", 'wow ok', 'rude lol']);
      case 'react': return addressed ? pick(['haha', 'lol', 'right?']) : null;
      case 'question': return addressed ? pick(['hmm, not sure', 'no idea tbh', 'good question', 'maybe?']) : null;
      default: return null;
    }
  }

  let pendingFollow = null;
  let task = null;
  const lastApproach = {};
  const cool = {};

  function onChat(username, message) {
    if (!chatEnabled || !enabled || !username || !message) return;
    if (username === b.username || isOurs(username)) return;
    const lower = String(message).toLowerCase();
    const intent = detectIntent(lower);
    if (!intent) return;
    const pick1 = chooseResponder(slots, username, lower);
    if (pick1.slot !== slot) return; // another bot answers
    const addressed = pick1.addressed;

    const r = rec(username);
    r.talks++;
    r.last = Date.now();
    dirty = true;

    // reputation / friendship effects
    if (intent === 'insult') { bump(username, 'rep', -1); if (repOf(username) <= -2) feel('angry', 20000); }
    else if (['greet', 'how', 'thanks', 'react'].includes(intent) && Date.now() - (r.lastTalk || 0) > 60000) { bump(username, 'friend', 1); r.lastTalk = Date.now(); }

    // should we answer?
    const chance = addressed ? 1 : pick1.near ? 0.25 + 0.65 * chatty : (intent === 'greet' ? 0.25 * chatty : 0);
    if (Math.random() > chance) return;

    if (intent === 'follow') {
      if (repOf(username) > -3 && (addressed || friendOf(username) >= 2 || pick1.near)) {
        pendingFollow = { name: username, until: Date.now() + 90000 };
        slot.addTimeout(() => say(fill(pick(['sure, coming {n}', 'on my way', 'ok, lead the way']), username), { force: true }), rand(800, 2000));
        if (task) { task.cancelled = true; task = null; slot.activity = ''; ctx.endTask(); }
      }
      return;
    }
    if (intent === 'away') {
      G.avoid[username] = Date.now() + 5 * 60000;
      bump(username, 'friend', -0.5);
      say('ok, sorry', { force: true });
      return;
    }
    const text = replyFor(intent, username, addressed);
    if (text) slot.addTimeout(() => say(text, { force: addressed }), rand(1200, 3500));
  }

  b.on('chat', onChat);
  // some chat plugins use formats mineflayer does not parse: fall back to "Name: message" for known players
  b.on('messagestr', (msg) => {
    const m = /^(?:\[[^\]]*\]\s*)*<?([A-Za-z0-9_]{3,16})>?\s*(?:»|:|>)\s*(.+)$/.exec(String(msg));
    if (!m || !b.players[m[1]]) return;
    const key = `${m[1]}|${m[2]}`;
    if (G.lastRaw === key && Date.now() - (G.lastRawAt || 0) < 1500) return;
    G.lastRaw = key; G.lastRawAt = Date.now();
    onChat(m[1], m[2]);
  });

  // idle small talk (rare, only when real players are online)
  let nextTalk = Date.now() + rand(4, 9) * 60000;
  slot.addInterval(() => {
    const now = Date.now();
    if (!chatEnabled || CH['idle-chatter'] === false || now < nextTalk || slot.status !== 'online') return;
    nextTalk = now + rand(6, 14) * 60000;
    if (!realPlayers().length || Math.random() > chatty) return;
    const t = b.time ? b.time.timeOfDay : 6000;
    say(t >= 13000 && t < 23000 && Math.random() < 0.5 ? pick(NIGHT_LINES) : pick(R.lines));
  }, 60000);

  // ---------- events from the brain ----------
  function onPlayerJoined(name) {
    if (!name || name === b.username || isOurs(name)) return;
    const r = rec(name);
    r.seen++;
    dirty = true;
    if (ctx.leadSlot() !== slot) return; // only one bot welcomes
    slot.addTimeout(() => {
      if (!realPlayers().some((p) => p.username === name)) return;
      if (friendOf(name) >= 3) say(fill(pick(['hey {n}, welcome back!', '{n}! good to see you again']), name));
      else if (Math.random() < 0.5 * chatty) say(fill(pick(['hey {n}', 'welcome {n}', 'hi {n}!']), name));
    }, rand(6000, 15000));
  }

  const hitWarned = {};
  function onHurt(kind, what) {
    if (kind === 'mob' && what === 'creeper') feel('scared', 12000);
    else feel('angry', 15000);
    if (Math.random() < 0.15) say(pick(['ow!', 'hey!', 'ouch']));
  }
  function onPlayerHit(name, count) {
    bump(name, 'rep', -1.5);
    feel('angry', 25000);
    if (count === 2 && Date.now() - (hitWarned[name] || 0) > 30000) {
      hitWarned[name] = Date.now();
      say(fill('{n}, stop hitting me!', name), { force: true });
    }
  }
  function onRetaliate(name) { say(fill('ok {n}, you asked for it', name), { force: true }); }
  function onKill() {
    feel('excited', 20000);
    if (Math.random() < 0.25 * chatty) say(pick(['got it', 'one down', 'easy']));
  }
  let died = false;
  function onDeath() { died = true; feel('sad', 60000); }
  function onRespawn() {
    if (died) { died = false; if (Math.random() < 0.4) say(pick(['ugh, that hurt', 'well, that happened', 'rip me'])); }
  }
  let lastCreeperSay = 0;
  function onCreeper() {
    feel('scared', 12000);
    if (Date.now() - lastCreeperSay > 30000) { lastCreeperSay = Date.now(); say('creeper!', { force: true }); }
  }

  // cooperation: tell the other bots someone is being attacked
  function reportAttack(pos, playerName) {
    G.assist.push({ slot: slot.index, pos: { x: pos.x, y: pos.y, z: pos.z }, player: playerName || null, until: Date.now() + 20000 });
  }
  function assistFor(myPos) {
    const now = Date.now();
    G.assist = G.assist.filter((a) => a.until > now);
    for (const a of G.assist) {
      if (a.slot === slot.index) continue;
      if (Math.hypot(a.pos.x - myPos.x, a.pos.z - myPos.z) < 30) return a;
    }
    return null;
  }

  // ---------- tasks ----------
  const chk = (token) => { if (token.cancelled) throw new Error('cancelled'); };

  async function goto(goal, ms, token) {
    chk(token);
    try {
      await Promise.race([
        b.pathfinder.goto(goal),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
      ]);
      return true;
    } catch (e) {
      try { b.pathfinder.setGoal(null); } catch (e2) { /* ignore */ }
      chk(token);
      return false;
    }
  }

  async function lookAround(ms, token) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      chk(token);
      try { b.look(rand(-Math.PI, Math.PI), rand(-0.4, 0.3), false); } catch (e) { /* ignore */ }
      await sleep(rand(1200, 3500));
    }
  }

  function surfaceY(x, z) {
    const o = ctx.getOrigin();
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    for (let y = Math.floor(o.y) + 8; y >= Math.floor(o.y) - 4; y--) {
      const ground = b.blockAt(new Vec3(bx, y - 1, bz));
      const feet = b.blockAt(new Vec3(bx, y, bz));
      const head = b.blockAt(new Vec3(bx, y + 1, bz));
      if (!ground || !feet || !head) return null; // chunk not loaded
      if (ground.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty'
        && !['water', 'lava'].includes(feet.name)) {
        if (typeof feet.skyLight === 'number' && feet.skyLight < minSky) return null; // looks like a cave
        return y;
      }
    }
    return null;
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

  async function collectDrops(token, max, ms) {
    const end = Date.now() + ms;
    let n = 0;
    while (Date.now() < end && n < max) {
      chk(token);
      const it = nearestItem(7);
      if (!it) { await sleep(400); if (!nearestItem(7)) break; continue; }
      await goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.8), 4000, token);
      n++;
    }
  }

  const TASKS = {
    // curiosity: walk somewhere new, or towards something interesting (animals, villagers, golems)
    async explore(token) {
      const o = ctx.getOrigin();
      for (let tries = 0; tries < 6; tries++) {
        let spot = null;
        if (Math.random() < 0.45) {
          const c = Object.values(b.entities).filter((e) => e && e.position && INTERESTING.includes(e.name)
            && e.position.distanceTo(b.entity.position) < 45 && Math.hypot(e.position.x - o.x, e.position.z - o.z) < exploreRadius + 10);
          if (c.length) { const e = pick(c); spot = { x: e.position.x + rand(-3, 3), z: e.position.z + rand(-3, 3), what: e.name }; }
        }
        if (!spot) {
          const ang = rand(0, Math.PI * 2);
          const d = rand(12, exploreRadius);
          spot = { x: o.x + Math.cos(ang) * d, z: o.z + Math.sin(ang) * d, what: null };
        }
        const y = surfaceY(spot.x, spot.z);
        if (y === null) continue;
        log(`[Explore] heading to ${Math.round(spot.x)}, ${Math.round(spot.z)}${spot.what ? ` (${spot.what})` : ''}`);
        const ok = await goto(new goals.GoalNear(spot.x, y, spot.z, 2), 45000, token);
        if (ok) {
          if (spot.what && Math.random() < 0.3 * chatty) say(pick([`oh, a ${spot.what.replace('_', ' ')}`, `look, a ${spot.what.replace('_', ' ')}!`]));
          await lookAround(rand(2500, 6000), token);
          return 'ok';
        }
      }
      return 'skip';
    },

    // make friends: walk up to a player, say hi, sometimes follow them for a while
    async social(token) { return socialTask(token, false); },
    async follow(token) { return socialTask(token, true); },

    async farm(token) {
      const ids = Object.keys(CROPS).map((n) => b.registry.blocksByName[n] && b.registry.blocksByName[n].id).filter((x) => x !== undefined);
      if (!ids.length) return 'skip';
      const mature = (blk) => blk && CROPS[blk.name] && cropAge(blk) >= CROPS[blk.name].max;
      let harvested = 0;
      const end = Date.now() + 100000;
      while (Date.now() < end && harvested < 12) {
        chk(token);
        const spots = b.findBlocks({ matching: ids, maxDistance: 24, count: 40 });
        const target = spots.map((p) => b.blockAt(p)).find(mature);
        if (!target) break;
        const near = await goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 20000, token);
        if (!near) break;
        const cur = b.blockAt(target.position);
        if (!mature(cur)) continue;
        const info = CROPS[cur.name];
        try { await b.dig(cur); } catch (e) { break; }
        harvested++;
        await sleep(300);
        chk(token);
        const seed = b.inventory.items().find((i) => i.name === info.seed);
        const soil = b.blockAt(target.position.offset(0, -1, 0));
        if (seed && soil && soil.name === 'farmland') {
          try { await b.equip(seed, 'hand'); await b.placeBlock(soil, new Vec3(0, 1, 0)); } catch (e) { /* replant failed */ }
        }
        await collectDrops(token, 4, 3000);
      }
      if (harvested) log(`[Farm] harvested ${harvested} crops`);
      return harvested ? 'ok' : 'skip';
    },

    async fish(token) {
      const rod = b.inventory.items().find((i) => i.name === 'fishing_rod');
      if (!rod) return 'skip';
      const water = b.findBlock({ matching: (blk) => blk && blk.name === 'water', maxDistance: 20 });
      if (!water) return 'skip';
      const ok = await goto(new goals.GoalNear(water.position.x, water.position.y, water.position.z, 3), 30000, token);
      if (!ok) return 'skip';
      await b.equip(rod, 'hand');
      await b.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
      let caught = 0;
      for (let cast = 0; cast < 3; cast++) {
        chk(token);
        try {
          await Promise.race([
            b.fish(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('no bite')), 45000)),
          ]);
          caught++;
        } catch (e) {
          try { b.activateItem(); } catch (e2) { /* ignore */ }
          chk(token);
        }
        await sleep(800);
      }
      if (caught) log(`[Fish] caught ${caught}`);
      return caught ? 'ok' : 'skip';
    },

    // breed animals with food from the inventory (never when there are already many)
    async breed(token) {
      const species = Object.keys(BREED_FOOD).sort(() => Math.random() - 0.5);
      for (const sp of species) {
        const item = b.inventory.items().find((i) => BREED_FOOD[sp].includes(i.name) && i.count >= 2);
        if (!item) continue;
        const animals = Object.values(b.entities).filter((e) => e && e.name === sp && e.position
          && e.position.distanceTo(b.entity.position) < 24);
        if (animals.length < 2 || animals.length >= 10) continue;
        animals.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
        const pair = animals.slice(0, 2);
        await b.equip(item, 'hand');
        for (const a of pair) {
          chk(token);
          const ok = await goto(new goals.GoalNear(a.position.x, a.position.y, a.position.z, 2), 15000, token);
          if (!ok) return 'skip';
          try { await b.activateEntity(a); } catch (e) { /* ignore */ }
          await sleep(600);
        }
        log(`[Breed] fed two ${sp}s`);
        return 'ok';
      }
      return 'skip';
    },

    // cook raw food in a nearby furnace (needs fuel in the inventory)
    async cook(token) {
      const inv = b.inventory.items();
      const raw = inv.find((i) => RAW_FOOD.includes(i.name));
      const fuel = inv.find((i) => fuelAmount(i.name) > 0);
      if (!raw || !fuel) return 'skip';
      const block = b.findBlock({ matching: (blk) => blk && ['furnace', 'smoker', 'blast_furnace'].includes(blk.name), maxDistance: 24 });
      if (!block) return 'skip';
      const ok = await goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2.5), 30000, token);
      if (!ok) return 'skip';
      const f = await b.openFurnace(block);
      let cooked = 0;
      try {
        await f.putFuel(fuel.type, null, Math.min(fuel.count, fuelAmount(fuel.name)));
        const n = Math.min(raw.count, 4);
        await f.putInput(raw.type, null, n);
        const end = Date.now() + n * 10500 + 2500;
        while (Date.now() < end) {
          chk(token);
          await sleep(2000);
        }
        if (f.outputItem()) { const out = await f.takeOutput(); cooked = out ? out.count : 0; }
      } finally {
        try { f.close(); } catch (e) { /* ignore */ }
      }
      if (cooked) log(`[Cook] cooked ${cooked} items`);
      return cooked ? 'ok' : 'skip';
    },

    async chat(token) {
      if (realPlayers().length && Math.random() < chatty) say(pick(R.lines));
      await lookAround(rand(5000, 10000), token);
      return 'ok';
    },

    async rest(token) {
      await lookAround(rand(8000, 22000), token);
      return 'ok';
    },
  };

  function cropAge(blk) {
    try {
      const p = blk.getProperties ? blk.getProperties() : null;
      if (p && p.age !== undefined) return Number(p.age);
    } catch (e) { /* ignore */ }
    return Number(blk.metadata);
  }

  async function socialTask(token, long) {
    const pending = pendingFollow && Date.now() < pendingFollow.until ? pendingFollow.name : null;
    const target = pending ? entityOf(pending) : nearestRealPlayer(60, true);
    if (!target) return 'skip';
    const name = target.username;
    lastApproach[name] = Date.now();
    if (target.position.distanceTo(b.entity.position) > 4.5) {
      const p = target.position;
      const ok = await goto(new goals.GoalNear(p.x, p.y, p.z, 3), 30000, token);
      if (!ok) return 'skip';
    }
    chk(token);
    greetPlayer(name);
    const o = ctx.getOrigin();
    if (long || pending || Math.random() < 0.5) {
      const until = Date.now() + (pending ? 60000 : rand(25000, 70000));
      b.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
      while (Date.now() < until) {
        await sleep(600);
        chk(token);
        const cur = entityOf(name);
        if (!cur) break;
        if ((G.avoid[name] || 0) > Date.now()) break;
        if (Math.hypot(cur.position.x - o.x, cur.position.z - o.z) > exploreRadius + 15) break;
        if (cur.position.distanceTo(b.entity.position) < 6 && Math.random() < 0.12) {
          try { b.lookAt(cur.position.offset(0, 1.6, 0), false); } catch (e) { /* ignore */ }
        }
      }
      try { b.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
      pendingFollow = null;
      if (Math.random() < 0.5 * chatty) say(pick(['gotta go do some stuff, see ya', 'ok, heading off for now', 'catch you later']));
    } else {
      await lookAround(rand(2500, 5000), token);
    }
    bump(name, 'friend', 0.5);
    return 'ok';
  }

  // ---------- goal selection (personality + daily routine + mood) ----------
  let lastAct = '';
  let lastTaskEnd = Date.now();
  const FAIL_COOL = { farm: 120000, fish: 600000, breed: 300000, cook: 240000, explore: 60000, social: 90000, follow: 60000 };

  function pickActivity() {
    if (!enabled) return null;
    const now = Date.now();
    if (pendingFollow && now < pendingFollow.until && entityOf(pendingFollow.name)) return 'follow';

    const w = { ...R.weights };
    const t = b.time && Number.isFinite(b.time.timeOfDay) ? b.time.timeOfDay : 6000;
    // daily routine
    if (t < 4000 || t >= 23000) { w.farm *= 1.8; w.fish *= 1.4; }
    else if (t < 9000) { w.social *= 1.4; w.explore *= 1.4; w.follow *= 1.3; }
    else if (t < 12500) { w.cook *= 1.8; w.breed *= 1.4; w.explore *= 1.2; }
    else if (t < 14000) { w.rest *= 2; w.explore *= 0.3; w.farm *= 0.4; }
    else { w.explore = 0; w.fish *= 0.2; w.farm *= 0.2; w.social *= 0.5; w.rest *= 3; w.cook *= 1.5; w.chat *= 1.5; }

    if (mood() === 'calm' && now - lastTaskEnd > 4 * 60000) feel('bored', 60000);
    const m = mood();
    if (m === 'bored') w.explore *= 2.5;
    if (m === 'angry') { w.rest = 0; w.social *= 0.2; }
    if (m === 'scared') { w.rest *= 3; w.explore = 0; w.social *= 0.3; }
    if (m === 'happy' || m === 'excited') { w.social *= 1.5; w.chat *= 1.5; }

    const anyone = !!nearestRealPlayer(60, true);
    for (const a of Object.keys(w)) {
      if ((cool[a] || 0) > now || actsCfg[a] === false) w[a] = 0;
      if (a === lastAct) w[a] *= 0.4;
    }
    if (!anyone) { w.social = 0; w.follow = 0; }
    if (!realPlayers().length) w.chat *= 0.3;

    const total = Object.values(w).reduce((s, v) => s + v, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const [a, v] of Object.entries(w)) {
      r -= v;
      if (r <= 0) { lastAct = a; return a === 'wander' ? null : a; }
    }
    return null;
  }

  function startTask(name) {
    if (!TASKS[name] || task) return false;
    const token = { cancelled: false, name };
    task = token;
    slot.activity = name;
    ctx.enterTask(150000);
    log(`[Goal] ${name} (mood ${mood()})`);
    (async () => {
      let res = 'skip';
      try { res = await TASKS[name](token); } catch (e) { if (!token.cancelled) log(`[Task] ${name} failed: ${e.message}`); }
      cool[name] = Date.now() + (res === 'ok' ? 20000 : (FAIL_COOL[name] || 90000));
      if (task === token) {
        task = null;
        slot.activity = '';
        lastTaskEnd = Date.now();
        if (res === 'ok' && mood() === 'bored') feel('calm', 1000);
        ctx.endTask();
      }
    })();
    return true;
  }

  function cancelTask() {
    if (task) { task.cancelled = true; task = null; slot.activity = ''; }
  }

  return {
    pickActivity, startTask, cancelTask, feel, mood, say,
    onPlayerJoined, onHurt, onPlayerHit, onRetaliate, onKill, onDeath, onRespawn, onCreeper,
    reportAttack, assistFor,
    friendship: friendOf, reputation: repOf,
    isTaskRunning: () => !!task,
    isOurs,
  };
}

module.exports = { create, saveSocial, social };
