(function () {
  const box = document.createElement("pre");
  box.id = "debug-overlay";
  box.style.cssText = `
    position:fixed; left:12px; bottom:12px; max-width:calc(100vw - 24px);
    max-height:40vh; overflow:auto; z-index:99999; margin:0;
    background:rgba(120,0,0,0.92); color:#fff; padding:10px 12px;
    border-radius:10px; font:12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    box-shadow:0 10px 25px rgba(0,0,0,0.35); display:none;
    white-space:pre-wrap;
  `;
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(box));

  function show(msg) {
    box.style.display = "block";
    box.textContent = "🚨 SKETCH ERROR (copy/paste this to Copilot)\n\n" + msg;
  }

  window.addEventListener("error", (event) => {
    const e = event.error;
    show(
      `${event.message}\n` +
      `${event.filename || ""}:${event.lineno || ""}:${event.colno || ""}\n` +
      (e && e.stack ? `\n${e.stack}` : "")
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const r = event.reason;
    show(`UNHANDLED PROMISE REJECTION:\n${(r && r.stack) ? r.stack : String(r)}`);
  });
})();

/* ============================================================
   p5 SKETCH (instance mode)
   ============================================================ */
new p5(function (p) {

  // ----------------------------
  // CONFIG
  // ----------------------------
  const NZ_LAT = -41.21;
  const NZ_LON = 174.90;
  const WEATHER_REFRESH_MS = 10 * 60 * 1000;

  const STORAGE_KEY = "mddn242_familiar_state_v10_roots_corruptChicken";

  const GROUND_H = 60;
  const PICK_RADIUS = 140;

  const HUNGER_PER_SEC = 1.2;
  const DRAG_HUNGER_PER_SEC = 2.6;
  const FEED_AMOUNT = 25;

  // ---- 100% HUNGER OVERLOAD (build clutter over 30s, then explode) ----
  const OVERLOAD_SECONDS = 30;
  const RESPAWN_SECONDS = 10;
  const CLUTTER_CAP = 1600;

  // ---- WORLD CORRUPTION (grid) ----
  // corruption is 0..1 stored as bytes 0..255
  const CORR_CELL = 22;
  const CORR_START_HUNGER = 55;
  const CORR_FULL_HUNGER = 100;
  const CORR_EMIT_PER_SEC = 120;
  const CORR_SPREAD = 0.24;
  const CORR_DECAY_PER_SEC = 8;
  const CORR_PURIFY_PER_SEC = 18;
  const CORR_PURIFY_RADIUS = 160;
  const CORR_DRAW_ALPHA = 165;

  // ---- ROOT VEINS (branching growth) ----
  const ROOT_MAX_TIPS = 160;
  const ROOT_MAX_POINTS = 9000;
  const ROOT_STEP_MIN = 2.0;
  const ROOT_STEP_MAX = 6.0;
  const ROOT_BRANCH_CHANCE = 0.020;   // per tip per second at full hunger
  const ROOT_FADE_PER_SEC = 0.65;
  const ROOT_SPAWN_RATE = 1.6;        // tips/sec at full hunger from chicken
  const ROOT_INFECT_SPAWN = 0.8;      // extra spawn from infected ground
  const CORR_DRAW_GRID = false;       // keep stains OFF, roots ON

  // ----------------------------
  // STATE
  // ----------------------------
  let creature;
  let state = "idle";

  let chaosTime = 0;
  let stateTimer = 0;
  let targetTimer = 0;

  let legPhase = 0;
  let peckPhase = 0;
  let pecksLeft = 0;

  let hunger = 0;

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Seeds / planting
  let seedCount = 5;
  let draggingSeed = false;
  let seedDrag = { x: 0, y: 0 };

  let flowers = [];
  let particles = [];

  // Weather FX
  let rain = [];
  let lightning = 0;

  // ---- Overload / Respawn ----
  let overloadTimer = 0;
  let overloadLevel = 0;

  let respawning = false;
  let respawnT = 0;

  // click-to-move
  let clickMoveActive = false;

  // clutter bits
  let clutterBits = [];

  // ---- corruption field ----
  let corrW = 0, corrH = 0;
  let corr = null;       // Uint8Array
  let corrNext = null;   // Uint8Array

  // ---- root veins ----
  let rootTips = [];
  let rootPointCount = 0;
  let rootSpawnAcc = 0;

  // NZ time
  let nz = {
    minutes: 720,
    daylight: 1,
    isNight: false,
    month: 1
  };

  // Weather state
  let weather = {
    mode: "sim",        // "live" or "sim"
    ok: false,
    lastFetch: 0,
    fetching: false,
    code: 2,
    desc: "Weather",
    wind: 12,
    precip: 0
  };

  // ----------------------------
  // HELPERS
  // ----------------------------
  function groundY() { return p.height - GROUND_H; }

  function createCreature(x, y) {
    return { x, y, targetX: x, targetY: y, facing: 1 };
  }

  function setClickTarget(mx, my) {
    creature.targetX = p.constrain(mx, 150, p.width - 150);
    creature.targetY = p.constrain(my, 80, groundY() - 40);
    creature.facing = creature.targetX > creature.x ? 1 : -1;

    clickMoveActive = true;
    state = "walking";
    stateTimer = 0;
    targetTimer = 999999;
  }

  // ----------------------------
  // WORLD CORRUPTION (grid)
  // ----------------------------
  function corrIndex(ix, iy) { return ix + iy * corrW; }

  function initCorruption() {
    corrW = Math.max(1, Math.ceil(p.width / CORR_CELL));
    corrH = Math.max(1, Math.ceil(groundY() / CORR_CELL));
    corr = new Uint8Array(corrW * corrH);
    corrNext = new Uint8Array(corrW * corrH);
  }

  function sampleCorr01(x, y) {
    if (!corr) return 0;
    const ix = p.constrain(Math.floor(x / CORR_CELL), 0, corrW - 1);
    const iy = p.constrain(Math.floor(y / CORR_CELL), 0, corrH - 1);
    return corr[corrIndex(ix, iy)] / 255;
  }

  function addCorrBlob(x, y, radius, amountBytes) {
    if (!corr) return;

    const cx = Math.floor(x / CORR_CELL);
    const cy = Math.floor(y / CORR_CELL);
    const r = Math.ceil(radius / CORR_CELL);

    for (let oy = -r; oy <= r; oy++) {
      const iy = cy + oy;
      if (iy < 0 || iy >= corrH) continue;

      for (let ox = -r; ox <= r; ox++) {
        const ix = cx + ox;
        if (ix < 0 || ix >= corrW) continue;

        const dx = ox * CORR_CELL;
        const dy = oy * CORR_CELL;
        const d = Math.sqrt(dx * dx + dy * dy);

        if (d <= radius) {
          const t = 1 - (d / radius);
          const boost = amountBytes * (t * t);
          const idx = corrIndex(ix, iy);
          const v = corr[idx] + boost;
          corr[idx] = v > 255 ? 255 : v;
        }
      }
    }
  }

  function purifyCorr(x, y, radius, amountBytes) {
    if (!corr) return;

    const cx = Math.floor(x / CORR_CELL);
    const cy = Math.floor(y / CORR_CELL);
    const r = Math.ceil(radius / CORR_CELL);

    for (let oy = -r; oy <= r; oy++) {
      const iy = cy + oy;
      if (iy < 0 || iy >= corrH) continue;

      for (let ox = -r; ox <= r; ox++) {
        const ix = cx + ox;
        if (ix < 0 || ix >= corrW) continue;

        const dx = ox * CORR_CELL;
        const dy = oy * CORR_CELL;
        const d = Math.sqrt(dx * dx + dy * dy);

        if (d <= radius) {
          const t = 1 - (d / radius);
          const cut = amountBytes * (t * t);
          const idx = corrIndex(ix, iy);
          const v = corr[idx] - cut;
          corr[idx] = v < 0 ? 0 : v;
        }
      }
    }
  }

  function updateCorruption(dt) {
    if (!corr) return;

    let a = p.map(hunger, CORR_START_HUNGER, CORR_FULL_HUNGER, 0, 1);
    a = p.constrain(a, 0, 1);

    // emit around chicken
    if (!respawning && a > 0.001) {
      const emit = CORR_EMIT_PER_SEC * a * dt;

      const blobs = 2 + Math.floor(a * 4);
      for (let i = 0; i < blobs; i++) {
        const ang = p.noise(chaosTime * 0.6, i * 10.3) * p.TWO_PI * 2;
        const rad = p.lerp(20, 95, p.noise(i * 4.1, chaosTime * 0.9));
        const bx = creature.x + Math.cos(ang) * rad;
        const by = creature.y + Math.sin(ang) * rad * 0.7;
        addCorrBlob(bx, by, p.lerp(70, 130, a), emit * 255);
      }
    }

    // plants purify
    for (const f of flowers) {
      purifyCorr(f.x, f.y - 15, 90, 16 * dt * 255);
    }

    // global purify when hunger is low
    const calm = 1 - p.constrain(hunger / CORR_START_HUNGER, 0, 1);
    const globalPurify = CORR_PURIFY_PER_SEC * calm * dt;

    const spread = CORR_SPREAD;
    const decay = CORR_DECAY_PER_SEC * dt;
    const gpur = globalPurify;

    for (let y = 0; y < corrH; y++) {
      for (let x = 0; x < corrW; x++) {
        const idx = corrIndex(x, y);
        const v = corr[idx];

        let sum = v;
        let count = 1;

        if (x > 0) { sum += corr[idx - 1]; count++; }
        if (x < corrW - 1) { sum += corr[idx + 1]; count++; }
        if (y > 0) { sum += corr[idx - corrW]; count++; }
        if (y < corrH - 1) { sum += corr[idx + corrW]; count++; }

        if (x > 0 && y > 0) { sum += corr[idx - corrW - 1]; count++; }
        if (x < corrW - 1 && y > 0) { sum += corr[idx - corrW + 1]; count++; }
        if (x > 0 && y < corrH - 1) { sum += corr[idx + corrW - 1]; count++; }
        if (x < corrW - 1 && y < corrH - 1) { sum += corr[idx + corrW + 1]; count++; }

        const avg = sum / count;

        let nv = v + (avg - v) * spread;

        let a2 = p.map(hunger, CORR_START_HUNGER, CORR_FULL_HUNGER, 0, 1);
        a2 = p.constrain(a2, 0, 1);
        if (a2 > 0.001 && avg > 70) {
          nv += (avg - 70) * 0.06 * a2;
        }

        nv -= decay;
        nv -= gpur;

        if (nv < 0) nv = 0;
        if (nv > 255) nv = 255;

        corrNext[idx] = nv | 0;
      }
    }

    const tmp = corr;
    corr = corrNext;
    corrNext = tmp;
  }

  function maxCorrByte() {
    if (!corr) return 0;
    let m = 0;
    const step = 5;
    for (let i = 0; i < corr.length; i += step) {
      if (corr[i] > m) m = corr[i];
    }
    return m;
  }

  function drawCorruptionOverlay() {
    if (!corr) return;

    const maxV = maxCorrByte();
    const worldAmt = p.constrain(maxV / 255, 0, 1);

    let a = p.map(hunger, CORR_START_HUNGER, CORR_FULL_HUNGER, 0, 1);
    a = p.constrain(a, 0, 1);

    const vis = p.constrain(0.25 * worldAmt + 0.85 * a, 0, 1);
    if (vis < 0.02) return;

    // optional subtle haze (kept very light so it doesn't “change your style” too much)
    p.push();
    p.noStroke();
    p.fill(25, 25, 40, 22 * vis);
    p.rect(0, 0, p.width, groundY());
    p.pop();

    // keep grid stains OFF unless you toggle CORR_DRAW_GRID = true
    if (CORR_DRAW_GRID) {
      p.push();
      p.noStroke();
      const alphaCap = CORR_DRAW_ALPHA * vis;

      for (let y = 0; y < corrH; y++) {
        for (let x = 0; x < corrW; x++) {
          const idx = corrIndex(x, y);
          const v = corr[idx];
          if (v < 6) continue;

          const t = v / 255;
          const r = p.lerp(45, 30, t);
          const g = p.lerp(65, 120, t * 0.6);
          const b = p.lerp(80, 140, t);
          const ax = (t * alphaCap);

          p.fill(r, g, b, ax);
          p.rect(x * CORR_CELL, y * CORR_CELL, CORR_CELL + 1, CORR_CELL + 1, 5);
        }
      }
      p.pop();
    }
  }

  // --- compression for localStorage ---
  function packCorr() {
    try {
      if (!corr) return "";
      let bin = "";
      for (let i = 0; i < corr.length; i++) bin += String.fromCharCode(corr[i]);
      return btoa(bin);
    } catch (e) {
      return "";
    }
  }

  function unpackCorr(b64, w, h) {
    try {
      if (!b64) return false;
      const bin = atob(b64);
      if (bin.length !== w * h) return false;
      corrW = w;
      corrH = h;
      corr = new Uint8Array(w * h);
      corrNext = new Uint8Array(w * h);
      for (let i = 0; i < bin.length; i++) corr[i] = bin.charCodeAt(i) & 255;
      return true;
    } catch (e) {
      return false;
    }
  }

  function resampleCorr(oldArr, oldW, oldH, newW, newH) {
    const out = new Uint8Array(newW * newH);
    for (let y = 0; y < newH; y++) {
      const sy = Math.floor((y / newH) * oldH);
      for (let x = 0; x < newW; x++) {
        const sx = Math.floor((x / newW) * oldW);
        out[x + y * newW] = oldArr[sx + sy * oldW];
      }
    }
    return out;
  }

  // ----------------------------
  // ROOT VEINS (branching growth)
  // ----------------------------
  function lerpAngle(a, b, t) {
    let d = (b - a + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return a + d * t;
  }

  function spawnRootTip(x, y, baseDir, thick, seed) {
    if (rootTips.length >= ROOT_MAX_TIPS) return;
    if (rootPointCount >= ROOT_MAX_POINTS) return;

    const tip = {
      pts: [{ x, y }],
      dir: baseDir,
      thick,
      seed,
      alive: true,
      fade: 1
    };
    rootTips.push(tip);
    rootPointCount += 1;
  }

  function spawnRootsFromChicken(a, dt) {
    if (a <= 0.001) return;

    rootSpawnAcc += ROOT_SPAWN_RATE * a * dt;
    while (rootSpawnAcc >= 1) {
      rootSpawnAcc -= 1;

      const ang = p.random(p.TWO_PI);
      const r = p.random(12, 55);
      const x = creature.x + Math.cos(ang) * r;
      const y = creature.y + Math.sin(ang) * r * 0.7;

      const baseDir = Math.atan2(y - creature.y, x - creature.x);

      spawnRootTip(
        p.constrain(x, 10, p.width - 10),
        p.constrain(y, 10, groundY() - 20),
        baseDir + p.random(-0.35, 0.35),
        p.random(2.2, 3.4) * (0.65 + 0.55 * a),
        p.random(9999)
      );
    }
  }

  function spawnRootsFromInfection(dt) {
    if (!corr || rootTips.length >= ROOT_MAX_TIPS) return;

    const m = maxCorrByte();
    if (m < 140) return;

    const chance = ROOT_INFECT_SPAWN * (m / 255) * dt;
    if (p.random() > chance) return;

    for (let tries = 0; tries < 10; tries++) {
      const ix = p.int(p.random(corrW));
      const iy = p.int(p.random(corrH));
      const v = corr[corrIndex(ix, iy)];
      if (v < 160) continue;

      const x = ix * CORR_CELL + CORR_CELL * 0.5;
      const y = iy * CORR_CELL + CORR_CELL * 0.5;

      const ang = p.noise(ix * 0.11, iy * 0.11, chaosTime * 0.2) * p.TWO_PI * 2;
      spawnRootTip(x, y, ang, p.random(1.6, 2.6), p.random(9999));
      break;
    }
  }

  function purgeRoots(x, y, radius) {
    const r2 = radius * radius;
    for (const tip of rootTips) {
      if (!tip.pts.length) continue;
      const pLast = tip.pts[tip.pts.length - 1];
      const dx = pLast.x - x;
      const dy = pLast.y - y;
      if (dx * dx + dy * dy < r2) {
        tip.alive = false;
      }
    }
  }

  function updateRoots(dt) {
    let a = p.map(hunger, CORR_START_HUNGER, CORR_FULL_HUNGER, 0, 1);
    a = p.constrain(a, 0, 1);

    if (!respawning) {
      spawnRootsFromChicken(a, dt);
      spawnRootsFromInfection(dt);
    }

    for (let i = rootTips.length - 1; i >= 0; i--) {
      const tip = rootTips[i];

      if (!tip.alive) {
        tip.fade -= ROOT_FADE_PER_SEC * dt;
        if (tip.fade <= 0) {
          rootPointCount -= tip.pts.length;
          rootTips.splice(i, 1);
        }
        continue;
      }

      const last = tip.pts[tip.pts.length - 1];

      if (last.x < -20 || last.x > p.width + 20 || last.y < -20 || last.y > groundY() - 10) {
        tip.alive = false;
        continue;
      }

      const localC = sampleCorr01(last.x, last.y);

      const nAng = p.noise(last.x * 0.006, last.y * 0.006, chaosTime * 0.35 + tip.seed) * p.TWO_PI * 2;
      const outAng = Math.atan2(last.y - creature.y, last.x - creature.x);

      const noisyMix = p.lerp(0.45, 0.85, a);
      const targetAng = lerpAngle(outAng, nAng, noisyMix);

      tip.dir = lerpAngle(tip.dir, targetAng, 0.16);

      const step = p.lerp(ROOT_STEP_MIN, ROOT_STEP_MAX, a) * (0.75 + 0.55 * p.noise(tip.seed, chaosTime));

      const nx = last.x + Math.cos(tip.dir) * step;
      const ny = last.y + Math.sin(tip.dir) * step * 0.75;

      if (rootPointCount < ROOT_MAX_POINTS) {
        tip.pts.push({
          x: p.constrain(nx, -30, p.width + 30),
          y: p.constrain(ny, -30, groundY() - 10)
        });
        rootPointCount++;
      } else {
        tip.alive = false;
        continue;
      }

      if (!respawning && a > 0.05) {
        const deposit = (30 + 140 * a) * dt * 255;
        addCorrBlob(nx, ny, p.lerp(18, 40, a), deposit);
      }

      const branchChance = ROOT_BRANCH_CHANCE * (0.4 + 0.9 * a + 0.6 * localC);
      if (rootTips.length < ROOT_MAX_TIPS && p.random() < branchChance * dt) {
        const bend = p.random() < 0.5 ? -1 : 1;
        const newDir = tip.dir + bend * p.random(0.45, 1.0);
        const newThick = tip.thick * p.random(0.55, 0.78);
        spawnRootTip(nx, ny, newDir, newThick, tip.seed + p.random(200, 900));
      }

      tip.thick *= (1 - 0.015 * dt);
      if (tip.thick < 0.7) tip.alive = false;
    }
  }

  function drawRoots() {
    if (!rootTips.length) return;

    let a = p.map(hunger, CORR_START_HUNGER, CORR_FULL_HUNGER, 0, 1);
    a = p.constrain(a, 0, 1);

    const m = maxCorrByte();
    const worldAmt = p.constrain(m / 255, 0, 1);
    const vis = p.constrain(0.25 * worldAmt + 0.85 * a, 0, 1);
    if (vis < 0.02) return;

    p.push();
    p.noFill();

    for (const tip of rootTips) {
      if (tip.pts.length < 2) continue;

      const last = tip.pts[tip.pts.length - 1];
      const localC = sampleCorr01(last.x, last.y);

      const r = p.lerp(40, 25, localC);
      const g = p.lerp(35, 110, localC * 0.7);
      const b = p.lerp(55, 160, localC);

      const alpha = (70 + 170 * vis) * tip.fade;

      p.stroke(r, g, b, alpha);
      p.strokeWeight(p.constrain(tip.thick, 0.8, 4.2));

      for (let i = 1; i < tip.pts.length; i++) {
        const a0 = tip.pts[i - 1];
        const a1 = tip.pts[i];
        p.line(a0.x, a0.y, a1.x, a1.y);
      }
    }

    p.pop();
  }

  // ----------------------------
  // PERSISTENCE
  // ----------------------------
  function saveState() {
    try {
      const data = {
        t: Date.now(),
        hunger,
        seedCount,
        creature: {
          x: creature.x, y: creature.y,
          targetX: creature.targetX, targetY: creature.targetY,
          facing: creature.facing
        },
        flowers: flowers.map(f => ({ x: f.x, t: f.t, growRate: f.growRate, wob: f.wob })),
        corr: packCorr(),
        corrW, corrH
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  function applyOfflineProgress(elapsedMs) {
    if (elapsedMs <= 0) return;

    const capped = Math.min(elapsedMs, 1000 * 60 * 60 * 24);
    const secs = capped / 1000;

    const offlineMult = (flowers.length > 0) ? 0.85 : 1.0;
    hunger = p.constrain(hunger + (HUNGER_PER_SEC * offlineMult) * secs, 0, 100);

    for (let i = flowers.length - 1; i >= 0; i--) {
      flowers[i].t += flowers[i].growRate * secs;
      if (flowers[i].t >= 1) {
        seedCount += 2;
        flowers.splice(i, 1);
      }
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data) return;

      if (typeof data.hunger === "number") hunger = data.hunger;
      if (typeof data.seedCount === "number") seedCount = data.seedCount;

      if (data.creature) {
        if (typeof data.creature.x === "number") creature.x = data.creature.x;
        if (typeof data.creature.y === "number") creature.y = data.creature.y;
        if (typeof data.creature.targetX === "number") creature.targetX = data.creature.targetX;
        if (typeof data.creature.targetY === "number") creature.targetY = data.creature.targetY;
        else creature.targetY = creature.y;
        if (typeof data.creature.facing === "number") creature.facing = data.creature.facing;
      }

      if (Array.isArray(data.flowers)) {
        flowers = data.flowers.map(f => ({
          x: f.x,
          y: groundY(),
          t: (typeof f.t === "number") ? f.t : 0,
          growRate: (typeof f.growRate === "number") ? f.growRate : p.random(0.06, 0.11),
          wob: (typeof f.wob === "number") ? f.wob : p.random(1000)
        }));
      }

      if (data.corr && typeof data.corrW === "number" && typeof data.corrH === "number") {
        const ok = unpackCorr(data.corr, data.corrW, data.corrH);
        if (!ok) initCorruption();
      }

      if (typeof data.t === "number") {
        applyOfflineProgress(Date.now() - data.t);
      }

      hunger = p.constrain(hunger, 0, 100);
      seedCount = Math.max(0, seedCount);

    } catch (e) { /* ignore */ }
  }

  // ----------------------------
  // NZ TIME
  // ----------------------------
  function updateNZTime() {
    try {
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-NZ", {
        timeZone: "Pacific/Auckland",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        month: "2-digit",
        hour12: false
      }).formatToParts(now);

      let h = 12, m = 0, s = 0, mo = 1;
      for (const part of parts) {
        if (part.type === "hour") h = parseInt(part.value, 10);
        if (part.type === "minute") m = parseInt(part.value, 10);
        if (part.type === "second") s = parseInt(part.value, 10);
        if (part.type === "month") mo = parseInt(part.value, 10);
      }

      const minutes = h * 60 + m + s / 60;

      const sunrise = 6.5 * 60;
      const sunset = 18.5 * 60;
      const twilight = 50;

      nz.minutes = minutes;
      nz.daylight = smoothDaylight(minutes, sunrise, sunset, twilight);
      nz.isNight = nz.daylight < 0.25;
      nz.month = mo;

    } catch (e) {
      const now = new Date();
      nz.minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      nz.daylight = 1;
      nz.isNight = false;
      nz.month = now.getMonth() + 1;
    }
  }

  function smoothstep(a, b, x) {
    const t = p.constrain((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function smoothDaylight(mins, sunrise, sunset, tw) {
    const up = smoothstep(sunrise - tw, sunrise + tw, mins);
    const down = 1 - smoothstep(sunset - tw, sunset + tw, mins);
    return p.constrain(up * down, 0, 1);
  }

  // ----------------------------
  // WEATHER
  // ----------------------------
  function weatherCodeToDesc(code) {
    if (code === 0) return "Clear";
    if (code === 1) return "Mostly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if ([51, 53, 55].includes(code)) return "Drizzle";
    if ([61, 63, 65].includes(code)) return "Rain";
    if ([80, 81, 82].includes(code)) return "Showers";
    if ([95, 96, 99].includes(code)) return "Thunder";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
    return "Weather";
  }
  function isRainy() {
    return [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(weather.code);
  }
  function isFoggy() {
    return weather.code === 45 || weather.code === 48;
  }
  function isStormy() {
    return [95, 96, 99].includes(weather.code);
  }

  function applySimWeather() {
    const winter = (nz.month >= 6 && nz.month <= 8);
    const evening = (nz.minutes > 17 * 60 || nz.minutes < 7 * 60);

    let r = p.noise(nz.month * 10.0, nz.minutes * 0.01);
    if (winter) r += 0.12;
    if (evening) r += 0.05;

    let code = 2;
    if (r < 0.25) code = 0;
    else if (r < 0.45) code = 2;
    else if (r < 0.60) code = 3;
    else if (r < 0.75) code = 61;
    else if (r < 0.88) code = 45;
    else code = 95;

    weather.mode = "sim";
    weather.ok = false;
    weather.code = code;
    weather.desc = weatherCodeToDesc(code);
    weather.wind = winter ? 18 : 12;
    weather.precip = isRainy() ? 1.2 : 0;
  }

  function fetchLiveWeather() {
    if (weather.fetching) return;
    weather.fetching = true;

    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${NZ_LAT}&longitude=${NZ_LON}` +
      `&current=temperature_2m,precipitation,weather_code,wind_speed_10m` +
      `&timezone=Pacific/Auckland`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        const cur = data && data.current;
        if (!cur) throw new Error("No current weather");
        weather.mode = "live";
        weather.ok = true;
        weather.code = cur.weather_code;
        weather.desc = weatherCodeToDesc(weather.code);
        weather.wind = cur.wind_speed_10m;
        weather.precip = cur.precipitation;
      })
      .catch(() => {
        applySimWeather();
      })
      .finally(() => {
        weather.fetching = false;
        weather.lastFetch = Date.now();
      });
  }

  function updateWeather() {
    const proto = window.location.protocol;
    if (proto !== "http:" && proto !== "https:") {
      applySimWeather();
      return;
    }
    if (Date.now() - weather.lastFetch > WEATHER_REFRESH_MS) {
      fetchLiveWeather();
    }
  }

  // ----------------------------
  // BEHAVIOUR
  // ----------------------------
  function enterIdle() {
    state = "idle";
    stateTimer = 0;
    clickMoveActive = false;

    const nightBoost = nz.isNight ? 1.25 : 1.0;
    const minT = p.map(hunger, 0, 100, 150, 70) * nightBoost;
    const maxT = p.map(hunger, 0, 100, 330, 170) * nightBoost;
    targetTimer = p.int(p.random(minT, maxT));
  }

  function enterWalking() {
    state = "walking";
    stateTimer = 0;
    clickMoveActive = false;

    const nightBoost = nz.isNight ? 1.15 : 1.0;
    const minT = p.map(hunger, 0, 100, 240, 130) * nightBoost;
    const maxT = p.map(hunger, 0, 100, 460, 250) * nightBoost;
    targetTimer = p.int(p.random(minT, maxT));

    creature.targetX = p.random(150, p.width - 150);
    creature.targetY = creature.y;
    creature.facing = creature.targetX > creature.x ? 1 : -1;
  }

  function enterPecking() {
    state = "pecking";
    stateTimer = 0;
    peckPhase = 0;

    const nightMult = nz.isNight ? 0.75 : 1.0;
    pecksLeft = p.int(p.random(1, 2 + p.map(hunger, 0, 100, 0, 4) * nightMult));
  }

  function updateState() {
    stateTimer++;

    let peckChance = p.map(hunger, 0, 100, 0.18, 0.78);
    peckChance = p.constrain(peckChance, 0.15, 0.85);
    if (nz.isNight) peckChance *= 0.7;

    if (state === "idle" && stateTimer > targetTimer) {
      p.random() < peckChance ? enterPecking() : enterWalking();
    }

    if (state === "walking") {
      const baseWalkSpeed = p.map(hunger, 0, 100, 0.028, 0.05);
      const nightSlow = p.lerp(0.85, 1.0, nz.daylight);

      creature.x += (creature.targetX - creature.x) * baseWalkSpeed * nightSlow;
      creature.y += (creature.targetY - creature.y) * baseWalkSpeed * 0.9 * nightSlow;

      creature.x = p.constrain(creature.x, 80, p.width - 80);
      creature.y = p.constrain(creature.y, 80, groundY() - 40);

      const baseLegSpeed = p.map(hunger, 0, 100, 0.10, 0.17);
      legPhase += baseLegSpeed * nightSlow;

      if (clickMoveActive) {
        const d = p.dist(creature.x, creature.y, creature.targetX, creature.targetY);
        if (d < 8) enterIdle();
      } else {
        if (stateTimer > targetTimer) enterIdle();
      }
    }

    if (state === "pecking") {
      const basePeckSpeed = p.map(hunger, 0, 100, 0.035, 0.075);
      const nightSlow = p.lerp(0.82, 1.0, nz.daylight);
      peckPhase += basePeckSpeed * nightSlow;

      if (peckPhase > p.PI) {
        peckPhase = 0;
        pecksLeft--;
        if (pecksLeft <= 0) enterIdle();
      }
    }
  }

  // ----------------------------
  // SCENE DRAW
  // ----------------------------
  function drawSky() {
    const d = nz.daylight;

    const nightTop = p.color(10, 14, 30);
    const nightBot = p.color(18, 20, 45);
    const dayTop = p.color(135, 206, 235);
    const dayBot = p.color(230, 248, 255);

    const stormAmt = isStormy() ? 0.25 : 0;

    for (let y = 0; y < p.height; y += 4) {
      const t = y / p.height;
      let c = p.lerpColor(p.lerpColor(nightTop, dayTop, d), p.lerpColor(nightBot, dayBot, d), t);
      if (stormAmt > 0) c = p.lerpColor(c, p.color(45, 55, 70), stormAmt);
      p.noStroke();
      p.fill(c);
      p.rect(0, y, p.width, 4);
    }

    if (d < 0.5) {
      const nightAmt = p.map(d, 0.5, 0, 0, 1);
      p.noStroke();
      for (let i = 0; i < 70 * nightAmt; i++) {
        const x = p.noise(i * 10.1, 1) * p.width;
        const y = p.noise(i * 10.1, 9) * (groundY() - 120);
        p.fill(255, 255, 255, 130 * nightAmt);
        p.circle(x, y, 2);
      }
    }
  }

  function updateAndDrawWeatherFX(dt) {
    if (isRainy()) {
      const spawn = isStormy() ? 16 : 8;
      for (let i = 0; i < spawn; i++) {
        rain.push({
          x: p.random(p.width),
          y: p.random(-60, groundY()),
          vy: p.random(520, 900),
          len: p.random(10, 18)
        });
      }
    }

    for (let i = rain.length - 1; i >= 0; i--) {
      rain[i].y += rain[i].vy * dt;
      if (rain[i].y > groundY() + 10) rain.splice(i, 1);
    }

    if (rain.length) {
      p.stroke(220, 240, 255, 140);
      p.strokeWeight(2);
      for (const r of rain) p.line(r.x, r.y, r.x, r.y + r.len);
      p.noStroke();
    }

    if (isFoggy()) {
      p.noStroke();
      p.fill(220, 230, 240, 120);
      p.rect(0, 0, p.width, groundY());
    }

    if (isStormy() && p.random() < 0.01) lightning = 1;
    if (lightning > 0) {
      p.noStroke();
      p.fill(255, 255, 255, 200 * lightning);
      p.rect(0, 0, p.width, p.height);
      lightning *= 0.85;
      if (lightning < 0.02) lightning = 0;
    }
  }

  function drawGrass() {
    const gy = groundY();
    p.noStroke();
    p.fill(120, 90, 50);
    p.rect(0, gy, p.width, GROUND_H);

    const d = nz.daylight;
    let baseGrass = p.lerpColor(p.color(55, 95, 70), p.color(90, 150, 80), d);
    if (isRainy()) baseGrass = p.lerpColor(baseGrass, p.color(55, 140, 90), 0.25);

    for (let x = 0; x < p.width; x += 8) {
      const bladeH = 20 + p.noise(x * 0.02, chaosTime * 0.6) * 30;
      const sway = p.noise(x * 0.01, chaosTime * 0.8) * 12 - 6;

      const c = sampleCorr01(x, gy - 20);
      const sick = p.lerpColor(baseGrass, p.color(65, 90, 115), p.constrain(c * 0.85, 0, 0.85));

      p.fill(sick);
      p.beginShape();
      p.vertex(x, gy);
      p.vertex(x + sway, gy - bladeH);
      p.vertex(x + 4, gy);
      p.endShape(p.CLOSE);
    }
  }

  // ----------------------------
  // FLOWERS
  // ----------------------------
  function plantSeed(x) {
    flowers.push({
      x,
      y: groundY(),
      t: 0,
      growRate: p.random(0.06, 0.11),
      wob: p.random(1000)
    });

    // planting cleans & kills nearby roots
    purifyCorr(x, groundY() - 20, 120, 220);
    purgeRoots(x, groundY() - 20, 120);

    saveState();
  }

  function easeOutCubic(t) {
    t = p.constrain(t, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  function updateFlowers(dt) {
    for (let i = flowers.length - 1; i >= 0; i--) {
      const f = flowers[i];
      f.t += f.growRate * dt;

      if (f.t >= 1) {
        seedCount += 2;
        spawnExplosion(f.x, f.y - 55);
        flowers.splice(i, 1);
        saveState();
      }
    }
  }

  function drawFlowers() {
    for (const f of flowers) {
      const g = easeOutCubic(f.t);
      const stemH = p.lerp(4, 70, g);
      const sway = (p.noise(f.wob, chaosTime * 0.8) - 0.5) * 10 * g;

      p.stroke(60, 130, 70);
      p.strokeWeight(4);
      p.line(f.x, f.y, f.x + sway, f.y - stemH);

      const bloom = p.constrain((g - 0.55) / 0.45, 0, 1);
      const size = p.lerp(0, 24, easeOutCubic(bloom));

      if (bloom > 0) {
        const bx = f.x + sway;
        const by = f.y - stemH;
        p.push();
        p.translate(bx, by);
        p.noStroke();
        p.fill(255, 120, 170);
        for (let a = 0; a < p.TWO_PI; a += p.TWO_PI / 6) {
          p.ellipse(p.cos(a) * size * 0.6, p.sin(a) * size * 0.6, size * 0.9, size * 0.6);
        }
        p.fill(255, 210, 60);
        p.circle(0, 0, size * 0.55);
        p.pop();
      }
    }
  }

  // ----------------------------
  // EXPLOSION PARTICLES
  // ----------------------------
  function spawnExplosion(x, y) {
    for (let i = 0; i < 28; i++) {
      const ang = p.random(p.TWO_PI);
      const sp = p.random(1.2, 4.2);
      particles.push({
        x, y,
        vx: p.cos(ang) * sp,
        vy: p.sin(ang) * sp - p.random(1.5, 3.5),
        life: p.random(35, 60)
      });
    }
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.vy += 0.08;
      pt.life -= 1;
      pt.vx *= 0.98;
      pt.vy *= 0.98;
      if (pt.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    p.noStroke();
    for (const pt of particles) {
      const a = p.map(pt.life, 0, 60, 0, 200);
      p.fill(255, 170, 90, a);
      p.circle(pt.x, pt.y, 6);
    }
  }

  // ----------------------------
  // CLUTTER (builds over time)
  // ----------------------------
  function spawnClutter(count) {
    if (clutterBits.length > CLUTTER_CAP) return;

    for (let i = 0; i < count; i++) {
      if (clutterBits.length > CLUTTER_CAP) break;

      const a = p.random(p.TWO_PI);
      const sp = p.random(50, 340);
      clutterBits.push({
        x: p.random(p.width),
        y: p.random(groundY()),
        vx: p.cos(a) * sp,
        vy: p.sin(a) * sp,
        r: p.random(6, 22),
        rot: p.random(p.TWO_PI),
        vr: p.random(-4, 4),
        life: p.random(1.2, 5.0),
        col: p.random() < 0.5 ? 0 : 1
      });
    }
  }

  function updateClutter(dt) {
    for (let i = clutterBits.length - 1; i >= 0; i--) {
      const b = clutterBits[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.988;
      b.vy *= 0.988;
      b.rot += b.vr * dt;

      if (b.x < -50) b.x = p.width + 50;
      if (b.x > p.width + 50) b.x = -50;
      if (b.y < -50) b.y = groundY() + 50;
      if (b.y > groundY() + 50) b.y = -50;

      b.life -= dt;
      if (b.life <= 0) clutterBits.splice(i, 1);
    }
  }

  function drawClutter() {
    if (!clutterBits.length) return;

    const c1 = p.color(220, 170, 80);
    const c2 = p.color(235, 195, 120);

    const darkness = p.map(overloadLevel, 0, 1, 0, 55);
    p.noStroke();
    p.fill(0, darkness);
    p.rect(0, 0, p.width, groundY());

    for (const b of clutterBits) {
      const a = p.constrain(p.map(b.life, 0, 5.0, 0, 160), 0, 160);
      const base = (b.col === 0) ? c1 : c2;

      p.push();
      p.translate(b.x, b.y);
      p.rotate(b.rot);

      p.noStroke();
      p.fill(p.red(base), p.green(base), p.blue(base), a);
      p.ellipse(0, 0, b.r * 1.2, b.r);

      p.fill(245, 200, 60, a);
      p.triangle(b.r * 0.4, 0, b.r * 1.1, b.r * 0.15, b.r * 1.1, -b.r * 0.15);

      p.pop();
    }

    const lines = Math.floor(p.map(overloadLevel, 0, 1, 0, 18));
    if (lines > 0) {
      p.stroke(0, 45);
      p.strokeWeight(2);
      for (let i = 0; i < lines; i++) {
        p.line(p.random(p.width), p.random(groundY()), p.random(p.width), p.random(groundY()));
      }
      p.noStroke();
    }
  }

  function explodeAndRespawn() {
    lightning = Math.max(lightning, 1);
    spawnExplosion(creature.x, creature.y - 20);

    respawning = true;
    respawnT = RESPAWN_SECONDS;

    overloadTimer = 0;
    overloadLevel = 0;
    clutterBits.length = 0;

    dragging = false;
    draggingSeed = false;
    clickMoveActive = false;
  }

  function respawnCreature() {
    respawning = false;
    respawnT = 0;

    creature.x = p.random(120, p.width - 120);
    creature.y = p.random(120, groundY() - 60);
    creature.targetX = creature.x;
    creature.targetY = creature.y;
    creature.facing = p.random() < 0.5 ? -1 : 1;

    hunger = 0;
    overloadTimer = 0;
    overloadLevel = 0;

    // cleanse burst + kill roots
    purifyCorr(creature.x, creature.y, 240, 255);
    purgeRoots(creature.x, creature.y, 240);

    enterIdle();
    spawnExplosion(creature.x, creature.y - 25);
  }

  // ----------------------------
  // CHAOS BODY SHAPES
  // ----------------------------
  function noisyEllipse(x, y, w, h, chaos) {
    p.beginShape();
    const detail = 14;
    for (let i = 0; i < p.TWO_PI; i += p.TWO_PI / detail) {
      const nx = x + p.cos(i) * (w / 2 + p.random(-chaos * 18, chaos * 18));
      const ny = y + p.sin(i) * (h / 2 + p.random(-chaos * 18, chaos * 18));
      p.vertex(nx, ny);
    }
    p.endShape(p.CLOSE);
  }

  function chaosEllipse(x, y, w, h, chaos) {
    chaos === 0 ? p.ellipse(x, y, w, h) : noisyEllipse(x, y, w, h, chaos);
  }

  // ----------------------------
  // CREATURE (now changes with corruption)
  // ----------------------------
  function drawCreature(c) {
    // hunger-driven chaos
    let chaos = p.map(hunger, 45, 100, 0, 1);
    chaos = p.constrain(chaos, 0, 1);

    // world corruption under chicken + hunger
    const groundCorrupt = sampleCorr01(c.x, c.y);
    const corrupt = p.constrain(Math.max(groundCorrupt, chaos), 0, 1);

    // keep your original style: corruption changes are smooth + layered
    const shapeChaos = p.constrain(chaos * 0.85 + corrupt * 0.35, 0, 1);

    // reduce eye-hurting jitter: still moves, but smoothly
    const jx = (p.noise(chaosTime * 0.8, 0) - 0.5) * shapeChaos * 10;
    const jy = (p.noise(0, chaosTime * 0.8) - 0.5) * shapeChaos * 10;

    p.push();
    p.translate(c.x + jx, c.y + jy);
    p.scale(c.facing, 1);

    // color shift: warm -> sickly/ashy
    const baseBodyA = p.color(220, 170, 80);
    const baseBodyB = p.color(235, 195, 120);
    const sickBodyA = p.color(145, 175, 135);
    const sickBodyB = p.color(120, 150, 160);

    const colA = p.lerpColor(baseBodyA, sickBodyA, corrupt * 0.75);
    const colB = p.lerpColor(baseBodyB, sickBodyB, corrupt * 0.75);

    // BODY
    p.noStroke();
    p.fill(colA);
    chaosEllipse(0, 20, 220, 160, shapeChaos);

    p.fill(colB);
    chaosEllipse(-20, 30, 160, 120, shapeChaos);

    // corruption bruises/spots
    if (corrupt > 0.15) {
      const spots = 5 + Math.floor(corrupt * 9);
      for (let i = 0; i < spots; i++) {
        const sx = p.noise(chaosTime * 0.2, i * 33.1) * 120 - 60;
        const sy = p.noise(i * 18.2, chaosTime * 0.2) * 80 - 20;
        const sr = p.lerp(8, 22, p.noise(i * 7.7, chaosTime * 0.3)) * (0.6 + corrupt);
        p.fill(40, 35, 70, 45 * corrupt);
        p.ellipse(sx, sy + 25, sr * 1.1, sr);
      }
    }

    // TAIL
    const baseTail = p.color(210, 160, 90);
    const sickTail = p.color(110, 120, 150);
    p.fill(p.lerpColor(baseTail, sickTail, corrupt * 0.8));
    chaosEllipse(-120, -10, 90, 80, shapeChaos);
    chaosEllipse(-110, -40, 70, 60, shapeChaos);
    chaosEllipse(-90, -60, 50, 40, shapeChaos);

    // HEAD
    const peckAmt = (state === "pecking") ? p.constrain(p.sin(peckPhase), 0, 1) : 0;

    p.push();
    p.translate(95 + peckAmt * 16, -40);
    p.rotate(p.radians(peckAmt * (18 + shapeChaos * 30)));
    p.translate(0, peckAmt * (24 + shapeChaos * 20));

    p.fill(p.lerpColor(baseBodyA, sickBodyA, corrupt * 0.8));
    chaosEllipse(0, 0, 80, 70, shapeChaos);

    // comb goes darker with corruption
    p.fill(p.lerpColor(p.color(200, 40, 40), p.color(90, 25, 70), corrupt * 0.9));
    p.triangle(0, -25, -15, -45, 15, -45);

    // beak dulls
    p.fill(p.lerpColor(p.color(245, 200, 60), p.color(160, 165, 120), corrupt * 0.85));
    p.triangle(35, 0, 70, 8, 35, 15);

    // eye: turns “infected glow”
    if (corrupt < 0.35) {
      p.fill(0);
      p.circle(5, -5, 6);
    } else {
      const glow = p.constrain((corrupt - 0.35) / 0.65, 0, 1);
      p.noStroke();
      p.fill(170, 255, 215, 120 * glow);
      p.circle(5, -5, 14 * glow);
      p.fill(10, 10, 10);
      p.circle(5, -5, p.lerp(6, 3, glow));
      p.fill(140, 255, 200, 220 * glow);
      p.circle(5, -5, 5 * glow);
    }

    // little face veins
    if (corrupt > 0.35) {
      p.stroke(35, 25, 70, 95 * corrupt);
      p.strokeWeight(2);
      for (let i = 0; i < 5; i++) {
        const ang = p.noise(i * 2.1, chaosTime * 0.5) * p.TWO_PI;
        p.line(0, -2, p.cos(ang) * 16, p.sin(ang) * 10);
      }
      p.noStroke();
    }

    p.pop(); // end head

    // BODY VEINS (roots-like lines on chicken)
    if (corrupt > 0.25) {
      p.stroke(35, 25, 70, 85 * corrupt);
      p.strokeWeight(2);
      const veinLines = 8 + Math.floor(corrupt * 14);
      for (let i = 0; i < veinLines; i++) {
        const x1 = p.noise(i * 10.1, chaosTime * 0.25) * 160 - 80;
        const y1 = p.noise(chaosTime * 0.25, i * 12.7) * 110 - 35;
        const ang = p.noise(i * 9.3, chaosTime * 0.4) * p.TWO_PI * 2;
        const len = p.lerp(10, 34, p.noise(i * 4.4, chaosTime * 0.33)) * (0.6 + corrupt);
        p.line(x1, y1 + 30, x1 + Math.cos(ang) * len, y1 + 30 + Math.sin(ang) * len * 0.6);
      }
      p.noStroke();
    }

    // LEGS (unchanged look; slight discolor only)
    p.stroke(p.lerpColor(p.color(200, 170, 60), p.color(140, 150, 150), corrupt * 0.7));
    p.strokeWeight(4);

    const swing = (state === "walking") ? p.sin(legPhase) * 0.5 : 0;
    const legJitter = shapeChaos * 2;

    p.push();
    p.translate(-20 + p.random(-legJitter, legJitter), 80);
    p.rotate(swing);
    p.line(0, 0, 0, 32);
    p.line(0, 32, -8, 38);
    p.line(0, 32, 8, 38);
    p.line(0, 32, 0, 42);
    p.pop();

    p.push();
    p.translate(15 + p.random(-legJitter, legJitter), 80);
    p.rotate(-swing);
    p.line(0, 0, 0, 32);
    p.line(0, 32, -8, 38);
    p.line(0, 32, 8, 38);
    p.line(0, 32, 0, 42);
    p.pop();

    // GLITCH LINES (keep your original chaos logic)
    if (chaos > 0.5) {
      p.stroke(0, 40);
      for (let i = 0; i < chaos * 10; i++) {
        p.line(p.random(-140, 140), p.random(-80, 120), p.random(-140, 140), p.random(-80, 120));
      }
    }

    p.pop();
  }

  // ----------------------------
  // HUD
  // ----------------------------
  function drawPanel(x, y, w, h) {
    p.noStroke();
    p.fill(15, 15, 18, 210);
    p.rect(x, y, w, h, 14);
    p.noFill();
    p.stroke(255, 170);
    p.strokeWeight(2);
    p.rect(x, y, w, h, 14);
  }

  function seedIconPos() {
    return { x: p.width - 92, y: 42 };
  }

  function drawHUD() {
    // Hunger (top-left)
    drawPanel(14, 14, 300, 92);

    p.noStroke();
    p.fill(255);
    p.textAlign(p.LEFT, p.TOP);
    p.textSize(16);
    p.text("HUNGER", 28, 22);

    const bx = 28, by = 56, bw = 260, bh = 24;
    p.noStroke();
    p.fill(0, 140);
    p.rect(bx, by, bw, bh, 10);

    const t = p.constrain(hunger / 100, 0, 1);
    const col = p.lerpColor(p.color(80, 220, 120), p.color(255, 90, 90), t);
    p.fill(col);
    p.rect(bx + 3, by + 3, (bw - 6) * t, bh - 6, 8);

    p.noFill();
    p.stroke(255, 230);
    p.strokeWeight(2);
    p.rect(bx, by, bw, bh, 10);

    p.noStroke();
    p.fill(255);
    p.textAlign(p.RIGHT, p.CENTER);
    p.textSize(14);
    p.text(Math.round(hunger) + "%", bx + bw, by + bh / 2);

    // status line
    p.fill(255, 220);
    p.textAlign(p.LEFT, p.TOP);
    p.textSize(12);
    if (respawning) {
      p.text("RESPAWN IN " + Math.ceil(respawnT) + "s", 28, 82);
    } else if (hunger >= 100) {
      const remain = Math.max(0, Math.ceil(OVERLOAD_SECONDS - overloadTimer));
      p.text("OVERLOAD IN " + remain + "s", 28, 82);
    } else if (overloadLevel > 0.02) {
      p.text("CLUTTER " + Math.round(overloadLevel * 100) + "%", 28, 82);
    }

    // Seeds + Weather (top-right)
    drawPanel(p.width - 14 - 360, 14, 360, 112);

    p.noStroke();
    p.fill(255);
    p.textAlign(p.LEFT, p.TOP);
    p.textSize(16);
    p.text("SEEDS", p.width - 14 - 360 + 16, 22);

    p.textAlign(p.RIGHT, p.TOP);
    p.textSize(28);
    p.text(seedCount, p.width - 28, 16);

    // seed icon (pouch + sprout)
    const pos = seedIconPos();
    p.push();
    p.translate(pos.x, pos.y);

    p.noStroke();
    p.fill(90, 65, 40);
    p.ellipse(0, 4, 26, 28);

    p.fill(70, 50, 30);
    p.arc(0, -2, 26, 18, p.PI, 0);

    p.stroke(70, 140, 90);
    p.strokeWeight(3);
    p.line(0, -6, 0, -18);

    p.noStroke();
    p.fill(90, 180, 120);
    p.ellipse(-6, -18, 10, 6);
    p.ellipse(6, -18, 10, 6);

    p.pop();

    // Weather
    p.textAlign(p.LEFT, p.TOP);
    p.textSize(13);
    p.fill(255, 220);
    p.text("WEATHER", p.width - 14 - 360 + 16, 54);

    p.fill(255);
    const modeTag = (weather.mode === "sim") ? " (sim)" : "";
    p.text(weather.desc + modeTag, p.width - 14 - 360 + 16, 72);

    // NZ time
    const hh = Math.floor(nz.minutes / 60);
    const mm = Math.floor(nz.minutes % 60);
    const mmStr = (mm < 10) ? ("0" + mm) : ("" + mm);
    p.fill(255, 190);
    p.text("NZ " + hh + ":" + mmStr, p.width - 14 - 360 + 16, 92);
  }

  function drawDraggedSeed() {
    p.push();
    p.translate(seedDrag.x, seedDrag.y);

    p.noStroke();
    p.fill(90, 65, 40);
    p.ellipse(0, 6, 30, 32);

    p.fill(70, 50, 30);
    p.arc(0, 0, 30, 20, p.PI, 0);

    p.stroke(70, 140, 90);
    p.strokeWeight(3);
    p.line(0, -2, 0, -18);

    p.noStroke();
    p.fill(90, 180, 120);
    p.ellipse(-6, -18, 10, 6);
    p.ellipse(6, -18, 10, 6);

    p.pop();
  }

  // ----------------------------
  // SETUP
  // ----------------------------
  p.setup = function () {
    const cnv = p.createCanvas(p.windowWidth - 40, p.windowHeight - 40);
    const container = document.getElementById("canvas-container");
    if (container) cnv.parent(container);

    creature = createCreature(p.width / 2, p.height / 2);

    updateNZTime();

    initCorruption();
    loadState();

    // if corruption loaded with different dims, resample to current
    const targetW = Math.max(1, Math.ceil(p.width / CORR_CELL));
    const targetH = Math.max(1, Math.ceil(groundY() / CORR_CELL));
    if (corr && (corrW !== targetW || corrH !== targetH)) {
      const old = corr;
      const oldW = corrW, oldH = corrH;
      initCorruption();
      corr = resampleCorr(old, oldW, oldH, corrW, corrH);
      corrNext = new Uint8Array(corrW * corrH);
    }

    creature.x = p.constrain(creature.x, 80, p.width - 80);
    creature.y = p.constrain(creature.y, 80, groundY() - 40);
    creature.targetX = p.constrain(creature.targetX, 80, p.width - 80);
    creature.targetY = p.constrain(creature.targetY, 80, groundY() - 40);

    enterIdle();

    applySimWeather();
    updateWeather();
  };

  // ----------------------------
  // DRAW LOOP
  // ----------------------------
  p.draw = function () {
    const dt = p.deltaTime / 1000;
    chaosTime += 0.01;

    updateNZTime();
    updateWeather();
    if (weather.mode === "sim") applySimWeather();

    drawSky();
    updateAndDrawWeatherFX(dt);

    // Hunger changes
    let rate = HUNGER_PER_SEC;
    rate *= p.lerp(0.72, 1.0, nz.daylight);
    if (dragging) rate += DRAG_HUNGER_PER_SEC;
    if (isStormy()) rate *= 1.08;

    if (respawning) {
      hunger = 0;
    } else {
      hunger = p.constrain(hunger + rate * dt, 0, 100);
    }

    // ---- OVERLOAD TIMELINE ----
    if (!respawning) {
      if (hunger >= 100) {
        overloadTimer += dt;
      } else {
        overloadTimer = Math.max(0, overloadTimer - dt * 2.2);
      }

      overloadLevel = p.constrain(overloadTimer / OVERLOAD_SECONDS, 0, 1);

      if (overloadLevel > 0.001) {
        const spawnPerSec = p.lerp(10, 220, overloadLevel);
        spawnClutter(Math.floor(spawnPerSec * dt));
      }

      if (overloadTimer >= OVERLOAD_SECONDS) {
        explodeAndRespawn();
      }
    } else {
      overloadTimer = 0;
      overloadLevel = 0;
    }

    // corruption + roots update
    updateCorruption(dt);
    updateRoots(dt);
    drawCorruptionOverlay();

    if (!dragging && !draggingSeed && !respawning) updateState();

    updateFlowers(dt);
    updateParticles();
    updateClutter(dt);

    drawGrass();
    drawRoots();   // roots on top of ground
    drawFlowers();

    if (!respawning) drawCreature(creature);

    drawParticles();

    if (!respawning && overloadLevel > 0.01) drawClutter();

    drawHUD();
    if (draggingSeed) drawDraggedSeed();

    // Respawn countdown
    if (respawning) {
      respawnT -= dt;
      if (respawnT <= 0) respawnCreature();
    }

    if (p.frameCount % 120 === 0) saveState();
  };

  // ----------------------------
  // INTERACTION
  // ----------------------------
  p.mousePressed = function () {
    const pos = seedIconPos();

    if (seedCount > 0 && p.dist(p.mouseX, p.mouseY, pos.x, pos.y) < 28) {
      draggingSeed = true;
      seedDrag.x = p.mouseX;
      seedDrag.y = p.mouseY;
      return;
    }

    if (!respawning && p.dist(p.mouseX, p.mouseY, creature.x, creature.y) < PICK_RADIUS) {
      dragging = true;
      dragOffsetX = creature.x - p.mouseX;
      dragOffsetY = creature.y - p.mouseY;
      return;
    }

    if (!respawning && !draggingSeed && !dragging) {
      setClickTarget(p.mouseX, p.mouseY);
    }
  };

  p.mouseDragged = function () {
    if (draggingSeed) {
      seedDrag.x = p.mouseX;
      seedDrag.y = p.mouseY;
    }

    if (dragging && !respawning) {
      creature.x = p.mouseX + dragOffsetX;
      creature.y = p.mouseY + dragOffsetY;
      creature.y = p.constrain(creature.y, 60, groundY() - 20);

      creature.targetX = creature.x;
      creature.targetY = creature.y;
    }
  };

  p.mouseReleased = function () {
    if (draggingSeed) {
      let used = false;

      // feed chicken
      if (!respawning && p.dist(p.mouseX, p.mouseY, creature.x, creature.y) < 120) {
        hunger = Math.max(0, hunger - FEED_AMOUNT);

        // feeding purifies corruption + kills roots near chicken
        purifyCorr(creature.x, creature.y - 10, CORR_PURIFY_RADIUS, 255);
        purgeRoots(creature.x, creature.y - 10, CORR_PURIFY_RADIUS);

        used = true;
      }
      // plant on ground
      else if (p.mouseY >= groundY() - 5) {
        plantSeed(p.constrain(p.mouseX, 20, p.width - 20));
        used = true;
      }

      if (used) {
        seedCount = Math.max(0, seedCount - 1);
        saveState();
      }

      draggingSeed = false;
      if (!respawning) enterIdle();
    }

    dragging = false;
  };

  p.windowResized = function () {
    const oldCorr = corr;
    const oldW = corrW;
    const oldH = corrH;

    p.resizeCanvas(p.windowWidth - 40, p.windowHeight - 40);

    for (const f of flowers) f.y = groundY();
    if (creature) creature.y = p.constrain(creature.y, 80, groundY() - 40);

    initCorruption();
    if (oldCorr) {
      corr = resampleCorr(oldCorr, oldW, oldH, corrW, corrH);
      corrNext = new Uint8Array(corrW * corrH);
    }

    if (creature) {
      creature.targetX = p.constrain(creature.targetX, 80, p.width - 80);
      creature.targetY = p.constrain(creature.targetY, 80, groundY() - 40);
    }

    saveState();
  };

}, document.body);