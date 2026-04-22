// ============================================================
//  YOUR CREATURE  —  sketch.js
//  MDDN242 Project 2
// ============================================================
//
//  QUICK START
//  1. Edit drawBody() to redesign the shape
//  2. Edit drawEyes() — or remove the call to drop eyes entirely
//  3. Add a new state in STATES + one line in getState()
//  4. Tune the SETTINGS constants at the top
//  5. Rename "need" to match your concept (hunger, loneliness…)
//
// ============================================================

new p5(function(p) {

    // ============================================================
    //  SETTINGS  —  tweak these, or use the sidebar sliders
    // ============================================================

    const SHOW_UI      = true;   // set false to hide the sidebar while designing

    let CREATURE_SIZE  = 210;    // body diameter in pixels
    let DECAY_RATE     = 0.003;  // need rise per frame while tab is focused
    let AWAY_RATE      = 0.020;  // need rise per frame while tab is hidden
    let AFK_PER_HOUR   = 5;      // extra need added per hour since last visit
    let AFK_MAX_HOURS  = 168;    // cap time-away at 7 days
    let CLICK_FEED     = 20;     // how much a click reduces need
    let MIC_THRESHOLD  = 0.15;   // how loud is "loud" (0–1)
    let EXCITED_FRAMES = 40;     // how long the excited state lasts
    let BOUNCE_SCALE   = 1.0;    // multiplier for all bounce amounts

    // Colours — also editable via sidebar colour pickers
    let bgColour   = [220, 242, 210];  // background (r, g, b)
    let bodyColour = [139,  0,  0];   // body fill  (r, g, b)


    // ============================================================
    //  STATE MACHINE
    //
    //  Each state is a row of visual/behaviour targets.
    //  Add a new state here, then add one condition in getState().
    // ============================================================

    const STATES = {
        //            bounce      shake     opacity
        happy:      { bounceAmt: 0.04, shakeAmt: 0.0, alphaTarget: 255 },
        neutral:    { bounceAmt: 0.02, shakeAmt: 0.0, alphaTarget: 180 },
        distressed: { bounceAmt: 0.01, shakeAmt: 1.5, alphaTarget: 127 },
        excited:    { bounceAmt: 0.10, shakeAmt: 0.0, alphaTarget: 255 },
    };

    const STATE_DESCRIPTIONS = {
        happy:      'need is low — bouncy, fully visible',
        neutral:    'need is rising — slightly transparent',
        distressed: 'need is high — shaking, 50% transparent',
        excited:    'heard a sound! — big pupils, roaming',
    };

    // First match wins — checked top to bottom every frame.
    function getState(c) {
        if (c.exciteTimer > 0) return 'excited';
        if (c.need <= 30)      return 'happy';
        if (c.need <= 70)      return 'neutral';
        return 'distressed';
    }


    // ============================================================
    //  CREATURE FACTORY
    // ============================================================

    function createCreature(x, y) {
        return {
            x, y,
            need:  50,
            state: 'neutral',
            bounceAmt: 0.02,
            bodyAlpha: 255,
            originX: x, originY: y,
            wanderX: 0, wanderY: 0,
            wanderTargetX: 0, wanderTargetY: 0,
            wanderChangeTimer: 0,
            exciteTimer: 0,
            orbitAngle:  0,
            breathe: 0,
            bob:     0,
            hour:    new Date().getHours(),
            isWatched: true,
            micLevel:  0,
            lastVisit:   null,
            totalVisits: 0,
        };
    }

    let creature;
    let micAnalyser = null;
    let micActive   = false;
    let micData     = null;   // reused buffer — allocated once when mic starts

    // Cached DOM refs — populated in setup, never queried again
    let ui = {};


    // ============================================================
    //  SETUP
    // ============================================================

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function canvasSize() {
        if (isMobile()) {
            return { w: window.innerWidth, h: window.innerHeight };
        }
        return {
            w: SHOW_UI ? p.windowWidth - 360 : p.windowWidth - 40,
            h: p.windowHeight - 40,
        };
    }

    p.setup = function() {
        let sz  = canvasSize();
        let cnv = p.createCanvas(sz.w, sz.h);
        cnv.parent('canvas-container');
        cnv.mousePressed(onCanvasClick);

        creature = createCreature(p.width / 2, p.height / 2);
        loadState(creature);

        if (!SHOW_UI) document.querySelector('.sidebar').style.display = 'none';

        // Cache sidebar DOM refs once — no per-frame getElementById calls
        ui.hour    = document.getElementById('ui-hour');
        ui.period  = document.getElementById('ui-period');
        ui.state   = document.getElementById('ui-state');
        ui.desc    = document.getElementById('ui-desc');
        ui.needVal = document.getElementById('ui-need-val');
        ui.needBar = document.getElementById('ui-need-bar');
        ui.visits  = document.getElementById('ui-visits');
        ui.excited = document.getElementById('ui-excited');
        ui.watched = document.getElementById('ui-watched');
        ui.mic     = document.getElementById('ui-mic');

        // Track focus via events — no polling in the draw loop
        window.addEventListener('focus', () => { creature.isWatched = true; });
        window.addEventListener('blur',  () => { creature.isWatched = false; });

        setInterval(() => { saveState(creature); creature.hour = new Date().getHours(); }, 30000);
        window.addEventListener('beforeunload', () => saveState(creature));
    };


    // ============================================================
    //  DRAW LOOP
    // ============================================================

    p.draw = function() {
        p.background(...bgColour);

        updateMic(creature);
        updateCreature(creature);
        drawCreature(creature);

        if (p.frameCount % 6 === 0) updateSidebar(creature); // ~10fps is plenty for UI
    };


    // ============================================================
    //  CREATURE LOGIC
    // ============================================================

    function updateCreature(c) {
        // Need rises over time
        let rate = c.isWatched ? DECAY_RATE : AWAY_RATE;
        c.need = p.constrain(c.need + rate, 0, 100);

        // State machine
        c.state = getState(c);
        let s = STATES[c.state];
        c.bounceAmt = p.lerp(c.bounceAmt, s.bounceAmt * BOUNCE_SCALE, 0.08);
        c.bodyAlpha = p.lerp(c.bodyAlpha, s.alphaTarget, 0.05);

        // Animation phases
        c.breathe += 0.018;
        c.bob     += 0.012;

        // Excited: chase mouse (orbit when close), or wander if mouse is off canvas.
        // Calm: drift back to origin.
        if (c.exciteTimer > 0) {
            c.exciteTimer--;
            let mouseOnCanvas = p.mouseX >= 0 && p.mouseX <= p.width &&
                                p.mouseY >= 0 && p.mouseY <= p.height;
            if (mouseOnCanvas) {
                const ORBIT_RADIUS = CREATURE_SIZE * 0.55;
                let distToMouse = p.dist(c.x, c.y, p.mouseX, p.mouseY);
                if (distToMouse > ORBIT_RADIUS * 1.5) {
                    c.wanderTargetX = p.mouseX - c.originX;
                    c.wanderTargetY = p.mouseY - c.originY;
                } else {
                    c.orbitAngle   += 0.025;
                    c.wanderTargetX = (p.mouseX - c.originX) + Math.cos(c.orbitAngle) * ORBIT_RADIUS;
                    c.wanderTargetY = (p.mouseY - c.originY) + Math.sin(c.orbitAngle) * ORBIT_RADIUS;
                }
            } else {
                c.wanderChangeTimer--;
                if (c.wanderChangeTimer <= 0) {
                    let pad = CREATURE_SIZE * 0.6;
                    c.wanderTargetX = p.random(pad, p.width  - pad) - c.originX;
                    c.wanderTargetY = p.random(pad, p.height - pad) - c.originY;
                    c.wanderChangeTimer = p.floor(p.random(30, 70));
                }
            }
        } else {
            c.wanderTargetX = 0;
            c.wanderTargetY = 0;
        }

        c.wanderX = p.lerp(c.wanderX, c.wanderTargetX, 0.04);
        c.wanderY = p.lerp(c.wanderY, c.wanderTargetY, 0.04);
        c.x = c.originX + c.wanderX;
        c.y = c.originY + c.wanderY;
    }


    // ============================================================
    //  DRAWING
    // ============================================================

    function drawCreature(c) {
        p.push();
        p.translate(c.x, c.y);
        p.translate(0, p.sin(c.bob) * 6);

        let s = STATES[c.state];
        let bScale = 1 + p.sin(c.breathe) * c.bounceAmt;

        if (s.shakeAmt > 0) {
            p.translate(
                p.random(-s.shakeAmt, s.shakeAmt),
                p.random(-s.shakeAmt * 0.4, s.shakeAmt * 0.4)
            );
        }

        p.scale(bScale);
        drawBody(c);
        drawEyes(c);
        drawFace(c);
        p.pop();
    }
function drawFace(c) {

    // Convert need (0–100) into happiness (happy → sad)
    let happiness = p.map(c.need, 0, 100, 1, -1);
    happiness = p.constrain(happiness, -1, 1);

    // Mouth positioning
    let mouthY     = CREATURE_SIZE * 0.18;
    let mouthWidth = CREATURE_SIZE * 0.30;
    let mouthCurve = CREATURE_SIZE * 0.18 * happiness;

    // Extra smile when excited
    if (c.state === 'excited') {
        mouthCurve *= 1.6;
    }

    // Draw mouth
    p.noFill();
    p.stroke(20, c.bodyAlpha);
    p.strokeWeight(4);
    p.strokeCap(p.ROUND);

    p.beginShape();
    p.vertex(-mouthWidth / 2, mouthY);
    p.quadraticVertex(0, mouthY + mouthCurve, mouthWidth / 2, mouthY);
    p.endShape();

    p.noStroke();
}
``

    // ── EDIT THIS — redesign the creature's body ──────────────

    function drawBody(c) {
        p.noStroke();
        p.fill(...bodyColour, c.bodyAlpha);
        p.ellipse(0, 0, CREATURE_SIZE, CREATURE_SIZE);
    }


    // ── EDIT THIS — or remove the call from drawCreature() ────

    function drawEyes(c) {
        let eyeSize    = CREATURE_SIZE * 0.55;
        let eyeSpacing = CREATURE_SIZE * 0.16;
        let eyeY       = -CREATURE_SIZE * 0.16;

        let pupilSize = c.state === 'excited' ? eyeSize * 0.38 : eyeSize * 0.30;

        let angle     = p.atan2(p.mouseY - c.y, p.mouseX - c.x);
        let mouseDist = p.dist(p.mouseX, p.mouseY, c.x, c.y);
        let move      = p.min(eyeSize * 0.18, mouseDist * 0.012);
        let px2       = p.cos(angle) * move;
        let py2       = p.sin(angle) * move;

        for (let side of [-1, 1]) {
            let ex = eyeSpacing * side;
            let ey = eyeY;
            p.noStroke();
            p.fill(255);
            p.ellipse(ex, ey, eyeSize * 0.5, eyeSize * 0.5);
            p.ellipse(ex * 2, ey * 2, eyeSize * 0.5, eyeSize * 0.5);
            p.ellipse(ex * 2, ey / 8, eyeSize * 0.5, eyeSize * 0.5);
            p.fill(20);
            p.ellipse(ex + px2, ey + py2, pupilSize, pupilSize);
            p.ellipse(ex * 2 + px2, ey * 2 + py2, pupilSize, pupilSize);
            p.ellipse(ex * 2 + px2, ey / 8 + py2, pupilSize, pupilSize);
            
        }
        p.noStroke();
    }


    // ============================================================
    //  INPUT: MOUSE CLICK
    // ============================================================

    function onCanvasClick() {
        if (!micActive) startMic();
        let d = p.dist(p.mouseX, p.mouseY, creature.x, creature.y);
        if (d < CREATURE_SIZE / 2) {
            creature.need = p.max(0, creature.need - CLICK_FEED);
        }
    }


    // ============================================================
    //  INPUT: MICROPHONE
    // ============================================================

    async function startMic() {
        try {
            let stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            let ctx    = new (window.AudioContext || window.webkitAudioContext)();
            let source = ctx.createMediaStreamSource(stream);
            micAnalyser = ctx.createAnalyser();
            micAnalyser.fftSize = 256;
            source.connect(micAnalyser);
            micData   = new Uint8Array(micAnalyser.frequencyBinCount);
            micActive = true;
        } catch(e) {
            console.log('Mic unavailable:', e);
        }
    }

    function getMicLevel() {
        if (!micAnalyser) return 0;
        micAnalyser.getByteFrequencyData(micData);
        let sum = 0;
        for (let i = 0; i < micData.length; i++) sum += micData[i];
        return sum / (micData.length * 255);
    }

    function updateMic(c) {
        if (!micActive) return;
        c.micLevel = getMicLevel();
        if (c.micLevel > MIC_THRESHOLD) c.exciteTimer = EXCITED_FRAMES;
    }



    // ============================================================
    //  PERSISTENCE
    // ============================================================

    function saveState(c) {
        try {
            localStorage.setItem('creature_v2', JSON.stringify({
                need: c.need, lastVisit: Date.now(), totalVisits: c.totalVisits,
            }));
        } catch(e) {}
    }

    function loadState(c) {
        try {
            let raw = localStorage.getItem('creature_v2');
            if (!raw) { c.totalVisits = 1; return; }
            let data = JSON.parse(raw);
            c.need        = data.need || 50;
            c.lastVisit   = data.lastVisit;
            c.totalVisits = (data.totalVisits || 0) + 1;
            if (c.lastVisit) {
                let hours = Math.min((Date.now() - c.lastVisit) / 3600000, AFK_MAX_HOURS);
                c.need = Math.min(c.need + hours * AFK_PER_HOUR, 100);
            }
        } catch(e) {
            c.totalVisits = 1;
        }
    }


    // ============================================================
    //  SIDEBAR SYNC  —  updates the live state panel each frame
    // ============================================================

    function updateSidebar(c) {
        ui.hour.textContent    = c.hour % 12 || 12;
        ui.period.textContent  = c.hour < 12 ? 'am' : 'pm';
        ui.state.textContent   = c.state;
        ui.desc.textContent    = STATE_DESCRIPTIONS[c.state] || '';
        ui.needVal.textContent = Math.floor(c.need);
        ui.visits.textContent  = c.totalVisits;
        ui.excited.textContent = c.exciteTimer > 0 ? 'yes!' : 'no';
        ui.watched.textContent = c.isWatched ? 'on' : 'away';
        ui.mic.textContent     = micActive ? c.micLevel.toFixed(2) : '—';

        ui.needBar.style.width = c.need + '%';
        ui.needBar.style.backgroundColor =
            c.need < 30 ? '#788c5d' :
            c.need < 70 ? '#c9973a' : '#c0522a';
    }


    // ============================================================
    //  WINDOW RESIZE
    // ============================================================

    p.windowResized = function() {
        let sz = canvasSize();
        p.resizeCanvas(sz.w, sz.h);
        creature.originX = p.width / 2;
        creature.originY = p.height / 2;
    };


    // ============================================================
    //  SIDEBAR CONTROLS  —  exposed to button onclick handlers
    // ============================================================

    window._resetNeed = () => { if (creature) creature.need = 0; };
    window._maxNeed   = () => { if (creature) creature.need = 100; };
    window._setDecay  = v => { DECAY_RATE = v; };
    window._setFeed   = v => { CLICK_FEED = v; };

}, document.body);
