
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
  // Lower Hutt / Wellington region approx coords
  const NZ_LAT = -41.21;
  const NZ_LON = 174.90;
  const WEATHER_REFRESH_MS = 10 * 60 * 1000;

  const STORAGE_KEY = "mddn242_familiar_state_v8";

  const GROUND_H = 60;
  const PICK_RADIUS = 140;

  const HUNGER_PER_SEC = 1.2;
  const DRAG_HUNGER_PER_SEC = 2.6;
  const FEED_AMOUNT = 25;

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
  // BASIC HELPERS
  // ----------------------------
  function groundY() { return p.height - GROUND_H; }
  function createCreature(x, y) { return { x, y, targetX: x, facing: 1 }; }

  // ----------------------------
  // PERSISTENCE
  // ----------------------------
  function saveState() {
    try {
      const data = {
        t: Date.now(),
        hunger,
        seedCount,
        creature: { x: creature.x, y: creature.y, targetX: creature.targetX, facing: creature.facing },
        flowers: flowers.map(f => ({ x: f.x, t: f.t, growRate: f.growRate, wob: f.wob }))
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

      if (typeof data.t === "number") {
        applyOfflineProgress(Date.now() - data.t);
      }

      hunger = p.constrain(hunger, 0, 100);
      seedCount = Math.max(0, seedCount);

    } catch (e) { /* ignore */ }
  }

  // ----------------------------
  // NZ TIME (Pacific/Auckland)
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
      // Fallback to local time if Intl timezone not available
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
  // WEATHER (live if possible, else sim)
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
    return [51,53,55,61,63,65,80,81,82,95,96,99].includes(weather.code);
  }
  function isFoggy() {
    return weather.code === 45 || weather.code === 48;
  }
  function isStormy() {
    return [95,96,99].includes(weather.code);
  }

  function applySimWeather() {
    // Deterministic simulated “NZ-like” weather using NZ time + month
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
    // If running from file://, many browsers block fetch → always sim
    const proto = window.location.protocol;
    if (proto !== "http:" && proto !== "https:") {
      applySimWeather();
      return;
    }

    // live fetch periodically
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

    const nightBoost = nz.isNight ? 1.25 : 1.0;
    const minT = p.map(hunger, 0, 100, 150, 70) * nightBoost;
    const maxT = p.map(hunger, 0, 100, 330, 170) * nightBoost;
    targetTimer = p.int(p.random(minT, maxT));
  }

  function enterWalking() {
    state = "walking";
    stateTimer = 0;

    const nightBoost = nz.isNight ? 1.15 : 1.0;
    const minT = p.map(hunger, 0, 100, 240, 130) * nightBoost;
    const maxT = p.map(hunger, 0, 100, 460, 250) * nightBoost;
    targetTimer = p.int(p.random(minT, maxT));

    creature.targetX = p.random(150, p.width - 150);
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

      const baseLegSpeed = p.map(hunger, 0, 100, 0.10, 0.17);
      legPhase += baseLegSpeed * nightSlow;

      if (stateTimer > targetTimer) enterIdle();
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
  // SCENE DRAW (Sky / Weather / Ground)
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

    // stars at night
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
    let grassCol = p.lerpColor(p.color(55, 95, 70), p.color(90, 150, 80), d);
    if (isRainy()) grassCol = p.lerpColor(grassCol, p.color(55, 140, 90), 0.25);

    for (let x = 0; x < p.width; x += 8) {
      const bladeH = 20 + p.noise(x * 0.02, chaosTime * 0.6) * 30;
      const sway = p.noise(x * 0.01, chaosTime * 0.8) * 12 - 6;

      p.fill(grassCol);
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
      growRate: p.random(0.06, 0.11), // ~9–16 sec
      wob: p.random(1000)
    });
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
  // CHAOS BODY SHAPES (your original look)
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
  // CREATURE
  // ----------------------------
  function drawCreature(c) {
    let chaos = p.map(hunger, 45, 100, 0, 1);
    chaos = p.constrain(chaos, 0, 1);

    const jitterX = (p.noise(chaosTime, 0) - 0.5) * chaos * 12;
    const jitterY = (p.noise(0, chaosTime) - 0.5) * chaos * 12;

    p.push();
    p.translate(c.x + jitterX, c.y + jitterY);
    p.scale(c.facing, 1);

    // BODY
    p.noStroke();
    p.fill(220, 170, 80);
    chaosEllipse(0, 20, 220, 160, chaos);

    p.fill(235, 195, 120);
    chaosEllipse(-20, 30, 160, 120, chaos);

    // TAIL
    p.fill(210, 160, 90);
    chaosEllipse(-120, -10, 90, 80, chaos);
    chaosEllipse(-110, -40, 70, 60, chaos);
    chaosEllipse(-90, -60, 50, 40, chaos);

    // HEAD
    const peckAmt = (state === "pecking") ? p.constrain(p.sin(peckPhase), 0, 1) : 0;

    p.push();
    p.translate(95 + peckAmt * 16, -40);
    p.rotate(p.radians(peckAmt * (18 + chaos * 30)));
    p.translate(0, peckAmt * (24 + chaos * 20));

    p.fill(220, 170, 80);
    chaosEllipse(0, 0, 80, 70, chaos);

    p.fill(200, 40, 40);
    p.triangle(0, -25, -15, -45, 15, -45);

    p.fill(245, 200, 60);
    p.triangle(35, 0, 70, 8, 35, 15);

    p.fill(0);
    p.circle(5, -5, 6);
    p.pop();

    // LEGS
    p.stroke(200, 170, 60);
    p.strokeWeight(4);

    const swing = (state === "walking") ? p.sin(legPhase) * 0.5 : 0;
    const legJitter = chaos * 2;

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

    // GLITCH LINES
    if (chaos > 0.5) {
      p.stroke(0, 40);
      for (let i = 0; i < chaos * 10; i++) {
        p.line(p.random(-140, 140), p.random(-80, 120), p.random(-140, 140), p.random(-80, 120));
      }
    }

    p.pop();
  }

  // ----------------------------
  // HUD (BIGGER / CLEARER)
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
  // moved left so it never overlaps the number
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

// seed icon (clickable) – redesigned
const pos = seedIconPos();
p.push();
p.translate(pos.x, pos.y);

// seed pouch
p.noStroke();
p.fill(90, 65, 40);
p.ellipse(0, 4, 26, 28);

// pouch flap
p.fill(70, 50, 30);
p.arc(0, -2, 26, 18, p.PI, 0);

// sprout stem
p.stroke(70, 140, 90);
p.strokeWeight(3);
p.line(0, -6, 0, -18);

// sprout leaves
p.noStroke();
p.fill(90, 180, 120);
p.ellipse(-6, -18, 10, 6);
p.ellipse(6, -18, 10, 6);

p.pop();

    // Weather line
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

  // pouch
  p.noStroke();
  p.fill(90, 65, 40);
  p.ellipse(0, 6, 30, 32);

  // flap
  p.fill(70, 50, 30);
  p.arc(0, 0, 30, 20, p.PI, 0);

  // sprout
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
    loadState();

    // keep inside bounds
    creature.x = p.constrain(creature.x, 80, p.width - 80);
    creature.y = p.constrain(creature.y, 80, groundY() - 40);

    enterIdle();

    // initial weather
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

    // Background
    drawSky();

    // Weather FX behind scene
    updateAndDrawWeatherFX(dt);

    // Hunger changes over time, including with drag & with night/weather effects
    let rate = HUNGER_PER_SEC;
    rate *= p.lerp(0.72, 1.0, nz.daylight); // slower at night
    if (dragging) rate += DRAG_HUNGER_PER_SEC;
    if (isStormy()) rate *= 1.08;

    hunger = p.constrain(hunger + rate * dt, 0, 100);

    if (!dragging && !draggingSeed) updateState();

    updateFlowers(dt);
    updateParticles();

    drawGrass();
    drawFlowers();
    drawCreature(creature);
    drawParticles();

    drawHUD();
    if (draggingSeed) drawDraggedSeed();

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

    if (p.dist(p.mouseX, p.mouseY, creature.x, creature.y) < PICK_RADIUS) {
      dragging = true;
      dragOffsetX = creature.x - p.mouseX;
      dragOffsetY = creature.y - p.mouseY;
    }
  };

  p.mouseDragged = function () {
    if (draggingSeed) {
      seedDrag.x = p.mouseX;
      seedDrag.y = p.mouseY;
    }

    if (dragging) {
      creature.x = p.mouseX + dragOffsetX;
      creature.y = p.mouseY + dragOffsetY;
      creature.y = p.constrain(creature.y, 60, groundY() - 20);
    }
  };

  p.mouseReleased = function () {
    if (draggingSeed) {
      let used = false;

      // feed chicken
      if (p.dist(p.mouseX, p.mouseY, creature.x, creature.y) < 120) {
        hunger = Math.max(0, hunger - FEED_AMOUNT);
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
      enterIdle();
    }

    dragging = false;
  };

  p.windowResized = function () {
    p.resizeCanvas(p.windowWidth - 40, p.windowHeight - 40);
    for (const f of flowers) f.y = groundY();
    creature.y = p.constrain(creature.y, 80, groundY() - 40);
    saveState();
  };

}, document.body);